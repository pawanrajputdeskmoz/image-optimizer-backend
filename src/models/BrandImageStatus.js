const mongoose = require("mongoose");
const {
  CATEGORY_IMAGE_STATUS_VALUES,
  CATEGORY_IMAGE_UPDATE_STATUS_VALUES,
} = require("./constants");

const BrandImageStatusSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    brand_image_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BrandImage",
      default: null,
    },
    store_hash: {
      type: String,
      required: true,
      index: true,
    },

    brand_id: {
      type: Number,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: CATEGORY_IMAGE_STATUS_VALUES,
      default: "pending",
      index: true,
    },

    image_update_status: {
      type: String,
      enum: CATEGORY_IMAGE_UPDATE_STATUS_VALUES,
      default: "pending",
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

BrandImageStatusSchema.index(
  { store_hash: 1, brand_id: 1 },
  { unique: true }
);

BrandImageStatusSchema.index({ store_hash: 1, status: 1, optimized_at: 1 });
BrandImageStatusSchema.index({ status: 1, optimized_at: 1 });
BrandImageStatusSchema.index(
  { brand_image_id: 1 },
  {
    unique: true,
    partialFilterExpression: { brand_image_id: { $type: "objectId" } },
  }
);
BrandImageStatusSchema.index(
  { user_id: 1, status: 1, optimized_at: 1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

module.exports = mongoose.model("BrandImageStatus", BrandImageStatusSchema);
