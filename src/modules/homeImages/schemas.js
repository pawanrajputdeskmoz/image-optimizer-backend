const commonContextProperties = {
  shop: { type: "string" },
  channel_id: { type: ["integer", "string"] },
  store_id: { type: "string" },
  store_hash: { type: "string" },
};

const getHomeImagesSchema = {
  body: {
    type: "object",
    required: ["channel_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
    },
  },
};

module.exports = {
  getHomeImagesSchema,
};
