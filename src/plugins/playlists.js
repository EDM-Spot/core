import groupBy from 'lodash/groupBy';
import shuffle from 'lodash/shuffle';
import escapeStringRegExp from 'escape-string-regexp';

import NotFoundError from '../errors/NotFoundError';
import Page from '../Page';

function isValidPlaylistItem(item) {
  return typeof item === 'object' &&
    typeof item.sourceType === 'string' &&
    (typeof item.sourceID === 'string' || typeof item.sourceID === 'number');
}

/**
 * Calculate valid start/end times for a playlist item.
 */
function getStartEnd(item, media) {
  let { start, end } = item;
  if (!start || start < 0) {
    start = 0;
  } else if (start > media.duration) {
    start = media.duration;
  }
  if (!end || end > media.duration) {
    end = media.duration;
  } else if (end < start) {
    end = start;
  }
  return { start, end };
}

function toPlaylistItem(itemProps, media) {
  const { artist, title } = itemProps;
  const { start, end } = getStartEnd(itemProps, media);
  return {
    media,
    artist: artist || media.artist,
    title: title || media.title,
    start,
    end
  };
}

export class PlaylistsRepository {
  constructor(uw) {
    this.uw = uw;
  }

  async getPlaylist(id) {
    const Playlist = this.uw.model('Playlist');
    if (id instanceof Playlist) {
      return id;
    }
    const playlist = await Playlist.findById(id);
    if (!playlist) {
      throw new NotFoundError('Playlist not found.');
    }
    return playlist;
  }

  async getUserPlaylist(user, id) {
    const Playlist = this.uw.model('Playlist');
    const userID = typeof user === 'object' ? user.id : user;
    const playlist = await Playlist.findOne({ _id: id, author: userID });
    if (!playlist) {
      throw new NotFoundError('Playlist not found.');
    }
    return playlist;
  }

  async createPlaylist(user, { name }) {
    const Playlist = this.uw.model('Playlist');

    const playlist = await Playlist.create({
      name,
      author: user
    });

    return playlist;
  }

  async getUserPlaylists(user) {
    const Playlist = this.uw.model('Playlist');
    const playlists = await Playlist.where('author').eq(user);
    return playlists;
  }

  async updatePlaylist(playlistOrID, patch = {}) {
    const playlist = await this.getPlaylist(playlistOrID);
    Object.assign(playlist, patch);
    return playlist.save();
  }

  async shufflePlaylist(playlistOrID) {
    const playlist = await this.getPlaylist(playlistOrID);
    playlist.media = shuffle(playlist.media);
    return playlist.save();
  }

  async deletePlaylist(playlistOrID) {
    const playlist = await this.getPlaylist(playlistOrID);

    await playlist.remove();

    return {};
  }

  async getPlaylistItemIDsFiltered(playlist, filter) {
    const PlaylistItem = this.uw.model('PlaylistItem');
    const rx = new RegExp(escapeStringRegExp(filter), 'i');
    const matches = await PlaylistItem.where({
      _id: { $in: playlist.media },
      $or: [{ artist: rx }, { title: rx }]
    }).select('_id');

    const allItemIDs = matches.map(item => item.id);

    // We want this sorted by the original playlist item order, so we can
    // just walk through the original playlist and only keep the items that we
    // need.
    return playlist.media.filter(id => allItemIDs.indexOf(`${id}`) !== -1);
  }

  // eslint-disable-next-line class-methods-use-this
  async getPlaylistItemIDsUnfiltered(playlist) {
    return playlist.media;
  }

  async getPlaylistItem(itemID) {
    const PlaylistItem = this.uw.model('PlaylistItem');

    let item;
    if (itemID instanceof PlaylistItem) {
      item = itemID;
    } else {
      item = await PlaylistItem.findById(itemID);
    }

    if (!item) {
      throw new NotFoundError('Playlist item not found.');
    }

    if (!item.populated('media')) {
      await item.populate('media').execPopulate();
    }

    return item;
  }

  async getPlaylistItems(playlistOrID, filter = null, pagination = null) {
    const PlaylistItem = this.uw.model('PlaylistItem');
    const playlist = await this.getPlaylist(playlistOrID);
    const filteredItemIDs = filter
      ? await this.getPlaylistItemIDsFiltered(playlist, filter)
      : await this.getPlaylistItemIDsUnfiltered(playlist);

    let itemIDs = filteredItemIDs;
    if (pagination) {
      const start = pagination.offset;
      const end = start + pagination.limit;
      itemIDs = itemIDs.slice(start, end);
    }
    const items = itemIDs.length > 0
      ? await PlaylistItem.find()
        .where('_id').in(itemIDs)
        .populate('media')
      : [];

    const results = itemIDs.map(itemID =>
      items.find(item => `${item.id}` === `${itemID}`)
    );

    return new Page(results, {
      pageSize: pagination ? pagination.limit : null,
      filtered: filteredItemIDs.length,
      total: playlist.media.length,

      current: pagination,
      next: pagination ? {
        offset: pagination.offset + pagination.limit,
        limit: pagination.limit
      } : null,
      previous: pagination ? {
        offset: Math.max(pagination.offset - pagination.limit, 0),
        limit: pagination.limit
      } : null
    });
  }

