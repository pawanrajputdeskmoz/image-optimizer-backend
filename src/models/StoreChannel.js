const mongoose = require("mongoose");

/**
 * BigCommerce storefront channels cached per store.
 * Unique on (store_hash, channel_id) — upsert only, no duplicates.
 */
const StoreChannelSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    store_hash: {
      type: String,
      required: true,
      index: true,
    },
    channel_id: {
      type: Number,
      required: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      default: null,
    },
    type: {
      type: String,
      trim: true,
      default: null,
    },
    platform: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    site_id: {
      type: Number,
      default: null,
    },
    url: {
      type: String,
      trim: true,
      default: null,
    },
    synced_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

StoreChannelSchema.index({ store_hash: 1, channel_id: 1 }, { unique: true });
StoreChannelSchema.index({ store_hash: 1, status: 1 });

module.exports = mongoose.model("StoreChannel", StoreChannelSchema);
