const { authStore } = require("../../middlewares/auth");
const {
  fetchAllCategories,
  optimizeCategory,
  getCategoryPreviewImgData,
  restoreCategory,
  bulkCategoryOptimizationCheckbox,
  getCategoryOptimizationJob,
} = require("./controller");
const {
  fetchAllCategoriesSchema,
  optimizeCategorySchema,
  optimizeCategoryBodySchema,
  getCategoryPreviewImgDataSchema,
  restoreCategorySchema,
  bulkCategoryOptimizeCheckboxSchema,
  getCategoryJobSchema,
} = require("./schemas");

async function categoryImagesRoutes(app) {
  app.post("/get-all-categories", {
    preHandler: authStore,
    schema: fetchAllCategoriesSchema,
  }, fetchAllCategories);

  app.post("/optimize-category", {
    preHandler: authStore,
    schema: optimizeCategoryBodySchema,
  }, optimizeCategory);

  app.post("/optimize-category/:category_id", {
    preHandler: authStore,
    schema: optimizeCategorySchema,
  }, optimizeCategory);

  app.post("/get-category-preview-img-data", {
    preHandler: authStore,
    schema: getCategoryPreviewImgDataSchema,
  }, getCategoryPreviewImgData);

  app.post("/restore-category", {
    preHandler: authStore,
    schema: restoreCategorySchema,
  }, restoreCategory);

  /** Checkbox-selected category images → queues a `checkBox` job */
  app.post("/bulk-optimize-categories-checkbox", {
    preHandler: authStore,
    schema: bulkCategoryOptimizeCheckboxSchema,
  }, bulkCategoryOptimizationCheckbox);

  /** Poll status of a category optimization job by job_uuid */
  app.get("/category-job/:job_uuid", {
    preHandler: authStore,
    schema: getCategoryJobSchema,
  }, getCategoryOptimizationJob);
}

module.exports = { categoryImagesRoutes };
