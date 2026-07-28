const createSubscriptionSchema = {
  body: {
    type: "object",
    required: ["planId"],
    properties: {
      planId: { type: "string", minLength: 1 },
    },
  },
};

const subscriptionStatusSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 1 },
    },
  },
};

module.exports = {
  createSubscriptionSchema,
  subscriptionStatusSchema,
};
