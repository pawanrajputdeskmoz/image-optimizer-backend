const { successEnvelope } = require("../shared/common.schema");

const getWorkersOverviewSchema = {
  response: { 200: successEnvelope },
};

const listQueuesSchema = {
  response: { 200: successEnvelope },
};

const getQueueDetailSchema = {
  params: {
    type: "object",
    required: ["queueName"],
    properties: {
      queueName: { type: "string", minLength: 1 },
    },
  },
  response: { 200: successEnvelope },
};

module.exports = {
  getWorkersOverviewSchema,
  listQueuesSchema,
  getQueueDetailSchema,
};
