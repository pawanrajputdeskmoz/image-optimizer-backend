const mongoose = require("mongoose");
const { JOB_TYPES, LOG_TYPES, LOG_STEPS } = require("./constants");

const BrandImageJobLogSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    job_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BrandJob",
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

    source_type: {
      type: String,
      default: "brand",
      index: true,
    },

    job_type: {
      type: String,
      enum: JOB_TYPES,
      required: true,
      index: true,
    },

    brand_id: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true,
    },

    log_type: {
      type: String,
      enum: LOG_TYPES,
      default: "info",
      index: true,
    },

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

BrandImageJobLogSchema.index({ job_uuid: 1, created_at: -1 });
BrandImageJobLogSchema.index({ store_hash: 1, brand_id: 1, created_at: -1 });
BrandImageJobLogSchema.index({ store_hash: 1, job_type: 1, created_at: -1 });
BrandImageJobLogSchema.index({ created_at: -1 });
BrandImageJobLogSchema.index({ log_type: 1, created_at: -1 });
BrandImageJobLogSchema.index(
  { job_id: 1, created_at: -1 },
  { partialFilterExpression: { job_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("BrandImageJobLog", BrandImageJobLogSchema);
