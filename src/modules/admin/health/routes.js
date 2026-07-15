const { getHealth, getRecentAlerts } = require("./controller");
const { getHealthSchema, getRecentAlertsSchema } = require("./schemas");

async function healthRoutes(app) {
  app.get("/alerts", { schema: getRecentAlertsSchema }, getRecentAlerts);
  app.get("/", { schema: getHealthSchema }, getHealth);
  app.get("/server", { schema: getHealthSchema }, getHealth);
}

module.exports = { healthRoutes };
