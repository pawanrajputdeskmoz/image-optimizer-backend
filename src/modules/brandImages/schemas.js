const commonContextProperties = {
  shop: { type: "string" },
  store_id: { type: "string" },
  store_hash: { type: "string" },
};

const fetchAllBrandsSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      page: { type: ["integer", "string"] },
      limit: { type: ["integer", "string"] },
    },
  },
};

const optimizeBrandBodyProperties = {
  ...commonContextProperties,
  brand_id: { type: ["integer", "string"] },
  image_url: { type: "string" },
  brand_name: { type: "string" },
  optimization_status: { type: "string" },
  status: { type: "string" },
  force: { type: ["boolean", "string", "integer"] },
  force_reoptimize: { type: ["boolean", "string", "integer"] },
  reoptimize: { type: ["boolean", "string", "integer"] },
};

const optimizeBrandBodySchema = {
  body: {
    type: "object",
    required: ["brand_id"],
    additionalProperties: true,
    properties: optimizeBrandBodyProperties,
  },
};

const optimizeBrandSchema = {
  params: {
    type: "object",
    required: ["brand_id"],
    properties: {
      brand_id: { type: ["integer", "string"] },
    },
  },
  body: {
    type: "object",
    additionalProperties: true,
    properties: optimizeBrandBodyProperties,
  },
};

const getBrandPreviewImgDataSchema = {
  body: {
    type: "object",
    required: ["brand_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      brand_id: { type: ["integer", "string"] },
    },
  },
};

const restoreBrandSchema = {
  body: {
    type: "object",
    required: ["brand_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      brand_id: { type: ["integer", "string"] },
    },
  },
};

const bulkBrandOptimizeCheckboxSchema = {
  body: {
    type: "object",
    required: ["brands"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      brands: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            brand_id: { type: ["integer", "string"] },
            image_url: { type: "string" },
            brand_name: { type: "string" },
            name: { type: "string" },
            optimization_status: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  },
};

const getBrandJobSchema = {
  params: {
    type: "object",
    required: ["job_uuid"],
    properties: {
      job_uuid: { type: "string" },
    },
  },
};

module.exports = {
  fetchAllBrandsSchema,
  optimizeBrandBodySchema,
  optimizeBrandSchema,
  getBrandPreviewImgDataSchema,
  restoreBrandSchema,
  bulkBrandOptimizeCheckboxSchema,
  getBrandJobSchema,
};
