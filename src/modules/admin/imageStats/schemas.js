const { paginationQuery, successEnvelope } = require("../shared/common.schema");

const listImageStatsSchema = {
  querystring: {
    ...paginationQuery,
    properties: {
      ...paginationQuery.properties,
      store_hash: { type: "string" },
      source_type: { type: "string" },
      status: { type: "string" },
      date_from: { type: "string" },
      date_to: { type: "string" },
    },
  },
  response: { 200: successEnvelope },
};

module.exports = {
  listImageStatsSchema,
};
