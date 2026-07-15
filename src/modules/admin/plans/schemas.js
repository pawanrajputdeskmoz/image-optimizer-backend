const planSchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    description: { anyOf: [{ type: "null" }, { type: "string" }] },
    price: { type: "number" },
    currency: { type: "string" },
    monthly_image_limit: { anyOf: [{ type: "null" }, { type: "number" }] },
    is_active: { type: "boolean" },
    display_order: { type: "number" },
    created_at: { anyOf: [{ type: "null" }, { type: "string" }] },
    updated_at: { anyOf: [{ type: "null" }, { type: "string" }] },
  },
};

const planUpdateItemSchema = {
  type: "object",
  required: ["slug"],
  properties: {
    slug: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    price: { type: "number", minimum: 0 },
    currency: { type: "string", minLength: 3, maxLength: 3 },
    monthly_image_limit: {
      anyOf: [{ type: "null" }, { type: "number", minimum: 1 }],
    },
    is_active: { type: "boolean" },
    display_order: { type: "number" },
  },
};

const listPlansSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            plans: { type: "array", items: planSchema },
          },
        },
      },
    },
  },
};

const updatePlansSchema = {
  body: {
    type: "object",
    required: ["plans"],
    properties: {
      plans: {
        type: "array",
        minItems: 1,
        items: planUpdateItemSchema,
      },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            plans: { type: "array", items: planSchema },
          },
        },
      },
    },
  },
};

module.exports = {
  listPlansSchema,
  updatePlansSchema,
};
