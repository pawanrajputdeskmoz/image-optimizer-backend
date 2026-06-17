const mongoose = require("mongoose");
const { IMAGE_JOB_STATUSES, JOB_TYPES } = require("./constants");

/**
 * Tracks a bulk home image optimization or restore job.
 * Individual image status is tracked in HomeBannerImage.optimization_status.
 */
const HomeImageJobSchema = new mongoose.Schema(
  {
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

    channel_id: {
      type: Number,
      default: 1,
    },

    job_type: {
      type: String,
      enum: JOB_TYPES,
      default: "checkBox",
      index: true,
    },

    total_images: {
      type: Number,
      default: 0,
    },

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
  }
);

HomeImageJobSchema.index({ store_hash: 1, status: 1 });
HomeImageJobSchema.index({ store_hash: 1, job_type: 1, created_at: -1 });

module.exports = mongoose.model("HomeImageJob", HomeImageJobSchema);
