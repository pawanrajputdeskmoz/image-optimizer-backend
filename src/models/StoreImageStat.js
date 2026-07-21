const mongoose = require("mongoose");

const StoreImageStatSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    store_hash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    optimized_images: {
      type: Number,
      default: 0,
    },

    pending_images: {
      type: Number,
      default: 0,
    },

    total_catalog_images: {
      type: Number,
      default: 0,
    },

    last_catalog_sync_at: {
      type: Date,
      default: null,
    },

    filename_updated_images: {
      type: Number,
      default: 0,
    },

    alt_text_updated_images: {
      type: Number,
      default: 0,
    },

    failed_images: {
      type: Number,
      default: 0,
    },

    total_original_size: {
      type: Number,
      default: 0,
    },

    total_optimized_size: {
      type: Number,
      default: 0,
    },

    total_saved_bytes: {
      type: Number,
      default: 0,
    },

    average_saving_percent: {
      type: Number,
      default: 0,
    },

    last_optimized_at: {
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

StoreImageStatSchema.index(
  { user_id: 1 },
  {
    unique: true,
    partialFilterExpression: { user_id: { $type: "objectId" } },
  }
);

module.exports = mongoose.model("StoreImageStat", StoreImageStatSchema);
