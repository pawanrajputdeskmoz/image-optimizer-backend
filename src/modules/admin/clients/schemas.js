const { paginationQuery, successEnvelope, storeHashParam } = require("../shared/common.schema");

const listClientsSchema = {
  querystring: {
    ...paginationQuery,
    properties: {
      ...paginationQuery.properties,
      search: { type: "string" },
      install_status: {
        type: "string",
        enum: ["installed", "uninstalled", "unknown"],
      },
    },
  },
  response: { 200: successEnvelope },
};

const getClientInfoSchema = {
  params: storeHashParam,
  response: { 200: successEnvelope },
};

const getClientSchema = {
  params: storeHashParam,
  response: { 200: successEnvelope },
};

const listClientJobsSchema = {
  params: storeHashParam,
  querystring: {
    ...paginationQuery,
    properties: {
      ...paginationQuery.properties,
      status: { type: "string" },
      job_type: { type: "string" },
    },
  },
  response: { 200: successEnvelope },
};

const getJobSchema = {
  params: {
    type: "object",
    required: ["storeHash", "jobUuid"],
    properties: {
      storeHash: { type: "string" },
      jobUuid: { type: "string" },
    },
  },
  response: { 200: successEnvelope },
};

const resetStuckJobItemsSchema = {
  params: {
    type: "object",
    required: ["storeHash", "jobUuid"],
    properties: {
      storeHash: { type: "string" },
      jobUuid: { type: "string" },
    },
  },
  response: { 200: successEnvelope },
};

const clientPlanBodySchema = {
  type: "object",
  required: ["base_plan_slug"],
  properties: {
    base_plan_slug: { type: "string", minLength: 1 },
  },
};

const getClientPlanSchema = {
  params: storeHashParam,
  response: { 200: successEnvelope },
};

const upsertClientPlanSchema = {
  params: storeHashParam,
  body: clientPlanBodySchema,
  response: { 200: successEnvelope },
};

const deleteClientPlanSchema = {
  params: storeHashParam,
  response: { 200: successEnvelope },
};

module.exports = {
  listClientsSchema,
  getClientInfoSchema,
  getClientSchema,
  listClientJobsSchema,
  getJobSchema,
  resetStuckJobItemsSchema,
  getClientPlanSchema,
  upsertClientPlanSchema,
  deleteClientPlanSchema,
};
