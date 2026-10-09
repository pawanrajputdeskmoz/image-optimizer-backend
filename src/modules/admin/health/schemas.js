const { successEnvelope } = require("../shared/common.schema");

const getHealthSchema = {
  response: { 200: successEnvelope },
};

const getHealthLiteSchema = {
  response: { 200: successEnvelope },
};

module.exports = {
  getHealthSchema,
  getHealthLiteSchema,
};
