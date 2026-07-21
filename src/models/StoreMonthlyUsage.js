const mongoose = require("mongoose");

const IMAGE_TYPES = ["product", "category", "brand", "home_banner"];

const StoreMonthlyUsageSchema = new mongoose.Schema(
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
    year: {
      type: Number,
      required: true,
      min: 2000,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    images_optimized: {
      type: Number,
      default: 0,
      min: 0,
    },
    product_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    category_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    brand_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    home_banner_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Plan slug snapshot for this billing month */
    plan_slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: "free",
    },
    plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      default: null,
    },
    /** Monthly image cap snapshot — null means unlimited for this month */
    monthly_image_limit: {
      type: Number,
      default: null,
      min: 1,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

StoreMonthlyUsageSchema.index({ store_hash: 1, year: 1, month: 1 }, { unique: true });
StoreMonthlyUsageSchema.index({ store_hash: 1, year: -1, month: -1 });
StoreMonthlyUsageSchema.index(
  { user_id: 1, year: 1, month: 1 },
  {
    unique: true,
    partialFilterExpression: { user_id: { $type: "objectId" } },
  }
);

module.exports = mongoose.model("StoreMonthlyUsage", StoreMonthlyUsageSchema);
module.exports.IMAGE_TYPES = IMAGE_TYPES;
