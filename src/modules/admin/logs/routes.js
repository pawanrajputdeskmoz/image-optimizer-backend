const {
  getLogsSummary,
  listLogSources,
  listLogs,
  getLogTrace,
  getRecentErrorLogs,
} = require("./controller");
const {
  getLogsSummarySchema,
  listLogSourcesSchema,
  listLogsSchema,
  getLogTraceSchema,
  getRecentErrorLogsSchema,
} = require("./schemas");

async function logsRoutes(app) {
  app.get("/summary", { schema: getLogsSummarySchema }, getLogsSummary);
  app.get("/sources", { schema: listLogSourcesSchema }, listLogSources);
  app.get(
    "/recent-errors",
    { schema: getRecentErrorLogsSchema },
    getRecentErrorLogs
  );
  app.get("/", { schema: listLogsSchema }, listLogs);
  app.get("/trace/:source/:traceId", { schema: getLogTraceSchema }, getLogTrace);
}

module.exports = { logsRoutes };
