'use strict';

const mongoose = require('mongoose');
const { slugify } = require('transliteration');

const { Schema } = mongoose;
const { Types } = mongoose.Schema;

/**
 * @typedef {object} LeanBanned
 * @prop {import('mongodb').ObjectID} moderator
 * @prop {number} duration
 * @prop {Date} [expiresAt]
 * @prop {string} reason
 */

/**
 * @typedef {object} LeanUser
 * @prop {import('mongodb').ObjectID} _id
 * @prop {string} username
 * @prop {string} language
 * @prop {string[]} roles
 * @prop {string} avatar
 * @prop {string} slug
 * @prop {import('mongodb').ObjectID|null} activePlaylist
 * @prop {Date} lastSeenAt
 * @prop {LeanBanned|undefined} banned
 * @prop {string|undefined} pendingActivation
 * @prop {Date} createdAt
 * @prop {Date} updatedAt
 *
 * @typedef {import('mongoose').Document<LeanUser["_id"]> & LeanUser} User
 */

const bannedSchema = new Schema({
  moderator: { type: Types.ObjectId, ref: 'User', index: true },
  duration: { type: Number, required: true },
  expiresAt: { type: Date, required: true, index: true },
  reason: { type: String, default: '' },
});

/**
 * @type {import('mongoose').Schema<User, import('mongoose').Model<User>>}
 */
const userSchema = new Schema({
  username: {
    type: String,
    minlength: [3, 'Usernames have to be at least 3 characters long.'],
    maxlength: [32, 'Usernames can be at most 32 characters long.'],
    match: [/^[^\s]+$/, 'Usernames can\'t contain spaces.'],
    required: true,
    unique: true,
    index: true,
    /** @type {(name: string) => string} */
    set: (name) => name.normalize('NFKC'),
  },
  language: {
    type: String, min: 2, max: 2, default: 'en',
  },
  roles: [{ type: String, ref: 'AclRole' }],
  // Deprecated, `roles` should be used instead.
  // However some clients (*cough* u-wave-web *cough*) haven't updated to the
  // ACL system so they need this key to exist.
  role: { type: Number, min: 0, default: 0 },
  avatar: {
    type: String, min: 0, max: 256, default: '',
  },
  slug: {
    type: String,
    unique: true,
    required: [true, 'Usernames must not consist of punctuation only.'],
    index: true,
  },
  discordId: {
    type: String, unique: true, default: '', index: true,
  },
  activePlaylist: {
    type: Types.ObjectId,
    ref: 'Playlist',
  },
  level: {
    type: Number, min: 0, max: 9001, default: 0,
  },
  exp: {
    type: Number, min: 0, max: 2147483647, default: 0,
  },
  points: {
    type: Number, min: 0, max: 2147483647, default: 0,
  },
  expDispenseCycles: {
    type: Number, min: 0, max: 72, default: 0,
  },
  lastSeenAt: { type: Date, default: Date.now },
  lastExpDispense: { type: Date, default: Date.now },
  exiled: { type: Boolean, default: false },
  banned: bannedSchema,
  pendingActivation: { type: String, required: false },
}, {
  timestamps: true,
  minimize: false,
});

// @ts-ignore TS2769 Not sure how to get this to pick the right overload
userSchema.pre('validate', function preValidate(next) {
  this.slug = slugify(this.username);
  next();
});

module.exports = userSchema;
