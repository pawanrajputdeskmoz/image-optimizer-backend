const {
  listClients,
  getClientDetail,
  getClientInformation,
  listClientJobs,
  getJobDetail,
  resetStuckJobItems: resetStuckJobItemsService,
  getClientPlanConfig,
  upsertClientPlanConfig,
  removeClientPlanConfig,
} = require("./service");
const { sendSuccess, sendError } = require("../utils/response");

exports.listClients = async (req, reply) => {
  const { page, limit, search, install_status: installStatus } = req.query || {};
  const data = await listClients({ page, limit, search, installStatus });
  return sendSuccess(reply, { message: "Clients list", data });
};

exports.getClientInfo = async (req, reply) => {
  const { storeHash } = req.params;
  const result = await getClientInformation(storeHash);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: "Client information",
    data: result.data,
  });
};

exports.getClient = async (req, reply) => {
  const { storeHash } = req.params;
  const result = await getClientDetail(storeHash);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: "Client detail",
    data: {
      client: result.client,
      stats: result.stats,
      recent_jobs: result.recent_jobs,
      jobs_by_status: result.jobs_by_status,
    },
  });
};

exports.listClientJobs = async (req, reply) => {
  const { storeHash } = req.params;
  const { page, limit, status, job_type: jobType } = req.query || {};

  const client = await getClientDetail(storeHash);
  if (client.error) {
    return sendError(reply, { message: client.error, statusCode: 404 });
  }

  const data = await listClientJobs({
    storeHash,
    page,
    limit,
    status,
    jobType,
  });

  return sendSuccess(reply, { message: "Client jobs", data });
};

exports.getJob = async (req, reply) => {
  const { storeHash, jobUuid } = req.params;
  const result = await getJobDetail(jobUuid, storeHash || null);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: "Job detail",
    data: {
      job: result.job,
      logs: result.logs,
      items: result.items,
      summary: result.summary,
    },
  });
};

exports.resetStuckJobItems = async (req, reply) => {
  const { storeHash, jobUuid } = req.params;
  const result = await resetStuckJobItemsService(jobUuid, storeHash || null);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: `Reset ${result.modifiedCount} stuck item(s) to queued`,
    data: {
      job_uuid: jobUuid,
      store_hash: result.store_hash,
      modified_count: result.modifiedCount,
    },
  });
};

exports.getClientPlan = async (req, reply) => {
  const { storeHash } = req.params;
  const result = await getClientPlanConfig(storeHash);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: "Client plan configuration",
    data: result.data,
  });
};

exports.upsertClientPlan = async (req, reply) => {
  const { storeHash } = req.params;
  const assignedBy = req.adminEmail || req.adminName || null;
  const result = await upsertClientPlanConfig(storeHash, req.body || {}, assignedBy);

  if (result.error) {
    const statusCode = result.error.includes("not found") ? 404 : 400;
    return sendError(reply, { message: result.error, statusCode });
  }

  return sendSuccess(reply, {
    message: "Client plan saved",
    data: result.data,
  });
};

exports.deleteClientPlan = async (req, reply) => {
  const { storeHash } = req.params;
  const result = await removeClientPlanConfig(storeHash);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: result.data.deleted
      ? "Client custom plan removed"
      : "No custom client plan was configured",
    data: result.data,
  });
};
