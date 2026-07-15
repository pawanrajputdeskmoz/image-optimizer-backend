const { successEnvelope } = require("../shared/common.schema");

const getDashboardSchema = {
  response: { 200: successEnvelope },
};

const getDashboardStatsSchema = {
  response: { 200: successEnvelope },
};

const getDashboardCardsSchema = {
  response: { 200: successEnvelope },
};

module.exports = {
  getDashboardSchema,
  getDashboardStatsSchema,
  getDashboardCardsSchema,
};
