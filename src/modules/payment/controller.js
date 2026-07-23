const {
  createPlanOrder,
  capturePlanOrder,
  listPaymentHistory,
  createSubscription,
  handlePaypalWebhook,
  getSubscriptionStatus,
} = require("./service");

exports.createOrderHandler = async (req, reply) => {
  try {
    const { error, code, statusCode, paypalOrderId, approvalUrl } = await createPlanOrder(
      req.storeHash,
      req.body?.planId,
      req.currentUser?._id
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

exports.createSubscriptionHandler = async (req, reply) => {
  try {
    const { error, code, statusCode, data, subscriptionId, approvalUrl } = await createSubscription(
      req.storeHash,
      req.body?.planId
    );

    if (error) {
      return reply.status(statusCode || 400).send({
        success: false,
        message: error,
        code,
        ...(data ? { data } : {}),
      });
    }

    return reply.status(statusCode || 201).send({
      success: true,
      subscriptionId,
      approvalUrl,
      data,
    });
  } catch (err) {
    console.error("[createSubscriptionHandler]", err);
    return reply.status(500).send({
      success: false,
      message: err.message || "Failed to create subscription",
    });
  }
};

exports.paypalWebhookHandler = async (req, reply) => {
  try {
    const { error, statusCode, received } = await handlePaypalWebhook(req.headers, req.body);
    if (error) {
      return reply.status(statusCode || 400).send({ error });
    }
    return reply.send({ received: Boolean(received) });
  } catch (err) {
    console.error("[paypalWebhookHandler]", err);
    return reply.status(500).send({ error: err.message || "Webhook failed" });
  }
};

exports.subscriptionStatusHandler = async (req, reply) => {
  try {
    const { error, statusCode, status } = await getSubscriptionStatus(
      req.storeHash,
      req.params.id
    );
    if (error) {
      return reply.status(statusCode || 400).send({ success: false, message: error });
    }
    return reply.send({ status });
  } catch (err) {
    console.error("[subscriptionStatusHandler]", err);
    return reply.status(500).send({ success: false, message: err.message || "Status check failed" });
  }
};
