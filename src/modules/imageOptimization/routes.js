const { optimizeImage } = require("./controller");

async function imageOptimizationRoutes(app) {
  app.post("/getImageList", async (req, reply) => {
    const result = await optimizeImage(req);
    return reply.send(result);
  });

  app.get("/hello", async () => {
    return { ok: true, message: "image-optimizer is up" };
  });
}

module.exports = { imageOptimizationRoutes };
