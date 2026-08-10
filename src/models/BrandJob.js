const mongoose = require("mongoose");
const { JOB_TYPES, IMAGE_JOB_STATUSES } = require("./constants");

const BrandJobSchema = new mongoose.Schema(
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
    collection: "brand_jobs",
  }
);

BrandJobSchema.index({ store_hash: 1, job_type: 1, created_at: -1 });
BrandJobSchema.index({ store_hash: 1, status: 1, created_at: -1 });
BrandJobSchema.index(
  { user_id: 1, status: 1, created_at: -1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("BrandJob", BrandJobSchema);
