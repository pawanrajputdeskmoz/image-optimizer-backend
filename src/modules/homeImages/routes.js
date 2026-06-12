const { authStore } = require("../../middlewares/auth");
const {
  optimizeHomeBannerImageSingle,
  getHomeImages,
} = require("./controller");
const {
  optimizeHomeBannerImageSchema,
  getHomeImagesSchema,
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
}

module.exports = { homeImagesRoutes };
