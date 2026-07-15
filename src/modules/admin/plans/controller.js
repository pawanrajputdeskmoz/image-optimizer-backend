const { listPlans, updatePlans } = require("../../plans/service");
const { sendSuccess, sendError } = require("../utils/response");

exports.listPlans = async (req, reply) => {
  const plans = await listPlans();
  return sendSuccess(reply, {
    message: "Plans list",
    data: { plans },
  });
};

exports.updatePlans = async (req, reply) => {
  const plans = req.body?.plans;
  const { error, plans: updated } = await updatePlans(plans);

  if (error) {
    const statusCode = String(error).includes("not found") ? 404 : 400;
    return sendError(reply, { message: error, statusCode });
  }

  return sendSuccess(reply, {
    message: "Plans updated",
    data: { plans: updated },
  });
};
