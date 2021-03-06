'use strict';

const ms = require('ms');
const RedLock = require('redlock');
const createDebug = require('debug');
const { EmptyPlaylistError } = require('../errors');
const routes = require('../routes/booth');

/**
 * @typedef {import('../models').User} User
 * @typedef {import('../models').Playlist} Playlist
 * @typedef {import('../models').PlaylistItem} PlaylistItem
 * @typedef {import('../models').HistoryEntry} HistoryEntry
 * @typedef {{ user: User }} PopulateUser
 * @typedef {{ playlist: Playlist }} PopulatePlaylist
 * @typedef {{ item: PlaylistItem }} PopulatePlaylistItem
 * @typedef {HistoryEntry & PopulateUser & PopulatePlaylist & PopulatePlaylistItem}
 *     PopulatedHistoryEntry
 */

const debug = createDebug('uwave:advance');

/**
 * @param {Playlist} playlist
 * @returns {Promise<void>}
 */
async function cyclePlaylist(playlist) {
  const item = playlist.media.shift();
  if (item !== undefined) {
    playlist.media.push(item);
  }
  await playlist.save();
}

class Booth {
  /** @type {ReturnType<typeof setTimeout>|null} */
  #timeout = null;

  #locker;

  /**
   * @param {import('../Uwave')} uw
   */
  constructor(uw) {
    this.uw = uw;
    this.#locker = new RedLock([this.uw.redis]);
  }

