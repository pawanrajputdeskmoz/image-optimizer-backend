const mongoose = require("mongoose");

const ImageOptimizationSchema = new mongoose.Schema(
  {
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

    bigcommerce_image_url: {
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

    bigcommerce_new_image_id: {
      type: Number,
      default: null,
      index: true,
    },

    bigcommerce_optimized_image_url: {
      type: String,
      default: null,
    },

    optimization_type: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "high",
    },

    image_quality: {
      type: Number,
      min: 1,
      max: 100,
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

ImageOptimizationSchema.index(
  { store_hash: 1, product_id: 1, image_id: 1 },
  { unique: true }
);

ImageOptimizationSchema.index({ store_hash: 1, product_id: 1 });

module.exports = mongoose.model("ImageOptimization", ImageOptimizationSchema);
