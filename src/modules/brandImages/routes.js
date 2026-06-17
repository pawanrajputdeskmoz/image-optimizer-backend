const { authStore } = require("../../middlewares/auth");
const {
  fetchAllBrands,
  optimizeBrand,
  getBrandPreviewImgData,
  restoreBrand,
  bulkBrandOptimizationCheckbox,
  getBrandOptimizationJob,
} = require("./controller");
const {
  fetchAllBrandsSchema,
  optimizeBrandBodySchema,
  optimizeBrandSchema,
  getBrandPreviewImgDataSchema,
  restoreBrandSchema,
  bulkBrandOptimizeCheckboxSchema,
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

  // Job status polling
  app.get("/brand-job/:job_uuid", {
    preHandler: authStore,
    schema: getBrandJobSchema,
  }, getBrandOptimizationJob);
}

module.exports = { brandImagesRoutes };
