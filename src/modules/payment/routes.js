const { authStore } = require("../../middlewares/auth");
const {
  createOrderHandler,
  captureOrderHandler,
  paymentHistoryHandler,
  createSubscriptionHandler,
  paypalWebhookHandler,
  subscriptionStatusHandler,
} = require("./controller");
const {
  createOrderSchema,
  captureOrderSchema,
  createSubscriptionSchema,
  subscriptionStatusSchema,
} = require("./schemas");

async function paymentRoutes(app) {
  app.post(
    "/create-order",
    { preHandler: authStore, schema: createOrderSchema },
    createOrderHandler
  );

  app.post(
    "/capture-order",
    { preHandler: authStore, schema: captureOrderSchema },
    captureOrderHandler
  );

  app.get("/history", { preHandler: authStore }, paymentHistoryHandler);

  app.post(
    "/create-subscription",
    { preHandler: authStore, schema: createSubscriptionSchema },
    createSubscriptionHandler
  );

  app.post("/webhook", paypalWebhookHandler);

  app.get(
    "/subscription-status/:id",
    { preHandler: authStore, schema: subscriptionStatusSchema },
    subscriptionStatusHandler
  );
}

module.exports = { paymentRoutes };
