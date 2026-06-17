const commonContextProperties = {
  channel_id: { type: ["integer", "string"] },
  store_hash: { type: "string" },
};

const optimizeHomeBannerImageSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...commonContextProperties,
      id: { type: "string" },
      record_id: { type: "string" },
      source_type: {
        type: "string",
        enum: ["widget", "content_page", "marketing_banner", "storefront_html"],
      },
      source_key: { type: "string", minLength: 1 },
      source_id: { type: "string" },
      widget_uuid: { type: "string" },
      image_path: { type: "string" },
      original_url: { type: "string" },
      is_update_supported: { type: "boolean" },
      metadata: { type: "object" },
      force: { type: "boolean" },
      force_reoptimize: { type: "boolean" },
      reoptimize: { type: "boolean" },
      optimize_only: { type: "boolean" },
    },
  },
};

const getHomeImagesSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      channel_id: { type: ["integer", "string"] },
    },
  },
};

const restoreHomeImageSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      id: { type: "string" },
      record_id: { type: "string" },
      source_type: {
        type: "string",
        enum: ["widget", "content_page", "marketing_banner", "storefront_html"],
      },
      source_key: { type: "string" },
    },
  },
};

const homeImageItemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    record_id: { type: "string" },
    source_type: {
      type: "string",
      enum: ["widget", "content_page", "marketing_banner", "storefront_html"],
    },
    source_key: { type: "string" },
    source_id: { type: "string" },
    source_name: { type: "string" },
    context: { type: "string" },
    original_url: { type: "string" },
    widget_uuid: { type: "string" },
    widget_name: { type: "string" },
    image_path: { type: "string" },
    is_update_supported: { type: "boolean" },
    metadata: { type: "object" },
    optimization_status: { type: "string" },
  },
};

const bulkOptimizeHomeImagesCheckboxSchema = {
  body: {
    type: "object",
    required: ["images"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      force: { type: ["boolean", "string"] },
      force_reoptimize: { type: ["boolean", "string"] },
      reoptimize: { type: ["boolean", "string"] },
      images: {
        type: "array",
        minItems: 1,
        items: homeImageItemSchema,
      },
    },
  },
};

const bulkOptimizeHomeImagesAllSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      force: { type: ["boolean", "string"] },
      force_reoptimize: { type: ["boolean", "string"] },
    },
  },
};

const bulkRestoreHomeImagesCheckboxSchema = {
  body: {
    type: "object",
    required: ["images"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      images: {
        type: "array",
        minItems: 1,
        items: homeImageItemSchema,
      },
    },
  },
};

const bulkRestoreHomeImagesAllSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
    },
  },
};

const getHomeJobSchema = {
  params: {
    type: "object",
    required: ["job_uuid"],
    properties: {
      job_uuid: { type: "string" },
    },
  },
};

module.exports = {
  optimizeHomeBannerImageSchema,
  getHomeImagesSchema,
  restoreHomeImageSchema,
  bulkOptimizeHomeImagesCheckboxSchema,
  bulkOptimizeHomeImagesAllSchema,
  bulkRestoreHomeImagesCheckboxSchema,
  bulkRestoreHomeImagesAllSchema,
  getHomeJobSchema,
};
