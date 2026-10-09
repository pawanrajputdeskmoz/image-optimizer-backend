const { getServerHealth, getServerHealthLite } = require("./service");
const { sendSuccess } = require("../utils/response");

exports.getHealth = async (req, reply) => {
  const data = await getServerHealth();
  return sendSuccess(reply, {
    message:
      data.status === "ok" ? "Server is healthy" : "Server health degraded",
    data,
  });
};

exports.getHealthLite = async (req, reply) => {
  const data = await getServerHealthLite();
  return sendSuccess(reply, {
    message: data.healthy ? "OK" : "Degraded",
    data,
  });
};
