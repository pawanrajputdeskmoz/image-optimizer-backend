// models/ImageOptimizationLog.js

const mongoose = require("mongoose");

const ImageOptimizationLogSchema = new mongoose.Schema(
  {
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
      enum: ["checkBox", "bulk", "single", "webhook", "reoptimize"],
      required: true,
      index: true,
    },

    image_id: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },

    product_id: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },

    log_type: {
      type: String,
      enum: [
        "info",
        "warning",
        "error",
      ],
      default: "info",
      index: true,
    },

    step: {
      type: String,
      default: null,
    },

    message: {
      type: String,
      required: true,
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: false,
    },
  }
);

ImageOptimizationLogSchema.index({ job_uuid: 1, created_at: -1 });
ImageOptimizationLogSchema.index({ store_hash: 1, job_type: 1, created_at: -1 });

module.exports = mongoose.model(
  "ImageOptimizationLog",
  ImageOptimizationLogSchema
);