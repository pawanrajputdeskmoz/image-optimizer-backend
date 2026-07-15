const mongoose = require("mongoose");

const ASSIGNED_BY_VALUES = ["client", "admin", "system"];

const ClientPlanSchema = new mongoose.Schema(
  {
    store_hash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    base_plan_slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: "free",
    },
    assigned_by: {
      type: String,
      enum: ASSIGNED_BY_VALUES,
      default: "system",
    },
    /** First date the client subscribed to a paid plan. */
    started_at: {
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

module.exports = mongoose.model("ClientPlan", ClientPlanSchema);
module.exports.ASSIGNED_BY_VALUES = ASSIGNED_BY_VALUES;
