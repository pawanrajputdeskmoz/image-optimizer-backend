const {
  listLogs,
  getLogSources,
  getLogsSummary,
  getLogTrace,
  getRecentErrorLogs,
} = require("./service");
const { sendSuccess, sendError } = require("../utils/response");

exports.getLogsSummary = async (req, reply) => {
  const data = await getLogsSummary();
  return sendSuccess(reply, { message: "Logs summary (24h)", data });
};

exports.listLogSources = async (req, reply) => {
  return sendSuccess(reply, {
    message: "Available log sources",
    data: { sources: getLogSources() },
  });
};

exports.listLogs = async (req, reply) => {
  const {
    source = "optimization",
    page,
    limit,
    store_hash: storeHash,
    job_uuid: jobUuid,
    log_type: logType,
    step,
    trace_id: traceId,
  } = req.query || {};

  const result = await listLogs({
    source,
    page,
    limit,
    storeHash,
    jobUuid,
    logType,
    step,
    traceId,
  });

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 400 });
  }

  return sendSuccess(reply, {
    message: `${source} logs`,
    data: {
      source: result.source,
      items: result.items,
      pagination: result.pagination,
    },
  });
};

exports.getRecentErrorLogs = async (req, reply) => {
  const { limit } = req.query || {};
  const data = await getRecentErrorLogs(limit);
  return sendSuccess(reply, {
    message: "Recent error logs",
    data,
  });
};

exports.getLogTrace = async (req, reply) => {
  const { source, traceId } = req.params;
  const result = await getLogTrace(source, traceId);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 400 });
  }

  return sendSuccess(reply, {
    message: "Log trace",
    data: { trace_id: traceId, source, items: result.items },
  });
};
