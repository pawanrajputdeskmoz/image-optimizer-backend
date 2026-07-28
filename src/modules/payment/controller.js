const {
  listPaymentHistory,
  createSubscription,
  handlePaypalWebhook,
  getSubscriptionStatus,
} = require("./service");

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
    const { error, statusCode, status, plan_slug, plan_name } = await getSubscriptionStatus(
      req.storeHash,
      req.params.id
    );
    if (error) {
      return reply.status(statusCode || 400).send({ success: false, message: error });
    }
    return reply.send({ status, plan_slug, plan_name });
  } catch (err) {
    console.error("[subscriptionStatusHandler]", err);
    return reply.status(500).send({ success: false, message: err.message || "Status check failed" });
  }
};
