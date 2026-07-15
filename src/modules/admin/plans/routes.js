const { listPlans, updatePlans } = require("./controller");
const { listPlansSchema, updatePlansSchema } = require("./schemas");

async function plansRoutes(app) {
  app.get("/", { schema: listPlansSchema }, listPlans);
  app.put("/", { schema: updatePlansSchema }, updatePlans);
}

module.exports = { plansRoutes };
