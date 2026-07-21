const mongoose = require("mongoose");

const PlanLimitNotificationSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    store_hash: {
      type: String,
      required: true,
      index: true,
    },
    year_month: {
      type: String,
      required: true,
      index: true,
    },
    email: {
      type: String,
      default: null,
    },
    message: {
      type: String,
      default: null,
    },
    sent_at: {
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

PlanLimitNotificationSchema.index(
  { store_hash: 1, year_month: 1 },
  { unique: true }
);
PlanLimitNotificationSchema.index(
  { user_id: 1, year_month: 1 },
  {
    unique: true,
    partialFilterExpression: { user_id: { $type: "objectId" } },
  }
);

module.exports = mongoose.model("PlanLimitNotification", PlanLimitNotificationSchema);
