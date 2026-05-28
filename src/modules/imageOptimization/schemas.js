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
    required: ["product_id"],
    additionalProperties: false,
    properties: {
      product_id: {
        type: ["integer", "string"],
      },
      image_url: {
        type: "string",
        minLength: 1,
      },
      imageName: { type: "string" },
      image_name: { type: "string" },
      altText: { type: "string" },
      alt_text: { type: "string" },
      sort_order: { type: ["integer", "string"] },
      is_thumbnail: { type: ["boolean", "string"] },
      is_thumnail: { type: ["boolean", "string"] },
    },
  },
};

const getPreviewImgDataSchema = {
  body: {
    type: "object",
    required: ["image_id"],
    additionalProperties: false,
    properties: {
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
    required: ["product_id", "alt_text"],
    additionalProperties: false,
    properties: {
      product_id: {
        type: ["integer", "string"],
      },
      alt_text: {
        type: "string",
        maxLength: 500,
      },
      sort_order: { type: ["integer", "string"] },
      is_thumbnail: { type: ["boolean", "string"] },
      is_thumnail: { type: ["boolean", "string"] },
    },
  },
};

const bulkImageOptimizationSchema = {
  body: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      required: ["product_id", "image_url", "image_id"],
      properties: {
        image_id: { type: ["integer", "string"] },
        product_id: { type: ["integer", "string"] },
        image_url: { type: "string", minLength: 1 },
        shop: { type: "string" },
        channel_id: { type: ["integer", "string"] },
        store_id: { type: "string" },
      },
    },
  },
};

/** Full-store bulk: empty body; store from auth (same as other store-scoped APIs). */
const bulkImageOptimizationAllSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {},
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
    required: ["product_id"],
    additionalProperties: false,
    properties: {
      product_id: {
        type: ["integer", "string"],
      },
      image_url: {
        type: "string",
        minLength: 1,
      },
      imageName: { type: "string" },
      image_name: { type: "string" },
      altText: { type: "string" },
      alt_text: { type: "string" },
      sort_order: { type: ["integer", "string"] },
      is_thumbnail: { type: ["boolean", "string"] },
      is_thumnail: { type: ["boolean", "string"] },
    },
  },
};

module.exports = {
  singleImageOptimizationSchema,
  bulkImageOptimizationSchema,
  bulkImageOptimizationAllSchema,
  getPreviewImgDataSchema,
  updateAltTextSchema,
  restoreImageSchema,
};
