const paginationQuery = {
  type: "object",
  properties: {
    page: { type: ["integer", "string"], minimum: 1 },
    limit: { type: ["integer", "string"], minimum: 1, maximum: 100 },
  },
};

const successEnvelope = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    data: { type: "object", additionalProperties: true },
  },
};

const storeHashParam = {
  type: "object",
  required: ["storeHash"],
  properties: {
    storeHash: { type: "string", minLength: 1 },
  },
};

const jobUuidParam = {
  type: "object",
  required: ["jobUuid"],
  properties: {
    jobUuid: { type: "string", minLength: 1 },
  },
};

module.exports = {
  paginationQuery,
  successEnvelope,
  storeHashParam,
  jobUuidParam,
};
