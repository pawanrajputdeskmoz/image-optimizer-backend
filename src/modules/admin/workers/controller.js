const {
  getWorkersOverview,
  getQueueDetail,
  listKnownQueues,
} = require("./service");
const { sendSuccess, sendError } = require("../utils/response");

exports.getWorkersOverview = async (req, reply) => {
  const data = await getWorkersOverview();
  return sendSuccess(reply, { message: "Workers overview", data });
};

exports.getQueueDetail = async (req, reply) => {
  const { queueName } = req.params;
  const result = await getQueueDetail(queueName);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, { message: "Queue detail", data: result.queue });
};

exports.listQueues = async (req, reply) => {
  return sendSuccess(reply, {
    message: "Known worker queues",
    data: { queues: listKnownQueues() },
  });
};
