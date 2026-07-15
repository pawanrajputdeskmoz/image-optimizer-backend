const { installApp, uninstallApp, loadBigComApp, handleProductWebhook } = require("./controller");
const { verifyBigCommerceWebhook } = require("../../middlewares/bigCommerceWebhook");

async function installationRoutes(app) {
  app.get("/install", installApp);

  app.get("/uninstall", uninstallApp);

  app.post("/load-application", loadBigComApp);

  app.post("/webhook", { preHandler: verifyBigCommerceWebhook }, handleProductWebhook);
}

module.exports = { installationRoutes };
