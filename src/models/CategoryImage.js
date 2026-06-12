const mongoose = require("mongoose");

const CategoryImageSchema = new mongoose.Schema(
  {
    store_hash: {
      type: String,
      required: true,
      index: true,
    },

    channel_id: {
      type: Number,
      default: 1,
      index: true,
    },

    tree_id: {
      type: Number,
      default: null,
      index: true,
    },

    category_id: {
      type: Number,
      required: true,
      index: true,
    },

    category_name: {
      type: String,
      default: null,
    },

    original_url: {
      type: String,
      required: true,
    },

    optimized_url: {
      type: String,
      default: null,
    },

    original_image_path: {
      type: String,
      default: null,
    },

    optimized_image_path: {
      type: String,
      default: null,
    },

    original: {
      size: { type: Number, default: 0 },
      width: { type: Number, default: 0 },
      height: { type: Number, default: 0 },
      format: { type: String, default: null },
    },

    optimized: {
      size: { type: Number, default: 0 },
      width: { type: Number, default: 0 },
      height: { type: Number, default: 0 },
      format: { type: String, default: null },
    },

    saved_bytes: {
      type: Number,
      default: 0,
    },

    saved_percentage: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

CategoryImageSchema.index(
  { store_hash: 1, category_id: 1, original_url: 1 },
  { unique: true }
);

CategoryImageSchema.index({ store_hash: 1, category_id: 1 });

const CategoryImage = mongoose.model("CategoryImage", CategoryImageSchema);

module.exports = CategoryImage;
