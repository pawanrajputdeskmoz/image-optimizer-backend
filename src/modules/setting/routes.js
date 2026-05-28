const {
  getStoreOptimizationSettings,
  upsertStoreOptimizationSettings,
} = require("./controller");
const {
  getStoreOptimizationSettingsSchema,
  upsertStoreOptimizationSettingsSchema,
} = require("./schemas");
const { authStore } = require("../../middlewares/auth");

async function settingRoutes(app) {
  app.get(
    "/",
    {
      preHandler: authStore,
      schema: getStoreOptimizationSettingsSchema,
    },
    getStoreOptimizationSettings
  );

  app.put(
    "/",
    {
      preHandler: authStore,
      schema: upsertStoreOptimizationSettingsSchema,
    },
    upsertStoreOptimizationSettings
  );
}

module.exports = { settingRoutes };
