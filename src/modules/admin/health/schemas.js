const { successEnvelope } = require("../shared/common.schema");

const getHealthSchema = {
  response: { 200: successEnvelope },
};

const getHealthLiteSchema = {
  response: { 200: successEnvelope },
};

const getRecentAlertsSchema = {
  querystring: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  },
  response: { 200: successEnvelope },
};

module.exports = {
  getHealthSchema,
  getHealthLiteSchema,
  getRecentAlertsSchema,
};
