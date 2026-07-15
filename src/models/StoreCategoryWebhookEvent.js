const mongoose = require("mongoose");

/**
 * One document per incoming BigCommerce category webhook event.
 * Detailed step-by-step activity is tracked separately in `CategoryWebhookLog`.
 */

const StoreCategoryWebhookEventSchema = new mongoose.Schema(
  {
    trace_id: {
      type: String,
      default: null,
      index: true,
    },

    store_hash: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    event_hash: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    scope: {
      type: String,
      default: null,
      trim: true,
    },

    category_id: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },

    store_id: {
      type: String,
      default: null,
      trim: true,
    },

    status: {
      type: String,
      default: "received",
      trim: true,
      index: true,
    },

    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    error_message: {
      type: String,
      default: null,
      trim: true,
    },

    received_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

StoreCategoryWebhookEventSchema.index({ store_hash: 1, event_hash: 1 }, { unique: true });
StoreCategoryWebhookEventSchema.index({ store_hash: 1, created_at: -1 });
StoreCategoryWebhookEventSchema.index({ store_hash: 1, category_id: 1, created_at: -1 });

module.exports = mongoose.model("StoreCategoryWebhookEvent", StoreCategoryWebhookEventSchema);
