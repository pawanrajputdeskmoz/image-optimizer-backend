const { paginationQuery, successEnvelope } = require("../shared/common.schema");

const getLogsSummarySchema = {
  response: { 200: successEnvelope },
};

const listLogSourcesSchema = {
  response: { 200: successEnvelope },
};

const listLogsSchema = {
  querystring: {
    ...paginationQuery,
    properties: {
      ...paginationQuery.properties,
      source: {
        type: "string",
        enum: ["optimization", "webhook", "category_webhook"],
      },
      store_hash: { type: "string" },
      job_uuid: { type: "string" },
      trace_id: { type: "string" },
      log_type: { type: "string", enum: ["info", "warning", "error"] },
      step: { type: "string" },
    },
  },
  response: { 200: successEnvelope },
};

const getLogTraceSchema = {
  params: {
    type: "object",
    required: ["source", "traceId"],
    properties: {
      source: {
        type: "string",
        enum: ["webhook", "category_webhook"],
      },
      traceId: { type: "string", minLength: 1 },
    },
  },
  response: { 200: successEnvelope },
};

const getRecentErrorLogsSchema = {
  querystring: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  },
  response: { 200: successEnvelope },
};

module.exports = {
  getLogsSummarySchema,
  listLogSourcesSchema,
  listLogsSchema,
  getLogTraceSchema,
  getRecentErrorLogsSchema,
};
