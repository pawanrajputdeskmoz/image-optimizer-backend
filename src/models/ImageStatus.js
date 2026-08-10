const mongoose = require("mongoose");
const { IMAGE_STATUS_VALUES, IMAGE_UPDATE_STATUS_VALUES } = require("./constants");

const ImageStatusSchema = new mongoose.Schema(
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

    status: {
      type: String,
      enum: IMAGE_STATUS_VALUES,
      default: "pending",
      index: true,
    },

    image_update_status: {
      type: String,
      enum: IMAGE_UPDATE_STATUS_VALUES,
      default: "pending",
      index: true,
    },

    optimization_started_at: {
      type: Date,
      default: null,
    },

    optimized_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    collection: "image_statuses",
  }
);

ImageStatusSchema.index(
  { store_hash: 1, product_id: 1, image_id: 1 },
  { unique: true }
);

ImageStatusSchema.index({ store_hash: 1, image_id: 1, status: 1 });
ImageStatusSchema.index({ store_hash: 1, product_id: 1, status: 1 });
ImageStatusSchema.index({ store_hash: 1, optimized_at: -1 });
ImageStatusSchema.index({ store_hash: 1, status: 1, optimized_at: 1 });
ImageStatusSchema.index({ status: 1, optimized_at: 1 });
ImageStatusSchema.index(
  { image_optimization_id: 1 },
  {
    unique: true,
    partialFilterExpression: { image_optimization_id: { $type: "objectId" } },
  }
);
ImageStatusSchema.index(
  { user_id: 1, status: 1, optimized_at: 1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("ImageStatus", ImageStatusSchema);
