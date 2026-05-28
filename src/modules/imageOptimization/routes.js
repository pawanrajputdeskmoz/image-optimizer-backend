const {
  fetchAllProducts,
  singleImageOptimization,
  bulkImageOptimization,
  bulkImageOptimizationCheckbox,
  getOptimizationJob,
  getPreviewImgData,
  updateAltText,
  restoreImage,
} = require("./controller");
const {
  singleImageOptimizationSchema,
  bulkImageOptimizationSchema,
  bulkImageOptimizationAllSchema,
  getPreviewImgDataSchema,
  updateAltTextSchema,
  restoreImageSchema,
} = require("./schemas");
const { authStore } = require("../../middlewares/auth");

async function imageOptimizationRoutes(app) {
  app.post("/get-all-products", {
    preHandler: authStore,
  }, fetchAllProducts);

  app.post(
    "/single-image-optimization/:image_id",
    {
      preHandler: authStore,
      schema: singleImageOptimizationSchema,
    },
    singleImageOptimization
  );

  app.post(
    "/bulk-image-optimization",
    {
      preHandler: authStore,
      schema: bulkImageOptimizationSchema,
    },
    bulkImageOptimizationCheckbox
  );

  app.post(
    "/bulk-image-optimization-all",
    {
      preHandler: authStore,
      schema: bulkImageOptimizationAllSchema,
    },
    bulkImageOptimization
  );

  app.get(
    "/optimization-job/:job_uuid",
    { preHandler: authStore },
    getOptimizationJob
  );

  app.post(
    "/get-preview-img-data",
    {
      preHandler: authStore,
      schema: getPreviewImgDataSchema,
    },
    getPreviewImgData
  );

  app.patch(
    "/update-alt-text/:image_id",
    {
      preHandler: authStore,
      schema: updateAltTextSchema,
    },
    updateAltText
  );

  app.post(
    "/restore-image/:image_id",
    {
      preHandler: authStore,
      schema: restoreImageSchema,
    },
    restoreImage
  );
}

module.exports = { imageOptimizationRoutes };
