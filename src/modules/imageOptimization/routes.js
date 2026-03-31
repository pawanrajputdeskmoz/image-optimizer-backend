const { optimizeImage } = require("./controller");

async function imageOptimizationRoutes(app) {
  app.post("/get-all-products", optimizeImage);


  app.get("/hello", async () => {
    return { ok: true, message: "image-optimizer is up" };
  });
}

module.exports = { imageOptimizationRoutes };

