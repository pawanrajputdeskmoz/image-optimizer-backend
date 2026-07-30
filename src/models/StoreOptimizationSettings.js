const mongoose = require("mongoose");

/**
 * BigCommerce Store Image Optimization Settings
 * Per-store optimization + SEO image settings
 */

const StoreOptimizationSettingsSchema = new mongoose.Schema(
  {
    //=======================================================
    // Store
    //=======================================================

    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    store_hash: {
      type: String,
      required: true,
      trim: true,
    },

    channel_id: {
      type: Number,
      default: 1,
      index: true,
    },

    //=======================================================
    // Feature toggles (single-image optimize flow)
    //=======================================================

    optimize_image_enabled: {
      type: Boolean,
      default: true,
    },

    optimization_mode: {
      type: String,
      enum: ["optimize_and_alt", "optimize_only", "alt_only"],
      default: "optimize_only",
      trim: true,
    },

    //=======================================================
    // Image File Name Template
    //=======================================================

    is_filename_template_enabled: {
      type: Boolean,
      default: false,
    },

    /**
     * Example:
     * [name]
     * [name]-[sku]
     * [brand]-[name]-[mpn]
     */
    filename_template: {
      type: String,
      default: "[name]",
      trim: true,
      maxlength: 500,
    },

    //=======================================================
    // ALT Text Template
    //=======================================================

    is_alt_text_template_enabled: {
      type: Boolean,
      default: false,
    },

    /**
     * Example:
     * [name]
     * [brand] [name]
     */
    alt_text_template: {
      type: String,
      default: "[name]",
      trim: true,
      maxlength: 500,
    },

    //=======================================================
    // Optimization Settings
    //=======================================================

    /**
     * Slider value from UI
     * 0 - 100
     */
    image_quality: {
      type: Number,
      min: 1,
      max: 100,
      default: 80,
    },

  


    /**
     * Output format: jpeg | png | webp | avif | original
     * "original" keeps the source image format when optimizing.
     */
    output_format: {
      type: String,
      enum: ["jpeg", "png", "webp", "avif", "original"],
      default: "jpeg",
    },



    //=======================================================
    // Cruise Control
    //=======================================================

    auto_optimize_new_images: {
      type: Boolean,
      default: false,
    },

    auto_optimize_new_category_images: {
      type: Boolean,
      default: false,
    },

    /**
     * Product listing / catalog-fetch name sort direction.
     * Applied as BigCommerce sort=name&direction=asc|desc.
     */
    product_sort_direction: {
      type: String,
      enum: ["asc", "desc"],
      default: "asc",
    },

  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

//=======================================================
// Indexes
//=======================================================

StoreOptimizationSettingsSchema.index(
  { store_hash: 1, channel_id: 1 },
  { unique: true }
);
StoreOptimizationSettingsSchema.index(
  { user_id: 1, channel_id: 1 },
  {
    unique: true,
    partialFilterExpression: { user_id: { $type: "objectId" } },
  }
);

module.exports = mongoose.model(
  "StoreOptimizationSettings",
  StoreOptimizationSettingsSchema
);