const commonContextProperties = {
  shop: { type: "string" },
  channel_id: { type: ["integer", "string"] },
  store_id: { type: "string" },
  store_hash: { type: "string" },
};

const fetchAllCategoriesSchema = {
  body: {
    type: "object",
    required: ["channel_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      tree_id: { type: ["integer", "string"] },
      page: { type: ["integer", "string"] },
      limit: { type: ["integer", "string"] },
    },
  },
};

const optimizeCategoryBodyProperties = {
  ...commonContextProperties,
  category_id: { type: ["integer", "string"] },
  tree_id: { type: ["integer", "string"] },
  image_url: { type: "string" },
  category_name: { type: "string" },
  optimization_status: { type: "string" },
  status: { type: "string" },
  force: { type: ["boolean", "string", "integer"] },
  force_reoptimize: { type: ["boolean", "string", "integer"] },
  reoptimize: { type: ["boolean", "string", "integer"] },
};

const optimizeCategoryBodySchema = {
  body: {
    type: "object",
    required: ["channel_id", "category_id"],
    additionalProperties: true,
    properties: optimizeCategoryBodyProperties,
  },
};

const optimizeCategorySchema = {
  params: {
    type: "object",
    required: ["category_id"],
    properties: {
      category_id: { type: ["integer", "string"] },
    },
  },
  body: {
    type: "object",
    required: ["channel_id"],
    additionalProperties: true,
    properties: optimizeCategoryBodyProperties,
  },
};

const getCategoryPreviewImgDataSchema = {
  body: {
    type: "object",
    required: ["category_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      category_id: {
        type: ["integer", "string"],
      },
    },
  },
};

const restoreCategorySchema = {
  body: {
    type: "object",
    required: ["channel_id", "category_id"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      category_id: { type: ["integer", "string"] },
      tree_id: { type: ["integer", "string"] },
    },
  },
};

const bulkCategoryOptimizeCheckboxSchema = {
  body: {
    type: "object",
    required: ["channel_id", "categories"],
    additionalProperties: true,
    properties: {
      ...commonContextProperties,
      force: { type: ["boolean", "string", "integer"] },
      force_reoptimize: { type: ["boolean", "string", "integer"] },
      reoptimize: { type: ["boolean", "string", "integer"] },
      categories: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            ...commonContextProperties,
            category_id: { type: ["integer", "string"] },
            tree_id: { type: ["integer", "string"] },
            image_url: { type: "string" },
            category_name: { type: "string" },
            optimization_status: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  },
};

const getCategoryJobSchema = {
  params: {
    type: "object",
    required: ["job_uuid"],
    properties: {
      job_uuid: { type: "string" },
    },
  },
};

module.exports = {
  fetchAllCategoriesSchema,
  optimizeCategorySchema,
  optimizeCategoryBodySchema,
  getCategoryPreviewImgDataSchema,
  restoreCategorySchema,
  bulkCategoryOptimizeCheckboxSchema,
  getCategoryJobSchema,
};
