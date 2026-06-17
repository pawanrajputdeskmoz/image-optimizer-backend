const { getHomeImagesController } = require("./controller");
const { getHomeImagesSchema } = require("./schemas");
const { authStore } = require("../../middlewares/auth");


async function homeImagesRoutes(fastify) {
  fastify.post(
    "/get-home-images",
    {
      preHandler: authStore,
      schema: getHomeImagesSchema,
    },
    getHomeImagesController
  );
}

module.exports = { homeImagesRoutes };