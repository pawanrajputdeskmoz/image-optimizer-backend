const {
  createPlanOrder,
  capturePlanOrder,
  listPaymentHistory,
} = require("./service");

exports.createOrderHandler = async (req, reply) => {
  try {
    const { error, code, statusCode, paypalOrderId, approvalUrl } = await createPlanOrder(
      req.storeHash,
      req.body?.planId
    );

    if (error) {
      return reply.status(statusCode || 400).send({ success: false, message: error, code });
    }

    return reply.send({ success: true, paypalOrderId, approvalUrl });
  } catch (err) {
    console.error("[createOrderHandler]", err);
    return reply.status(500).send({ success: false, message: err.message || "Failed to create payment" });
  }
};

exports.captureOrderHandler = async (req, reply) => {
  try {
    const orderId = req.body?.paypalOrderId || req.body?.orderID;
    const { error, code, statusCode, message, subscription } = await capturePlanOrder(
      req.storeHash,
      orderId
    );

    if (error) {
      return reply.status(statusCode || 400).send({ success: false, message: error, code });
    }

    return reply.send({ success: true, message, subscription });
  } catch (err) {
    console.error("[captureOrderHandler]", err);
    return reply.status(500).send({ success: false, message: err.message || "Failed to capture payment" });
  }
};

exports.paymentHistoryHandler = async (req, reply) => {
  try {
    const data = await listPaymentHistory(req.storeHash);
    return reply.send({ success: true, message: "Payment history loaded", data });
  } catch (err) {
    console.error("[paymentHistoryHandler]", err);
    return reply.status(500).send({ success: false, message: err.message || "Failed to load payment history" });
  }
};
