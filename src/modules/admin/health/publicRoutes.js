const { getHealthLite } = require("./controller");
const { getHealthLiteSchema } = require("./schemas");

/** Public lightweight health check only */
async function healthPublicRoutes(app) {
  app.get("/lite", { schema: getHealthLiteSchema }, getHealthLite);
}

module.exports = { healthPublicRoutes };
