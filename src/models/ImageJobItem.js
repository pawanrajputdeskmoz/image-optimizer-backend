const mongoose = require("mongoose");
const { JOB_TYPES, IMAGE_JOB_ITEM_STATUSES } = require("./constants");

const ImageJobItemSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    job_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImageOptimizationJob",
      default: null,
    },
    job_uuid: {
      type: String,
      required: true,
      index: true,
    },

    store_hash: {
      type: String,
      required: true,
      index: true,
    },

    job_type: {
      type: String,
      enum: JOB_TYPES,
      required: true,
    },

    product_id: {
      type: Number,
      required: true,
    },

    image_id: {
      type: Number,
      required: true,
    },

    image_url: {
      type: String,
      default: null,
    },

    sort_order: {
      type: Number,
      default: null,
    },

    is_thumbnail: {
      type: Boolean,
      default: null,
    },

    batch_index: {
      type: Number,
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: IMAGE_JOB_ITEM_STATUSES,
      default: "queued",
      index: true,
    },

    skip_reason: {
      type: String,
      default: null,
    },

    error_message: {
      type: String,
      default: null,
    },

    saved_bytes: {
      type: Number,
      default: null,
    },

    saved_percentage: {
      type: Number,
      default: null,
    },

    started_at: {
      type: Date,
      default: null,
    },

    completed_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    collection: "image_job_items",
  }
);

ImageJobItemSchema.index(
  { job_uuid: 1, product_id: 1, image_id: 1 },
  { unique: true }
);

ImageJobItemSchema.index({
  job_uuid: 1,
  batch_index: 1,
  status: 1,
  product_id: 1,
  image_id: 1,
});
ImageJobItemSchema.index({
  store_hash: 1,
  product_id: 1,
  image_id: 1,
  status: 1,
});
ImageJobItemSchema.index({ status: 1, completed_at: 1 });
ImageJobItemSchema.index({ job_uuid: 1, _id: 1 });
ImageJobItemSchema.index(
  { job_id: 1, status: 1, created_at: 1 },
  { partialFilterExpression: { job_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("ImageJobItem", ImageJobItemSchema);