  async getMedia(props) {
    const Media = this.uw.model('Media');

    const { sourceType, sourceID } = props;
    let media = await Media.findOne({ sourceType, sourceID });
    if (!media) {
      const mediaProps = await this.uw.source(sourceType).getOne(sourceID);
      media = await Media.create(mediaProps);
    }
    return media;
  }

  /**
   * Create a playlist item.
   */
  async createItem(props) {
    const PlaylistItem = this.uw.model('PlaylistItem');

    const media = await this.getMedia(props);
    const playlistItem = new PlaylistItem(toPlaylistItem(props, media));

    try {
      await playlistItem.save();
    } catch (e) {
      throw new Error('Could not save playlist items. Please try again later.');
    }

    return playlistItem;
  }

  /**
   * Bulk create playlist items from arbitrary sources.
   */
  async createPlaylistItems(items) {
    const Media = this.uw.model('Media');
    const PlaylistItem = this.uw.model('PlaylistItem');

    if (!items.every(isValidPlaylistItem)) {
      throw new Error('Cannot add a playlist item without a proper media source type and ID.');
    }

    // Group by source so we can retrieve all unknown medias from the source in
    // one call.
    const itemsBySourceType = groupBy(items, 'sourceType');
    const playlistItems = [];
    const promises = Object.keys(itemsBySourceType).map(async (sourceType) => {
      const sourceItems = itemsBySourceType[sourceType];
      const knownMedias = await Media.find({
        sourceType,
        sourceID: { $in: sourceItems.map(item => item.sourceID) }
      });

      const unknownMediaIDs = [];
      sourceItems.forEach((item) => {
        if (!knownMedias.some(media => media.sourceID === String(item.sourceID))) {
          unknownMediaIDs.push(item.sourceID);
        }
      });

      let allMedias = knownMedias;
      if (unknownMediaIDs.length > 0) {
        const unknownMedias = await this.uw.source(sourceType).get(unknownMediaIDs);
        allMedias = allMedias.concat(await Media.create(unknownMedias));
      }

      const itemsWithMedia = sourceItems.map(item => toPlaylistItem(
        item,
        allMedias.find(media => media.sourceID === String(item.sourceID))
      ));
      playlistItems.push(...itemsWithMedia);
    });

    await Promise.all(promises);

    return PlaylistItem.create(playlistItems);
  }

  /**
   * Add items to a playlist.
   */
  async addPlaylistItems(playlistOrID, items, { after = null } = {}) {
    const playlist = await this.getPlaylist(playlistOrID);
    const newItems = await this.createPlaylistItems(items);
    const oldMedia = playlist.media;
    const insertIndex = oldMedia.findIndex(item => `${item}` === after);
    playlist.media = [
      ...oldMedia.slice(0, insertIndex + 1),
      ...newItems,
      ...oldMedia.slice(insertIndex + 1)
    ];

    await playlist.save();

    return {
      added: newItems,
      afterID: after,
      playlistSize: playlist.media.length
    };
  }

  async updatePlaylistItem(itemOrID, patch = {}) {
    const item = await this.getPlaylistItem(itemOrID);

    Object.assign(item, patch);

    return item.save();
  }

  async movePlaylistItems(playlistOrID, itemIDs, { afterID }) {
    const playlist = await this.getPlaylist(playlistOrID);

    // First remove the given items,
    const newMedia = playlist.media.filter(item =>
      itemIDs.indexOf(`${item}`) === -1
    );
    // then reinsert them at their new position.
    const insertIndex = newMedia.findIndex(item => `${item}` === afterID);
    newMedia.splice(insertIndex + 1, 0, ...itemIDs);
    playlist.media = newMedia;

    await playlist.save();

    return {};
  }

  async removePlaylistItems(playlistOrID, itemsOrIDs) {
    const PlaylistItem = this.uw.model('PlaylistItem');
    const playlist = await this.getPlaylist(playlistOrID);

    // Only remove items that are actually in this playlist.
    const stringIDs = itemsOrIDs.map(item => String(item));
    const toRemove = [];
    const toKeep = [];
    playlist.media.forEach((itemID) => {
      if (stringIDs.indexOf(`${itemID}`) !== -1) {
        toRemove.push(itemID);
      } else {
        toKeep.push(itemID);
      }
    });

    playlist.media = toKeep;
    await playlist.save();
    await PlaylistItem.remove({ _id: { $in: toRemove } });

    return {};
  }
}

export default function playlistsPlugin() {
  return (uw) => {
    uw.playlists = new PlaylistsRepository(uw); // eslint-disable-line no-param-reassign
  };
}