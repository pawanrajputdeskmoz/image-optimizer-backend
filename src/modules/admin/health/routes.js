const { getHealth } = require("./controller");
const { getHealthSchema } = require("./schemas");

async function healthRoutes(app) {
  app.get("/", { schema: getHealthSchema }, getHealth);
  app.get("/server", { schema: getHealthSchema }, getHealth);
}

module.exports = { healthRoutes };
