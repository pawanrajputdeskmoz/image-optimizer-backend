const {
  listClients,
  getClient,
  getClientInfo,
  listClientJobs,
  getJob,
  resetStuckJobItems,
  getClientPlan,
  upsertClientPlan,
  deleteClientPlan,
} = require("./controller");
const {
  listClientsSchema,
  getClientInfoSchema,
  getClientSchema,
  listClientJobsSchema,
  getJobSchema,
  resetStuckJobItemsSchema,
  getClientPlanSchema,
  upsertClientPlanSchema,
  deleteClientPlanSchema,
} = require("./schemas");

async function clientsRoutes(app) {
  app.get("/", { schema: listClientsSchema }, listClients);
  app.get("/:storeHash/plan", { schema: getClientPlanSchema }, getClientPlan);
  app.put("/:storeHash/plan", { schema: upsertClientPlanSchema }, upsertClientPlan);
  app.delete("/:storeHash/plan", { schema: deleteClientPlanSchema }, deleteClientPlan);
  app.get("/:storeHash/info", { schema: getClientInfoSchema }, getClientInfo);
  app.get("/:storeHash", { schema: getClientSchema }, getClient);
  app.get("/:storeHash/jobs", { schema: listClientJobsSchema }, listClientJobs);
  app.get("/:storeHash/jobs/:jobUuid", { schema: getJobSchema }, getJob);
  app.post(
    "/:storeHash/jobs/:jobUuid/reset-stuck",
    { schema: resetStuckJobItemsSchema },
    resetStuckJobItems
  );
}

module.exports = { clientsRoutes };
