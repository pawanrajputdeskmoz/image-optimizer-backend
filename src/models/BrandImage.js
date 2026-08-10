const mongoose = require("mongoose");

const BrandImageSchema = new mongoose.Schema(
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

    brand_id: {
      type: Number,
      required: true,
      index: true,
    },

    brand_name: {
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
    collection: "brand_images",
  }
);

BrandImageSchema.index(
  { store_hash: 1, brand_id: 1, original_url: 1 },
  { unique: true }
);

BrandImageSchema.index({ store_hash: 1, brand_id: 1 });
BrandImageSchema.index(
  { user_id: 1, brand_id: 1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("BrandImage", BrandImageSchema);
