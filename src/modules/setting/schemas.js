const getStoreOptimizationSettingsSchema = {
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
    additionalProperties: false,
    properties: {
      channel_id: {
        type: "integer",
        minimum: 1,
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
        enum: ["jpeg", "png", "webp", "avif", 'original'],
      },
      auto_optimize_new_images: { type: "boolean" },
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
  getStoreOptimizationSettingsSchema,
  upsertStoreOptimizationSettingsSchema,
};
