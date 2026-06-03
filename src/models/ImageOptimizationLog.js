const mongoose = require("mongoose");
const { JOB_TYPES, LOG_TYPES, LOG_STEPS } = require("./constants");

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
      enum: JOB_TYPES,
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
      enum: LOG_TYPES,
      default: "info",
      index: true,
    },

    /** One of LOG_STEPS in constants.js, or null when omitted. */
    step: {
      type: String,
      default: null,
      validate: {
        validator(value) {
          return value == null || LOG_STEPS.includes(value);
        },
        message: "Invalid log step",
      },
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
ImageOptimizationLogSchema.index({
  store_hash: 1,
  job_type: 1,
  created_at: -1,
});

module.exports = mongoose.model(
  "ImageOptimizationLog",
  ImageOptimizationLogSchema
);
