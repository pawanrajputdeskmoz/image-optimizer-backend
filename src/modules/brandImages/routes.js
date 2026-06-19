const { authStore } = require("../../middlewares/auth");
const {
  fetchAllBrands,
  optimizeBrand,
  getBrandPreviewImgData,
  restoreBrand,
  bulkBrandOptimizationCheckbox,
  bulkBrandOptimizationAll,
  bulkRestoreBrandsCheckbox,
  bulkRestoreBrandsAll,
  getBrandOptimizationJob,
} = require("./controller");
const {
  fetchAllBrandsSchema,
  optimizeBrandBodySchema,
  optimizeBrandSchema,
  getBrandPreviewImgDataSchema,
  restoreBrandSchema,
  bulkBrandOptimizeCheckboxSchema,
  bulkBrandOptimizeAllSchema,
  bulkRestoreBrandCheckboxSchema,
  bulkRestoreBrandAllSchema,
  getBrandJobSchema,
} = require("./schemas");

async function brandImagesRoutes(app) {
  app.post("/get-all-brands", {
    preHandler: authStore,
    schema: fetchAllBrandsSchema,
  }, fetchAllBrands);

  app.post("/restore-brand", {
    preHandler: authStore,
    schema: restoreBrandSchema,
  }, restoreBrand);

  app.post("/get-brand-preview-img-data", {
    preHandler: authStore,
    schema: getBrandPreviewImgDataSchema,
  }, getBrandPreviewImgData);

  // Single brand optimization — brand_id in body
  app.post("/optimize-brand", {
    preHandler: authStore,
    schema: optimizeBrandBodySchema,
  }, optimizeBrand);

  // Single brand optimization — brand_id in URL param
  app.post("/optimize-brand/:brand_id", {
    preHandler: authStore,
    schema: optimizeBrandSchema,
  }, optimizeBrand);

  // Checkbox bulk optimization
  app.post("/bulk-optimize-brands-checkbox", {
    preHandler: authStore,
    schema: bulkBrandOptimizeCheckboxSchema,
  }, bulkBrandOptimizationCheckbox);

  /** Full-store bulk: fetch all brands (chunked) → queues a `bulk` job */
  app.post("/bulk-optimize-brands-all", {
    preHandler: authStore,
    schema: bulkBrandOptimizeAllSchema,
  }, bulkBrandOptimizationAll);

  // Checkbox bulk restore
  app.post("/bulk-restore-brands-checkbox", {
    preHandler: authStore,
    schema: bulkRestoreBrandCheckboxSchema,
  }, bulkRestoreBrandsCheckbox);

  /** Full-store bulk restore: all restorable optimized brand images */
  app.post("/bulk-restore-brands-all", {
    preHandler: authStore,
    schema: bulkRestoreBrandAllSchema,
  }, bulkRestoreBrandsAll);

  // Job status polling
  app.get("/brand-job/:job_uuid", {
    preHandler: authStore,
    schema: getBrandJobSchema,
  }, getBrandOptimizationJob);
}

module.exports = { brandImagesRoutes };
