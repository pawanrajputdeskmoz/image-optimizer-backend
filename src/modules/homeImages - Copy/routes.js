const { authStore } = require("../../middlewares/auth");
const {
  optimizeHomeBannerImageSingle,
  getHomeImages,
  restoreHomeImage,
  bulkOptimizeHomeImagesCheckbox,
  bulkOptimizeHomeImagesAll,
  bulkRestoreHomeImagesAll,
  bulkRestoreHomeImagesCheckbox,
  getHomeOptimizationJob,
} = require("./controller");
const {
  optimizeHomeBannerImageSchema,
  getHomeImagesSchema,
  restoreHomeImageSchema,
  bulkOptimizeHomeImagesCheckboxSchema,
  bulkOptimizeHomeImagesAllSchema,
  bulkRestoreHomeImagesCheckboxSchema,
  bulkRestoreHomeImagesAllSchema,
  getHomeJobSchema,
} = require("./schemas");

async function homeImagesRoutes(app) {
  app.get(
    "/home-images",
    {
      preHandler: authStore,
      schema: getHomeImagesSchema,
    },
    getHomeImages
  );

  app.post(
    "/home-banner/optimize",
    {
      preHandler: authStore,
      schema: optimizeHomeBannerImageSchema,
    },
    optimizeHomeBannerImageSingle
  );

  app.post(
    "/home-banner/restore",
    {
      preHandler: authStore,
      schema: restoreHomeImageSchema,
    },
    restoreHomeImage
  );

  app.post(
    "/home-banner/bulk-optimize-checkbox",
    {
      preHandler: authStore,
      schema: bulkOptimizeHomeImagesCheckboxSchema,
    },
    bulkOptimizeHomeImagesCheckbox
  );

  app.post(
    "/home-banner/bulk-optimize-all",
    {
      preHandler: authStore,
      schema: bulkOptimizeHomeImagesAllSchema,
    },
    bulkOptimizeHomeImagesAll
  );

  app.post(
    "/home-banner/bulk-restore-all",
    {
      preHandler: authStore,
      schema: bulkRestoreHomeImagesAllSchema,
    },
    bulkRestoreHomeImagesAll
  );

  app.post(
    "/home-banner/bulk-restore-checkbox",
    {
      preHandler: authStore,
      schema: bulkRestoreHomeImagesCheckboxSchema,
    },
    bulkRestoreHomeImagesCheckbox
  );

  app.get(
    "/home-job/:job_uuid",
    {
      preHandler: authStore,
      schema: getHomeJobSchema,
    },
    getHomeOptimizationJob
  );
}

module.exports = { homeImagesRoutes };
