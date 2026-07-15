const mongoose = require("mongoose");

const PlanLimitNotificationSchema = new mongoose.Schema(
  {
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

module.exports = mongoose.model("PlanLimitNotification", PlanLimitNotificationSchema);
