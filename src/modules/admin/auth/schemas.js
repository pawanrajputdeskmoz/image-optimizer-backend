const { successEnvelope } = require("../shared/common.schema");

const loginSchema = {
  body: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email", minLength: 1 },
      password: { type: "string", minLength: 1 },
    },
  },
  response: { 200: successEnvelope, 401: successEnvelope },
};

const meSchema = {
  response: { 200: successEnvelope, 401: successEnvelope },
};

module.exports = { loginSchema, meSchema };
