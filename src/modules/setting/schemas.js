const getChannelsSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              type: { type: "string" },
              platform: { type: "string" },
              status: { type: "string" },
              site_id: { type: "integer" },
              url: { type: "string" },
            },
          },
        },
        default: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                channel_id: { type: "integer" },
                site_id: { type: "integer" },
                platform: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
};

const getStoreOptimizationSettingsSchema = {
  querystring: {
    type: "object",
    properties: {
      channel_id: { type: ["integer", "string"] },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          anyOf: [{ type: "null" }, { type: "object", additionalProperties: true }],
        },
      },
    },
  },
};

const upsertStoreOptimizationSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: {
      channel_id: {
        type: ["integer", "string"],
      },
      optimize_image_enabled: { type: "boolean" },
      is_filename_template_enabled: { type: "boolean" },
      filename_template: {
        type: "string",
        minLength: 1,
        maxLength: 500,
      },
      is_alt_text_template_enabled: { type: "boolean" },
      alt_text_template: {
        type: "string",
        minLength: 1,
        maxLength: 500,
      },
      image_quality: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
      output_format: {
        type: "string",
        enum: ["jpeg", "png", "webp", "avif", "original"],
      },
      auto_optimize_new_images: { type: "boolean" },
      shop: { type: "string" },
      store_id: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: { type: "object", additionalProperties: true },
      },
    },
  },
};

module.exports = {
  getChannelsSchema,
  getStoreOptimizationSettingsSchema,
  upsertStoreOptimizationSettingsSchema,
};
