const mongoose = require("mongoose");

const ASSIGNED_BY_VALUES = ["client", "admin", "system"];
const SUBSCRIPTION_STATUS_VALUES = ["active", "cancel"];

const ClientPlanSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
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
    plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      default: null,
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
    /** Active PayPal billing subscription id (I-...). */
    paypal_subscription_id: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    /** PayPal Billing Plan id (P-...) linked to this subscription. */
    paypal_plan_id: {
      type: String,
      trim: true,
      default: null,
    },
    /** PayPal subscription lifecycle: active | cancel */
    subscription_status: {
      type: String,
      enum: SUBSCRIPTION_STATUS_VALUES,
      default: null,
      index: true,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

ClientPlanSchema.index(
  { user_id: 1 },
  {
    unique: true,
    partialFilterExpression: { user_id: { $type: "objectId" } },
  }
);
ClientPlanSchema.index({ plan_id: 1, store_hash: 1 });

module.exports = mongoose.model("ClientPlan", ClientPlanSchema);
module.exports.ASSIGNED_BY_VALUES = ASSIGNED_BY_VALUES;
module.exports.SUBSCRIPTION_STATUS_VALUES = SUBSCRIPTION_STATUS_VALUES;
