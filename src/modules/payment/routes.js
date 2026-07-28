const { authStore } = require("../../middlewares/auth");
const {
  paymentHistoryHandler,
  createSubscriptionHandler,
  paypalWebhookHandler,
  subscriptionStatusHandler,
} = require("./controller");
const {
  createSubscriptionSchema,
  subscriptionStatusSchema,
} = require("./schemas");

async function paymentRoutes(app) {
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
