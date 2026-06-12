const optimizeHomeBannerImageSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      channel_id: { type: ["integer", "string"] },
      id: { type: "string" },
      record_id: { type: "string" },
      source_type: {
        type: "string",
        enum: ["widget", "content_page", "storefront_html"],
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

module.exports = {
  optimizeHomeBannerImageSchema,
  getHomeImagesSchema,
};
