const mongoose = require("mongoose");
const {
  CATEGORY_IMAGE_STATUS_VALUES,
  CATEGORY_IMAGE_UPDATE_STATUS_VALUES,
} = require("./constants");

const CategoryImageStatusSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    category_image_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CategoryImage",
      default: null,
    },
    store_hash: {
      type: String,
      required: true,
      index: true,
    },

    channel_id: {
      type: Number,
      default: 1,
      index: true,
    },

    tree_id: {
      type: Number,
      default: null,
    },

    category_id: {
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
      index: true,
    },

    original_url: {
      type: String,
      default: null,
    },

    optimized_url: {
      type: String,
      default: null,
    },

    optimized_asset_id: {
      type: String,
      default: null,
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
    collection: "category_image_statuses",
  }
);

CategoryImageStatusSchema.index(
  { store_hash: 1, category_id: 1 },
  { unique: true }
);

CategoryImageStatusSchema.index({ store_hash: 1, status: 1, optimized_at: 1 });
CategoryImageStatusSchema.index({ status: 1, optimized_at: 1 });
CategoryImageStatusSchema.index(
  { category_image_id: 1 },
  {
    unique: true,
    partialFilterExpression: { category_image_id: { $type: "objectId" } },
  }
);
CategoryImageStatusSchema.index(
  { user_id: 1, status: 1, optimized_at: 1 },
  { partialFilterExpression: { user_id: { $type: "objectId" } } }
);

const CategoryImageStatus = mongoose.model(
  "CategoryImageStatus",
  CategoryImageStatusSchema
);

module.exports = CategoryImageStatus;
