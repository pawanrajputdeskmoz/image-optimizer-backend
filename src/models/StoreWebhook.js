const mongoose = require("mongoose");

/**
 * BigCommerce webhook registrations per store.
 * One document per store + scope (e.g. store/product/created).
 */

const StoreWebhookSchema = new mongoose.Schema(
  {
    store_hash: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    hook_id: {
      type: Number,
      required: true,
    },

    scope: {
      type: String,
      required: true,
      trim: true,
    },

    destination: {
      type: String,
      required: true,
      trim: true,
    },

    is_active: {
      type: Boolean,
      default: true,
    },

    registered_at: {
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

StoreWebhookSchema.index({ store_hash: 1, scope: 1 }, { unique: true });
StoreWebhookSchema.index({ store_hash: 1, hook_id: 1 });

module.exports = mongoose.model("StoreWebhook", StoreWebhookSchema);
