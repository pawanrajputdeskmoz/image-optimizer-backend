const mongoose = require("mongoose");
const {
  HOME_BANNER_OPTIMIZATION_STATUSES,
  HOME_BANNER_SOURCE_TYPES,
} = require("./constants");

const HomeBannerImageSchema = new mongoose.Schema(
  {
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

    source_type: {
      type: String,
      enum: HOME_BANNER_SOURCE_TYPES,
      default: "widget",
      index: true,
    },

    source_key: {
      type: String,
      required: true,
      index: true,
    },

    source_id: {
      type: String,
      default: null,
    },

    source_name: {
      type: String,
      default: null,
    },

    context: {
      type: String,
      default: null,
    },

    is_update_supported: {
      type: Boolean,
      default: true,
    },

    widget_uuid: {
      type: String,
      default: null,
      index: true,
    },

    widget_name: {
      type: String,
      default: null,
    },

    widget_template_uuid: {
      type: String,
      default: null,
    },

    image_path_in_config: {
      type: String,
      default: null,
    },

    original_url: {
      type: String,
      default: null,
    },

    current_url: {
      type: String,
      default: null,
    },

    optimized_url: {
      type: String,
      default: null,
    },

    original_size: {
      type: Number,
      default: null,
    },

    optimized_size: {
      type: Number,
      default: null,
    },

    saved_bytes: {
      type: Number,
      default: 0,
    },

    saved_percent: {
      type: Number,
      default: 0,
    },

    output_format: {
      type: String,
      default: null,
    },

    optimization_status: {
      type: String,
      enum: HOME_BANNER_OPTIMIZATION_STATUSES,
      default: "pending",
      index: true,
    },

    error_message: {
      type: String,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    last_optimized_at: {
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

HomeBannerImageSchema.index(
  { store_hash: 1, channel_id: 1, source_type: 1, source_key: 1 },
  { unique: true }
);

const HomeBannerImage = mongoose.model("HomeBannerImage", HomeBannerImageSchema);

const LEGACY_INDEX = "store_hash_1_channel_id_1_widget_uuid_1_image_path_in_config_1";

HomeBannerImage.syncModelIndexes = async function syncModelIndexes() {
  try {
    await this.collection.dropIndex(LEGACY_INDEX);
  } catch {
    // Index may not exist on fresh databases.
  }

  await this.syncIndexes();
};

module.exports = HomeBannerImage;
