const { getServerHealth, getServerHealthLite, getRecentAlerts } = require("./service");
const { sendSuccess } = require("../utils/response");

exports.getHealth = async (req, reply) => {
  const data = await getServerHealth();
  return sendSuccess(reply, {
    message:
      data.status === "ok" ? "Server is healthy" : "Server health degraded",
    data,
  });
};

exports.getRecentAlerts = async (req, reply) => {
  const { limit } = req.query || {};
  const data = await getRecentAlerts(limit);
  return sendSuccess(reply, {
    message: "Recent alerts",
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