  async onStart() {
    const current = await this.getCurrentEntry();
    if (current && this.#timeout === null) {
      // Restart the advance timer after a server restart, if a track was
      // playing before the server restarted.
      const duration = (current.media.end - current.media.start) * ms('1 second');
      const endTime = Number(current.playedAt) + duration;
      if (endTime > Date.now()) {
        this.#timeout = setTimeout(
          () => this.advance(),
          endTime - Date.now(),
        );
      } else {
        this.advance();
      }
    }
  }

  onStop() {
    this.maybeStop();
  }

  /**
   * @returns {Promise<HistoryEntry | null>}
   */
  async getCurrentEntry() {
    const { HistoryEntry } = this.uw.models;
    const historyID = await this.uw.redis.get('booth:historyID');
    if (!historyID) {
      return null;
    }

    return HistoryEntry.findById(historyID);
  }

  async getCurrentVoteStats() {
    const { redis } = this.uw;

    const results = await redis.pipeline()
      .smembers('booth:upvotes')
      .smembers('booth:downvotes')
      .smembers('booth:favorites')
      .exec();

    // TODO what if there is an error?
    const voteStats = {
      upvotes: results[0][1],
      downvotes: results[1][1],
      favorites: results[2][1],
    };

    return voteStats;
  }

  /**
   * @param {HistoryEntry} entry
   * @private
   */
  async saveStats(entry) {
    const stats = await this.getCurrentVoteStats();

    Object.assign(entry, stats);
    return entry.save();
  }

  /**
   * @param {{ remove?: boolean }} options
   * @returns {Promise<User|null>}
   * @private
   */
  async getNextDJ(options) {
    const { User } = this.uw.models;
    /** @type {string|null} */
    let userID = await this.uw.redis.lindex('waitlist', 0);
    if (!userID && !options.remove) {
      // If the waitlist is empty, the current DJ will play again immediately.
      userID = await this.uw.redis.get('booth:currentDJ');
    }
    if (!userID) {
      return null;
    }

    return User.findById(userID);
  }

  /**
   * @param {{ remove?: boolean }} options
   * @returns {Promise<PopulatedHistoryEntry | null>}
   * @private
   */
  async getNextEntry(options) {
    const { HistoryEntry, PlaylistItem } = this.uw.models;
    const { playlists } = this.uw;

    const user = await this.getNextDJ(options);
    if (!user || !user.activePlaylist) {
      return null;
    }
    const playlist = await playlists.getUserPlaylist(user, user.activePlaylist);
    if (playlist.size === 0) {
      throw new EmptyPlaylistError();
    }

    const playlistItem = await PlaylistItem.findById(playlist.media[0]);
    await playlistItem.populate('media').execPopulate();

    // @ts-ignore
    return new HistoryEntry({
      user,
      playlist,
      item: playlistItem,
      media: {
        media: playlistItem.media,
        artist: playlistItem.artist,
        title: playlistItem.title,
        start: playlistItem.start,
        end: playlistItem.end,
      },
    });
  }

  /**
   * @param {HistoryEntry|null} previous
   * @param {{ remove?: boolean }} options
   * @private
   */
  async cycleWaitlist(previous, options) {
    const waitlistLen = await this.uw.redis.llen('waitlist');
    if (waitlistLen > 0) {
      await this.uw.redis.lpop('waitlist');
      if (previous && !options.remove) {
        // The previous DJ should only be added to the waitlist again if it was
        // not empty. If it was empty, the previous DJ is already in the booth.
        await this.uw.redis.rpush('waitlist', previous.user.toString());
      }
    }
  }

  clear() {
    return this.uw.redis.del(
      'booth:historyID',
      'booth:currentDJ',
      'booth:upvotes',
      'booth:downvotes',
      'booth:favorites',
    );
  }

  /**
   * @param {PopulatedHistoryEntry} next
   * @private
   */
  update(next) {
    return this.uw.redis.multi()
      .del('booth:upvotes', 'booth:downvotes', 'booth:favorites')
      .set('booth:historyID', next.id)
      .set('booth:currentDJ', next.user.id)
      .exec();
  }

  /**
   * @private
   */
  maybeStop() {
    if (this.#timeout) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }
  }

  /**
   * @param {PopulatedHistoryEntry} entry
   * @private
   */
  play(entry) {
    this.maybeStop();
    this.#timeout = setTimeout(
      () => this.advance(),
      (entry.media.end - entry.media.start) * ms('1 second'),
    );
    return entry;
  }

  /**
   * @private
   */
  getWaitlist() {
    return this.uw.redis.lrange('waitlist', 0, -1);
  }

  /**
   * @param {PopulatedHistoryEntry|null} next
   * @private
   */
  async publish(next) {
    if (next) {
      this.uw.publish('advance:complete', {
        historyID: next.id,
        userID: next.user.id,
        playlistID: next.playlist.id,
        itemID: next.item.id,
        media: {
          ...next.media,
          media: next.media.media.toString(),
        },
        playedAt: next.playedAt.getTime(),
      });
      this.uw.publish('playlist:cycle', {
        userID: next.user.id,
        playlistID: next.playlist.id,
      });
      this.uw.publish('user:play', { userID: next.user.id, artist: next.media.artist, title: next.media.title });
    } else {
      this.uw.publish('advance:complete', null);
    }
    this.uw.publish('waitlist:update', await this.getWaitlist());
  }

  /**
   * @typedef {object} AdvanceOptions
   * @prop {boolean} [remove]
   * @prop {boolean} [publish]
   *
   * @param {AdvanceOptions} [opts]
   * @param {import('redlock').Lock} [reuseLock]
   * @returns {Promise<PopulatedHistoryEntry|null>}
   */
  async advance(opts = {}, reuseLock = undefined) {
    let lock;
    try {
      if (reuseLock) {
        lock = await reuseLock.extend(ms('2 seconds'));
      } else {
        lock = await this.#locker.lock('booth:advancing', ms('2 seconds'));
      }
    } catch (err) {
      throw new Error('Another advance is still in progress.');
    }

    const previous = await this.getCurrentEntry();
    let next;
    try {
      next = await this.getNextEntry(opts);
    } catch (err) {
      // If the next user's playlist was empty, remove them from the waitlist
      // and try advancing again.
      if (err.code === 'PLAYLIST_IS_EMPTY') {
        debug('user has empty playlist, skipping on to the next');
        await this.cycleWaitlist(previous, opts);
        return this.advance({ ...opts, remove: true }, lock);
      }
      throw err;
    }

    if (previous) {
      await this.saveStats(previous);

      debug(
        'previous track:', previous.media.artist, '—', previous.media.title,
        `👍 ${previous.upvotes.length} `
        + `★ ${previous.favorites.length} `
        + `👎 ${previous.downvotes.length}`,
      );
    }

    if (next) {
      await next.save();
    } else {
      this.maybeStop();
    }

    await this.cycleWaitlist(previous, opts);

    if (next) {
      await this.update(next);
      await cyclePlaylist(next.playlist);
      await this.play(next);
    } else {
      await this.clear();
    }

    if (opts.publish !== false) {
      await this.publish(next);
    }

    lock.unlock().catch(() => {
      // Don't really care if this fails, it'll expire in some seconds anyway.
    });

    return next;
  }
}

/**
 * @param {import('../Uwave').Boot} uw
 */
async function boothPlugin(uw) {
  uw.booth = new Booth(uw);
  uw.httpApi.use('/booth', routes());

  uw.after(async (err) => {
    if (!err) {
      await uw.booth.onStart();
    }
  });
  uw.onClose(() => {
    uw.booth.onStop();
  });
}

module.exports = boothPlugin;
module.exports.Booth = Booth;
