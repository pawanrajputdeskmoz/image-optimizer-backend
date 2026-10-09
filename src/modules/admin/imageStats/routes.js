const { listImageStats } = require("./controller");
const { listImageStatsSchema } = require("./schemas");

async function imageStatsRoutes(app) {
  app.get("/", { schema: listImageStatsSchema }, listImageStats);
}

module.exports = { imageStatsRoutes };
