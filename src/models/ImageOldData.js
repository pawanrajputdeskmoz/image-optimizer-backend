const mongoose = require("mongoose");

const ImageOldDataSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    image_optimization_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImageOptimization",
      default: null,
    },
    store_hash: {
      type: String,
      required: true,
      index: true,
    },

    product_id: {
      type: Number,
      required: true,
      index: true,
    },

    image_id: {
      type: Number,
      required: true,
      index: true,
    },

    imageName: {
      type: String,
      default: null,
      trim: true,
    },

    altText: {
      type: String,
      default: null,
      trim: true,
    },

    newImageName: {
      type: String,
      default: null,
      trim: true,
    },

    newAltText: {
      type: String,
      default: null,
      trim: true,
    },

    /** Local disk path for the originally downloaded image. */
    original_image_path: {
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
      index: true,
    },

    saved_percentage: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    collection: "image_old_datas",
  }
);

ImageOldDataSchema.index(
  { store_hash: 1, product_id: 1, image_id: 1 },
  { unique: true }
);

ImageOldDataSchema.index({ store_hash: 1, image_id: 1 });
ImageOldDataSchema.index({ store_hash: 1, product_id: 1 });
ImageOldDataSchema.index(
  { image_optimization_id: 1 },
  {
    unique: true,
    partialFilterExpression: { image_optimization_id: { $type: "objectId" } },
  }
);
ImageOldDataSchema.index(
  { user_id: 1, product_id: 1, image_id: 1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("ImageOldData", ImageOldDataSchema);
