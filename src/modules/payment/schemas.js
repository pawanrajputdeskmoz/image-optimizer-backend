const createOrderSchema = {
  body: {
    type: "object",
    required: ["planId"],
    properties: {
      planId: { type: "string", minLength: 1 },
    },
  },
};

const captureOrderSchema = {
  body: {
    type: "object",
    properties: {
      paypalOrderId: { type: "string", minLength: 1 },
      orderID: { type: "string", minLength: 1 },
    },
    anyOf: [{ required: ["paypalOrderId"] }, { required: ["orderID"] }],
  },
};

module.exports = {
  createOrderSchema,
  captureOrderSchema,
};
