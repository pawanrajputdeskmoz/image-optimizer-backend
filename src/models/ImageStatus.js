const mongoose = require("mongoose");

const ImageStatusSchema = new mongoose.Schema(
  {
    store_hash: {
      type: String,
      required: true,
      index: true,
    },

    product_id: {
      type: Number,
      required: true,
      index: true,
    },

    image_id: {
      type: Number,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "optimizing",
        "optimized",
        "restored",
        "failed",
        "skipped",
      ],
      default: "pending",
      index: true,
    },

    retry_count: {
      type: Number,
      default: 0,
    },

    processing_time_ms: {
      type: Number,
      default: 0,
    },

    optimization_started_at: {
      type: Date,
      default: null,
    },

    optimized_at: {
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

ImageStatusSchema.index(
  { store_hash: 1, product_id: 1, image_id: 1 },
  { unique: true }
);

ImageStatusSchema.index({ store_hash: 1, image_id: 1, status: 1 });
ImageStatusSchema.index({ store_hash: 1, status: 1 });
ImageStatusSchema.index({ store_hash: 1, product_id: 1, status: 1 });
ImageStatusSchema.index({ store_hash: 1, optimized_at: -1 });

module.exports = mongoose.model("ImageStatus", ImageStatusSchema);
