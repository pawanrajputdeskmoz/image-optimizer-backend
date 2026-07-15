const {
  getDashboard,
  getDashboardStats,
  getDashboardCards,
} = require("./controller");
const {
  getDashboardSchema,
  getDashboardStatsSchema,
  getDashboardCardsSchema,
} = require("./schemas");

async function dashboardRoutes(app) {
  app.get("/cards", { schema: getDashboardCardsSchema }, getDashboardCards);
  app.get("/stats", { schema: getDashboardStatsSchema }, getDashboardStats);
  app.get("/", { schema: getDashboardSchema }, getDashboard);
}

module.exports = { dashboardRoutes };
