// models/ImageOptimizationJob.js

const mongoose = require("mongoose");

const ImageOptimizationJobSchema = new mongoose.Schema(
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

    job_type: {
      type: String,
      enum: [
        "single",
        "bulk",
        "webhook",
        "reoptimize",
        "checkBox",
      ],
      default: "single",
      index: true,
    },

    /** Total images in the bulk request (queued + skipped). */
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

    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
      ],
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

ImageOptimizationJobSchema.index({
  store_hash: 1,
  status: 1,
});

module.exports = mongoose.model(
  "ImageOptimizationJob",
  ImageOptimizationJobSchema
);