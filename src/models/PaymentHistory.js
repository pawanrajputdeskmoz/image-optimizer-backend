const mongoose = require("mongoose");

const PAYMENT_STATUSES = ["PENDING", "COMPLETED", "FAILED", "EXPIRED"];

const PaymentHistorySchema = new mongoose.Schema(
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
    plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      default: null,
    },
    plan_slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    plan_name: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "USD",
    },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "PENDING",
      index: true,
    },
    payment_method: {
      type: String,
      default: "PAYPAL",
    },
    paypal_order_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    capture_id: {
      type: String,
      default: null,
    },
    payer_id: {
      type: String,
      default: null,
    },
    payer_email: {
      type: String,
      default: null,
      trim: true,
    },
    paypal_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    paid_at: {
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

PaymentHistorySchema.index({ store_hash: 1, created_at: -1 });
PaymentHistorySchema.index(
  { user_id: 1, created_at: -1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("PaymentHistory", PaymentHistorySchema);
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
