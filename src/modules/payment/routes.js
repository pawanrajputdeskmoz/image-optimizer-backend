const { authStore } = require("../../middlewares/auth");
const {
  createOrderHandler,
  captureOrderHandler,
  paymentHistoryHandler,
} = require("./controller");
const { createOrderSchema, captureOrderSchema } = require("./schemas");

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
}

module.exports = { paymentRoutes };
