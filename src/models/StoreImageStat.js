const mongoose = require("mongoose");

const StoreImageStatSchema = new mongoose.Schema(
  {
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

module.exports = mongoose.model("StoreImageStat", StoreImageStatSchema);
