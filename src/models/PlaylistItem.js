'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;
const { Types } = mongoose.Schema;

async function playlistItemModel(uw) {
  const schema = new Schema({
    media: {
      type: Types.ObjectId,
      ref: 'Media',
      required: true,
      index: true,
    },
    artist: {
      type: String,
      max: 128,
      required: true,
      index: true,
      set: (artist) => artist.normalize('NFKC'),
    },
    title: {
      type: String,
      max: 128,
      required: true,
      index: true,
      set: (title) => title.normalize('NFKC'),
    },
    start: { type: Number, min: 0, default: 0 },
    end: { type: Number, min: 0, default: 0 },
  }, {
    timestamps: true,
    minimize: false,
  });

  uw.mongo.model('PlaylistItem', schema);
}

module.exports = playlistItemModel;
