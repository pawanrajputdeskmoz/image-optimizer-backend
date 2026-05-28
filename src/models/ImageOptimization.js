// models/ImageOptimization.js

const mongoose = require("mongoose");

const ImageOptimizationSchema = new mongoose.Schema(
 {
  store_hash: {
   type: String,
   required: true,
   index: true,
  },

  product_id: {
   type: Number,
   required: true,
   index: true,
  },

  image_id: {
   type: Number,
   required: true,
   index: true,
  },

  bigcommerce_image_url: {
   type: String,
   default: null,
  },

  original_image_path: {
   type: String,
   default: null,
  },

  optimized_image_path: {
   type: String,
   default: null,
  },

  // BigCommerce metadata after replacement upload.
  bigcommerce_new_image_id: {
   type: Number,
   default: null,
   index: true,
  },

  bigcommerce_optimized_image_url: {
   type: String,
   default: null,
  },


  optimization_type: {
   type: String,
   enum: [
    "high",
    "medium",
    "low",
   ],
   default: "high",
  },

   /** Quality % (1–100) used when this image was optimized. */
  image_quality: {
   type: Number,
   min: 1,
   max: 100,
   default: null,
  },

  // image_hash: {
  //   type: String,
  //   default: null,
  //   index: true,
  // },

 },
 {
  timestamps: {
   createdAt: "created_at",
   updatedAt: "updated_at",
  },
 }
);

// UNIQUE IMAGE INDEX
ImageOptimizationSchema.index(
 {
  store_hash: 1,
  product_id: 1,
  image_id: 1,
 },
 {
  unique: true,
 }
);

// PRODUCT PAGE INDEX
ImageOptimizationSchema.index({
 store_hash: 1,
 product_id: 1,
});

module.exports = mongoose.model(
 "ImageOptimization",
 ImageOptimizationSchema
);