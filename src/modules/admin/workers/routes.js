const {
  getWorkersOverview,
  getQueueDetail,
  listQueues,
} = require("./controller");
const {
  getWorkersOverviewSchema,
  listQueuesSchema,
  getQueueDetailSchema,
} = require("./schemas");

async function workersRoutes(app) {
  app.get("/", { schema: getWorkersOverviewSchema }, getWorkersOverview);
  app.get("/queues", { schema: listQueuesSchema }, listQueues);
  app.get("/queues/:queueName", { schema: getQueueDetailSchema }, getQueueDetail);
}

module.exports = { workersRoutes };
