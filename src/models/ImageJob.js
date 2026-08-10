const mongoose = require("mongoose");
const { JOB_TYPES, IMAGE_JOB_STATUSES } = require("./constants");

const ImageOptimizationJobSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    job_uuid: {
      type: String,
      required: true,
      unique: true,
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
      default: "single",
      index: true,
    },

    /** Total images in the request (valid + skipped). */
    total_images: {
      type: Number,
      default: 0,
    },

    /** Images actually sent to the worker queue. */
    queued_images: {
      type: Number,
      default: 0,
    },

    processed_images: {
      type: Number,
      default: 0,
    },

    success_images: {
      type: Number,
      default: 0,
    },

    failed_images: {
      type: Number,
      default: 0,
    },

    skipped_images: {
      type: Number,
      default: 0,
    },

    /** Total MongoDB batches for this job (staggered Redis dispatch). */
    total_batches: {
      type: Number,
      default: 0,
    },

    /** Last batch index dispatched to Redis (-1 = none yet). */
    last_dispatched_batch_index: {
      type: Number,
      default: -1,
    },

    status: {
      type: String,
      enum: IMAGE_JOB_STATUSES,
      default: "pending",
      index: true,
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
    collection: "image_optimization_jobs",
  }
);

ImageOptimizationJobSchema.index({ store_hash: 1, created_at: -1 });
ImageOptimizationJobSchema.index({ store_hash: 1, status: 1, created_at: -1 });
ImageOptimizationJobSchema.index(
  { user_id: 1, status: 1, created_at: -1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model(
  "ImageOptimizationJob",
  ImageOptimizationJobSchema
);
