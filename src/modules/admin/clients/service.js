const ImageJob = require("../../../models/ImageJob");
const ImageJobItem = require("../../../models/ImageJobItem");
const ImageStatus = require("../../../models/ImageStatus");
const StoreImageStat = require("../../../models/StoreImageStat");
const StoreOptimizationSettings = require("../../../models/StoreOptimizationSettings");
const StoreWebhook = require("../../../models/StoreWebhook");
const StoreCategoryWebhook = require("../../../models/StoreCategoryWebhook");
const User = require("../../../models/User");
const { getOptimizationJobStatus } = require("../../imageOptimization/services");
const {
  getEffectivePlanForStore,
  getClientPlanByStore,
  upsertClientPlan,
  deleteClientPlan,
  listPlans,
} = require("../../plans/service");
const { buildPagination, resolvePagination } = require("../utils/pagination");

const CLIENT_PROFILE_FIELDS = {
  store_hash: 1,
  store_id: 1,
  store_name: 1,
  email: 1,
  username: 1,
  provider: 1,
  role: 1,
  currency: 1,
  storeUrl: 1,
  primaryDomain: 1,
  installStatus: 1,
  hasCompletedSetup: 1,
  selectedPlan: 1,
  lastInstalledAt: 1,
  lastUninstalledAt: 1,
  lastLogin: 1,
  created_at: 1,
  updated_at: 1,
};

function formatClientProfile(user) {
  if (!user) return null;
  const profile = {};
  for (const key of Object.keys(CLIENT_PROFILE_FIELDS)) {
    if (user[key] !== undefined) profile[key] = user[key];
  }
  return profile;
}

