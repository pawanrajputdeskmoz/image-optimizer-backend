const mongoose = require("mongoose");
const { LOG_TYPES, WEBHOOK_LOG_STEPS } = require("./constants");

const CategoryWebhookLogSchema = new mongoose.Schema(
  {
    trace_id: {
      type: String,
      required: true,
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
      trim: true,
      default: null,
      index: true,
    },

    scope: {
      type: String,
      trim: true,
      default: null,
    },

    category_id: {
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

    step: {
      type: String,
      default: null,
      validate: {
        validator(value) {
          return value == null || WEBHOOK_LOG_STEPS.includes(value);
        },
        message: "Invalid category webhook log step",
      },
    },

    sequence: {
      type: Number,
      required: true,
      min: 1,
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

CategoryWebhookLogSchema.index({ trace_id: 1, sequence: 1 }, { unique: true });
CategoryWebhookLogSchema.index({ trace_id: 1, created_at: 1 });
CategoryWebhookLogSchema.index({ store_hash: 1, created_at: -1 });
CategoryWebhookLogSchema.index({ store_hash: 1, event_hash: 1, created_at: -1 });
CategoryWebhookLogSchema.index({ store_hash: 1, category_id: 1, created_at: -1 });

module.exports = mongoose.model("CategoryWebhookLog", CategoryWebhookLogSchema);
