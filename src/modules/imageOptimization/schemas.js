const commonContextProperties = {
  shop: { type: "string" },
  channel_id: { type: ["integer", "string"] },
  store_id: { type: "string" },
  store_hash: { type: "string" },
};

const fetchAllProductsSchema = {
  body: {
    type: "object",
    required: ["channel_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      page: { type: ["integer", "string"] },
      limit: { type: ["integer", "string"] },
    },
  },
};

const sharedImagePayloadProperties = {
  ...commonContextProperties,
  product_id: { type: ["integer", "string"] },
  image_id: { type: ["integer", "string"] },
  image_url: { type: "string" },
  sort_order: { type: ["integer", "string"] },
  is_thumbnail: { type: ["boolean", "string", "integer"] },
  is_thumnail: { type: ["boolean", "string", "integer"] },
  imageName: { type: "string" },
  image_name: { type: "string" },
  altText: { type: "string" },
  alt_text: { type: "string" },
};

const singleImageOptimizationSchema = {
  params: {
    type: "object",
    required: ["image_id"],
    properties: {
      image_id: {
        type: ["integer", "string"],
      },
    },
  },
  body: {
    type: "object",
    required: ["product_id", "channel_id"],
    additionalProperties: true,
    properties: sharedImagePayloadProperties,
  },
};

const getPreviewImgDataSchema = {
  body: {
    type: "object",
    required: ["image_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      image_id: {
        type: ["integer", "string"],
      },
      product_id: {
        type: ["integer", "string"],
      },
    },
  },
};

const updateAltTextSchema = {
  params: {
    type: "object",
    required: ["image_id"],
    properties: {
      image_id: {
        type: ["integer", "string"],
      },
    },
  },
  body: {
    type: "object",
    required: ["product_id", "alt_text", "channel_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      product_id: {
        type: ["integer", "string"],
      },
      alt_text: {
        type: "string",
        maxLength: 500,
      },
      sort_order: { type: ["integer", "string"] },
      is_thumbnail: { type: ["boolean", "string", "integer"] },
      is_thumnail: { type: ["boolean", "string", "integer"] },
    },
  },
};

const bulkImageOptimizationSchema = {
  body: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      required: ["product_id", "image_url", "image_id", "channel_id"],
      additionalProperties: true,
      properties: sharedImagePayloadProperties,
    },
  },
};

const bulkImageOptimizationAllSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: commonContextProperties,
  },
};

const bulkRestoreSchema = {
  body: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      required: ["product_id", "image_id", "channel_id"],
      additionalProperties: true,
      properties: sharedImagePayloadProperties,
    },
  },
};

const bulkRestoreAllSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: commonContextProperties,
  },
};

const restoreImageSchema = {
  params: {
    type: "object",
    required: ["image_id"],
    properties: {
      image_id: {
        type: ["integer", "string"],
      },
    },
  },
  body: {
    type: "object",
    required: ["product_id", "channel_id"],
    additionalProperties: true,
    properties: sharedImagePayloadProperties,
  },
};

module.exports = {
  fetchAllProductsSchema,
  singleImageOptimizationSchema,
  bulkImageOptimizationSchema,
  bulkImageOptimizationAllSchema,
  getPreviewImgDataSchema,
  updateAltTextSchema,
  restoreImageSchema,
  bulkRestoreSchema,
  bulkRestoreAllSchema,
};
