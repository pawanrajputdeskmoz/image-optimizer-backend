const mongoose = require("mongoose");
const { JOB_TYPES, IMAGE_JOB_ITEM_STATUSES } = require("./constants");

const BrandJobItemSchema = new mongoose.Schema(
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

    job_type: {
      type: String,
      enum: JOB_TYPES,
      required: true,
    },

    brand_id: {
      type: Number,
      required: true,
      index: true,
    },

    image_url: {
      type: String,
      default: null,
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
    collection: "brand_job_items",
  }
);

BrandJobItemSchema.index({ job_uuid: 1, brand_id: 1 }, { unique: true });
BrandJobItemSchema.index({ job_uuid: 1, status: 1 });
BrandJobItemSchema.index({ store_hash: 1, job_uuid: 1, status: 1 });
BrandJobItemSchema.index({ status: 1, completed_at: 1 });
BrandJobItemSchema.index({ job_uuid: 1, _id: 1 });
BrandJobItemSchema.index(
  { job_id: 1, status: 1, created_at: 1 },
  { partialFilterExpression: { job_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("BrandJobItem", BrandJobItemSchema);
