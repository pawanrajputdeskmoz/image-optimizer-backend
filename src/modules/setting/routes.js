const {
  getStoreOptimizationSettings,
  upsertStoreOptimizationSettings,
  getChannels,
  registerProductCreatedWebhookHandler,
  disableProductCreatedWebhookHandler,
  registerCategoryCreatedWebhookHandler,
  disableCategoryCreatedWebhookHandler,
  getClientDashboardStatsHandler,
  listPlansHandler,
  selectPlanHandler,
  upgradePlanHandler,
  getMonthlyUsageHistoryHandler,
} = require("./controller");
const {
  getStoreOptimizationSettingsSchema,
  upsertStoreOptimizationSettingsSchema,
  getChannelsSchema,
  registerProductCreatedWebhookSchema,
  disableProductCreatedWebhookSchema,
  registerCategoryCreatedWebhookSchema,
  disableCategoryCreatedWebhookSchema,
  getClientDashboardStatsSchema,
  listPlansSchema,
  selectPlanSchema,
  upgradePlanSchema,
  monthlyUsageHistorySchema,
} = require("./schemas");
const { authStore } = require("../../middlewares/auth");

async function settingRoutes(app) {
  app.get(
    "/dashboard-stats",
    {
      preHandler: authStore,
      schema: getClientDashboardStatsSchema,
    },
    getClientDashboardStatsHandler
  );

  app.get(
    "/plans",
    {
      preHandler: authStore,
      schema: listPlansSchema,
    },
    listPlansHandler
  );

  app.post(
    "/select-plan",
    {
      preHandler: authStore,
      schema: selectPlanSchema,
    },
    selectPlanHandler
  );

  app.post(
    "/upgrade-plan",
    {
      preHandler: authStore,
      schema: upgradePlanSchema,
    },
    upgradePlanHandler
  );

  app.get(
    "/monthly-usage",
    {
      preHandler: authStore,
      schema: monthlyUsageHistorySchema,
    },
    getMonthlyUsageHistoryHandler
  );

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

  app.post(
    "/webhooks/product-created",
    {
      preHandler: authStore,
      schema: registerProductCreatedWebhookSchema,
    },
    registerProductCreatedWebhookHandler
  );

  app.delete(
    "/webhooks/product-created",
    {
      preHandler: authStore,
      schema: disableProductCreatedWebhookSchema,
    },
    disableProductCreatedWebhookHandler
  );

  app.post(
    "/webhooks/category-created",
    {
      preHandler: authStore,
      schema: registerCategoryCreatedWebhookSchema,
    },
    registerCategoryCreatedWebhookHandler
  );

  app.delete(
    "/webhooks/category-created",
    {
      preHandler: authStore,
      schema: disableCategoryCreatedWebhookSchema,
    },
    disableCategoryCreatedWebhookHandler
  );
}

module.exports = { settingRoutes };