exports.listClients = async ({
  page = 1,
  limit = 20,
  search = "",
  installStatus = null,
}) => {
  const { page: resolvedPage, limit: resolvedLimit, skip } = resolvePagination(
    { page, limit }
  );

  const filter = {};
  if (installStatus) {
    filter.installStatus = installStatus;
  }
  if (search && String(search).trim()) {
    const term = String(search).trim();
    filter.$or = [
      { store_hash: { $regex: term, $options: "i" } },
      { store_name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
    ];
  }

  const [clients, total] = await Promise.all([
    User.find(filter)
      .select(CLIENT_PROFILE_FIELDS)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(resolvedLimit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    clients: clients.map(formatClientProfile),
    pagination: buildPagination(resolvedPage, resolvedLimit, total),
  };
};

exports.getClientInformation = async (storeHash) => {
  const client = await User.findOne({ store_hash: storeHash })
    .select(CLIENT_PROFILE_FIELDS)
    .lean();

  if (!client) {
    return { error: "Client not found", data: null };
  }

  const [
    stats,
    settings,
    productWebhooks,
    categoryWebhooks,
    recentJobs,
    activeJob,
    jobStatusCounts,
    imageStatusCounts,
    stuckJobItems,
    totalJobs,
  ] = await Promise.all([
    StoreImageStat.findOne({ store_hash: storeHash }).lean(),
    StoreOptimizationSettings.find({ store_hash: storeHash })
      .sort({ channel_id: 1 })
      .lean(),
    StoreWebhook.find({ store_hash: storeHash })
      .select({
        hook_id: 1,
        scope: 1,
        destination: 1,
        is_active: 1,
        registered_at: 1,
        created_at: 1,
      })
      .lean(),
    StoreCategoryWebhook.find({ store_hash: storeHash })
      .select({
        hook_id: 1,
        scope: 1,
        destination: 1,
        is_active: 1,
        registered_at: 1,
        created_at: 1,
      })
      .lean(),
    ImageJob.find({ store_hash: storeHash })
      .sort({ created_at: -1 })
      .limit(5)
      .select({
        job_uuid: 1,
        job_type: 1,
        status: 1,
        total_images: 1,
        queued_images: 1,
        processed_images: 1,
        success_images: 1,
        failed_images: 1,
        skipped_images: 1,
        started_at: 1,
        completed_at: 1,
        created_at: 1,
      })
      .lean(),
    ImageJob.findOne({
      store_hash: storeHash,
      status: { $in: ["pending", "fetching", "processing"] },
    })
      .sort({ created_at: -1 })
      .select({
        job_uuid: 1,
        job_type: 1,
        status: 1,
        total_images: 1,
        queued_images: 1,
        processed_images: 1,
        success_images: 1,
        failed_images: 1,
        skipped_images: 1,
        started_at: 1,
        created_at: 1,
      })
      .lean(),
    ImageJob.aggregate([
      { $match: { store_hash: storeHash } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    ImageStatus.aggregate([
      { $match: { store_hash: storeHash } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    ImageJobItem.countDocuments({
      store_hash: storeHash,
      status: "optimizing",
    }),
    ImageJob.countDocuments({ store_hash: storeHash }),
  ]);

  return {
    error: null,
    data: {
      profile: formatClientProfile(client),
      stats: stats || null,
      settings: settings || [],
      webhooks: {
        product: productWebhooks,
        category: categoryWebhooks,
      },
      jobs: {
        total: totalJobs,
        by_status: Object.fromEntries(
          jobStatusCounts.map((row) => [row._id, row.count])
        ),
        active: activeJob,
        recent: recentJobs,
        stuck_optimizing_items: stuckJobItems,
      },
      images: {
        by_status: Object.fromEntries(
          imageStatusCounts.map((row) => [row._id, row.count])
        ),
      },
    },
  };
};

exports.getClientDetail = async (storeHash) => {
  const [client, stats, recentJobs] = await Promise.all([
    User.findOne({ store_hash: storeHash })
      .select(CLIENT_PROFILE_FIELDS)
      .lean(),
    StoreImageStat.findOne({ store_hash: storeHash }).lean(),
    ImageJob.find({ store_hash: storeHash })
      .sort({ created_at: -1 })
      .limit(10)
      .lean(),
  ]);

  if (!client) {
    return { error: "Client not found", client: null };
  }

  const jobCounts = await ImageJob.aggregate([
    { $match: { store_hash: storeHash } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  return {
    error: null,
    client: formatClientProfile(client),
    stats,
    recent_jobs: recentJobs,
    jobs_by_status: Object.fromEntries(
      jobCounts.map((row) => [row._id, row.count])
    ),
  };
};

exports.listClientJobs = async ({
  storeHash,
  page = 1,
  limit = 20,
  status = null,
  jobType = null,
}) => {
  const { page: resolvedPage, limit: resolvedLimit, skip } = resolvePagination(
    { page, limit }
  );

  const filter = { store_hash: storeHash };
  if (status) filter.status = status;
  if (jobType) filter.job_type = jobType;

  const [jobs, total] = await Promise.all([
    ImageJob.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(resolvedLimit)
      .lean(),
    ImageJob.countDocuments(filter),
  ]);

  return {
    items: jobs,
    pagination: buildPagination(resolvedPage, resolvedLimit, total),
  };
};

exports.getJobDetail = async (jobUuid, storeHash = null) => {
  const { error, job, logs, items } = await getOptimizationJobStatus(
    jobUuid,
    storeHash
  );

  if (error) {
    return { error, job: null, logs: [], items: [], summary: null };
  }

  if (!job) {
    return { error: "Job not found", job: null, logs, items, summary: null };
  }

  const statusCounts = await ImageJobItem.aggregate([
    { $match: { job_uuid: jobUuid } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  return {
    error: null,
    job,
    logs,
    items,
    summary: Object.fromEntries(
      statusCounts.map((row) => [row._id, row.count])
    ),
  };
};

exports.resetStuckJobItems = async (jobUuid, storeHash = null) => {
  const query = { job_uuid: jobUuid };
  if (storeHash) query.store_hash = storeHash;

  const job = await ImageJob.findOne(query).lean();
  if (!job) {
    return { error: "Job not found", modifiedCount: 0 };
  }

  const result = await ImageJobItem.updateMany(
    { job_uuid: jobUuid, status: "optimizing" },
    {
      $set: {
        status: "queued",
        error_message: null,
        started_at: null,
      },
    }
  );

  return {
    error: null,
    modifiedCount: result.modifiedCount || 0,
    job_uuid: jobUuid,
    store_hash: job.store_hash,
  };
};

exports.getClientPlanConfig = async (storeHash) => {
  const client = await User.findOne({ store_hash: storeHash })
    .select({ store_hash: 1, selectedPlan: 1, store_name: 1 })
    .lean();

  if (!client) {
    return { error: "Client not found", data: null };
  }

  const [clientPlan, effectivePlan, globalPlans] = await Promise.all([
    getClientPlanByStore(storeHash),
    getEffectivePlanForStore(storeHash, client.selectedPlan || "free"),
    listPlans({ activeOnly: true }),
  ]);

  return {
    error: null,
    data: {
      store_hash: storeHash,
      store_name: client.store_name || null,
      selected_plan: client.selectedPlan || "free",
      client_plan: clientPlan,
      effective_plan: effectivePlan,
      global_plans: globalPlans,
    },
  };
};

exports.upsertClientPlanConfig = async (storeHash, payload, assignedBy = null) => {
  const result = await upsertClientPlan(storeHash, payload, assignedBy);
  if (result.error) {
    return { error: result.error, data: null };
  }

  return {
    error: null,
    data: {
      client_plan: result.client_plan,
      effective_plan: result.effective_plan,
      resume: result.resume,
    },
  };
};

exports.removeClientPlanConfig = async (storeHash) => {
  const result = await deleteClientPlan(storeHash);
  if (result.error) {
    return { error: result.error, data: null };
  }

  return {
    error: null,
    data: {
      deleted: result.deleted,
      effective_plan: result.effective_plan,
      resume: result.resume,
    },
  };
};
