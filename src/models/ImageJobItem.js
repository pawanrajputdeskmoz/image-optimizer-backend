const mongoose = require("mongoose");
const { JOB_TYPES, IMAGE_JOB_ITEM_STATUSES } = require("./constants");

const ImageJobItemSchema = new mongoose.Schema(
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
  }
);

ImageJobItemSchema.index(
  { job_uuid: 1, product_id: 1, image_id: 1 },
  { unique: true }
);

module.exports = mongoose.model("ImageJobItem", ImageJobItemSchema);
