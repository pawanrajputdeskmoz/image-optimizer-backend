const mongoose = require("mongoose");

const PlanSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: null,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "USD",
    },
    /** null = unlimited monthly images */
    monthly_image_limit: {
      type: Number,
      default: null,
      min: 1,
    },
    is_active: {
      type: Boolean,
      default: true,
      index: true,
    },
    display_order: {
      type: Number,
      default: 0,
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

PlanSchema.index({ is_active: 1, display_order: 1 });

module.exports = mongoose.model("Plan", PlanSchema);
