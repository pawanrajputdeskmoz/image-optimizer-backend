const { authAdmin } = require("../../../middlewares/adminAuth");
const { authRoutes } = require("../auth/routes");
const { dashboardRoutes } = require("../dashboard/routes");
const { clientsRoutes } = require("../clients/routes");
const { workersRoutes } = require("../workers/routes");
const { logsRoutes } = require("../logs/routes");
const { healthPublicRoutes } = require("../health/publicRoutes");
const { healthRoutes } = require("../health/routes");
const { plansRoutes } = require("../plans/routes");

async function adminRoutes(app) {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(healthPublicRoutes, { prefix: "/health" });

  await app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", authAdmin);

    await protectedApp.register(healthRoutes, { prefix: "/health" });
    await protectedApp.register(dashboardRoutes, { prefix: "/dashboard" });
    await protectedApp.register(clientsRoutes, { prefix: "/clients" });
    await protectedApp.register(workersRoutes, { prefix: "/workers" });
    await protectedApp.register(logsRoutes, { prefix: "/logs" });
    await protectedApp.register(plansRoutes, { prefix: "/plans" });
  });
}

module.exports = { adminRoutes };
