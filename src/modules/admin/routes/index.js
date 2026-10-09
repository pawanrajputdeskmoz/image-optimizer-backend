const { authAdmin } = require("../../../middlewares/adminAuth");
const { authRoutes } = require("../auth/routes");
const { dashboardRoutes } = require("../dashboard/routes");
const { clientsRoutes } = require("../clients/routes");
const { logsRoutes } = require("../logs/routes");
const { healthPublicRoutes } = require("../health/publicRoutes");
const { healthRoutes } = require("../health/routes");
const { plansRoutes } = require("../plans/routes");
const { imageStatsRoutes } = require("../imageStats/routes");

async function adminRoutes(app) {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(healthPublicRoutes, { prefix: "/health" });

  await app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", authAdmin);

    await protectedApp.register(healthRoutes, { prefix: "/health" });
    await protectedApp.register(dashboardRoutes, { prefix: "/dashboard" });
    await protectedApp.register(clientsRoutes, { prefix: "/clients" });
    await protectedApp.register(logsRoutes, { prefix: "/logs" });
    await protectedApp.register(plansRoutes, { prefix: "/plans" });
    await protectedApp.register(imageStatsRoutes, { prefix: "/image-stats" });
  });
}

module.exports = { adminRoutes };
