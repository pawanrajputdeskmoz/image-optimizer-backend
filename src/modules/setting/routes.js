const {
  getStoreOptimizationSettings,
  upsertStoreOptimizationSettings,
  getChannels,
} = require("./controller");
const {
  getStoreOptimizationSettingsSchema,
  upsertStoreOptimizationSettingsSchema,
  getChannelsSchema,
} = require("./schemas");
const { authStore } = require("../../middlewares/auth");

async function settingRoutes(app) {
  app.get(
    "/channels",
    {
      preHandler: authStore,
      schema: getChannelsSchema,
    },
    getChannels
  );

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
