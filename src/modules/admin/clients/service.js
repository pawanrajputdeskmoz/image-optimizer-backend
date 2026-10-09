const ImageJob = require("../../../models/ImageJob");
const ImageJobItem = require("../../../models/ImageJobItem");
const ImageStatus = require("../../../models/ImageStatus");
const StoreImageStat = require("../../../models/StoreImageStat");
const StoreOptimizationSettings = require("../../../models/StoreOptimizationSettings");
const StoreWebhook = require("../../../models/StoreWebhook");
const StoreCategoryWebhook = require("../../../models/StoreCategoryWebhook");
const ClientPlan = require("../../../models/ClientPlan");
const PaymentHistory = require("../../../models/PaymentHistory");
const User = require("../../../models/User");
const { getOptimizationJobStatus } = require("../../imageOptimization/services");
const {
  getEffectivePlanForStore,
  getClientPlanByStore,
  getStorePlanSlug,
  upsertClientPlan,
  deleteClientPlan,
  listPlans,
} = require("../../plans/service");
const { buildPagination, resolvePagination } = require("../utils/pagination");
const {
  resolveStoreUrl,
  normalizeAbsoluteStoreUrl,
} = require("../../installation/services");

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
  lastInstalledAt: 1,
  lastUninstalledAt: 1,
  lastLogin: 1,
  created_at: 1,
  updated_at: 1,
  signed_payload_url: 1,
};

const PLAN_SLUGS = ["free", "starter", "pro", "enterprise"];
const ACTIVE_JOB_STATUSES = ["pending", "fetching", "processing"];

function formatClientProfile(user) {
  if (!user) return null;
  const profile = {};
  for (const key of Object.keys(CLIENT_PROFILE_FIELDS)) {
    if (user[key] !== undefined) profile[key] = user[key];
  }
  return profile;
}

function normalizePlanSlug(slug) {
  const value = String(slug || "free").trim().toLowerCase();
  return PLAN_SLUGS.includes(value) ? value : "free";
}

function mapClientUiStatus(installStatus, planSlug) {
  if (installStatus === "uninstalled") return "suspended";
  if (installStatus === "installed" && planSlug === "free") return "trial";
  if (installStatus === "installed") return "active";
  return "suspended";
}

function mapStatusFilterToInstall(status) {
  if (status === "installed" || status === "active" || status === "trial") {
    return "installed";
  }
  if (status === "uninstalled" || status === "suspended") return "uninstalled";
  if (status === "unknown") return "unknown";
  return null;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addOneMonth(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date;
}

function resolveNextPaymentAt({
  planSlug,
  subscriptionStatus,
  lastPaymentAt,
  startedAt,
}) {
  if (!planSlug || planSlug === "free") return null;
  if (subscriptionStatus === "cancel") return null;
  const base = lastPaymentAt || startedAt;
  if (!base) return null;
  return addOneMonth(base);
}

async function resolveStoreHashesForPlan(planSlug) {
  const slug = normalizePlanSlug(planSlug);
  const assigned = await ClientPlan.find({ base_plan_slug: slug })
    .select({ store_hash: 1 })
    .lean();
  const assignedHashes = assigned.map((row) => row.store_hash).filter(Boolean);

  if (slug !== "free") {
    return assignedHashes;
  }

  const otherPlans = await ClientPlan.find({
    base_plan_slug: { $ne: "free" },
  })
    .select({ store_hash: 1 })
    .lean();
  const otherHashes = otherPlans.map((row) => row.store_hash).filter(Boolean);

  const freeUsers = await User.find(
    otherHashes.length
      ? { store_hash: { $nin: otherHashes } }
      : {}
  )
    .select({ store_hash: 1 })
    .lean();

  return freeUsers.map((row) => row.store_hash).filter(Boolean);
}

async function enrichClientRows(clients) {
  if (!clients.length) return [];

  const hashes = clients.map((c) => c.store_hash).filter(Boolean);
  const [statsRows, planRows, pendingRows, paymentRows] = await Promise.all([
    StoreImageStat.find({ store_hash: { $in: hashes } }).lean(),
    ClientPlan.find({ store_hash: { $in: hashes } })
      .select({
        store_hash: 1,
        base_plan_slug: 1,
        started_at: 1,
        subscription_status: 1,
        paypal_subscription_id: 1,
      })
      .lean(),
    ImageJob.aggregate([
      {
        $match: {
          store_hash: { $in: hashes },
          status: { $in: ACTIVE_JOB_STATUSES },
        },
      },
      { $group: { _id: "$store_hash", count: { $sum: 1 } } },
    ]),
    PaymentHistory.aggregate([
      {
        $match: {
          store_hash: { $in: hashes },
          status: "COMPLETED",
        },
      },
      { $sort: { paid_at: -1, created_at: -1 } },
      {
        $group: {
          _id: "$store_hash",
          paid_at: { $first: "$paid_at" },
          created_at: { $first: "$created_at" },
        },
      },
    ]),
  ]);

  const statsByHash = new Map(statsRows.map((row) => [row.store_hash, row]));
  const planByHash = new Map(planRows.map((row) => [row.store_hash, row]));
  const pendingByHash = new Map(
    pendingRows.map((row) => [row._id, row.count || 0])
  );
  const paymentByHash = new Map(
    paymentRows.map((row) => [
      row._id,
      row.paid_at || row.created_at || null,
    ])
  );

  return clients.map((user) => {
    const stats = statsByHash.get(user.store_hash) || {};
    const planRow = planByHash.get(user.store_hash) || {};
    const plan = normalizePlanSlug(planRow.base_plan_slug);
    const lastPaymentAt = paymentByHash.get(user.store_hash) || null;
    const nextPaymentAt = resolveNextPaymentAt({
      planSlug: plan,
      subscriptionStatus: planRow.subscription_status || null,
      lastPaymentAt,
      startedAt: planRow.started_at || null,
    });
    const storeUrl = normalizeAbsoluteStoreUrl(
      user.storeUrl ||
        (user.primaryDomain
          ? `https://${String(user.primaryDomain).replace(/^https?:\/\//i, "")}`
          : null),
      user.store_hash
    ) || resolveStoreUrl(
      { secure_url: user.storeUrl, domain: user.primaryDomain },
      user.store_hash
    );

    return {
      _id: String(user._id || user.store_hash),
      store_hash: user.store_hash,
      store_name: user.store_name || user.store_hash || "Unknown store",
      store_url: storeUrl,
      app_url: storeUrl,
      signed_payload_url: user.signed_payload_url || null,
      platform: user.provider || "BigCommerce",
      plan,
      status: mapClientUiStatus(user.installStatus, plan),
      install_status: user.installStatus || "unknown",
      owner_email: user.email || "",
      installed_at: toIso(user.lastInstalledAt || user.created_at || null),
      last_payment_at: toIso(lastPaymentAt),
      next_payment_at: toIso(nextPaymentAt),
      paypal_subscription_id: planRow.paypal_subscription_id || null,
      subscription_status: planRow.subscription_status || null,
      last_active_at: toIso(
        user.lastLogin || user.updated_at || user.created_at || null
      ),
      channel_count: 1,
      total_images: Number(stats.total_catalog_images) || 0,
      optimized_images: Number(stats.optimized_images) || 0,
      failed_images: Number(stats.failed_images) || 0,
      pending_images: Number(stats.pending_images) || 0,
      total_saved_size: Number(stats.total_saved_bytes) || 0,
      average_compression_percent: Number(
        Number(stats.average_saving_percent || 0).toFixed(2)
      ),
      pending_jobs: pendingByHash.get(user.store_hash) || 0,
    };
  });
}

async function buildClientsSummary(baseFilter) {
  const [totalClients, activeCount, planDocs, allUsers, savedAgg] =
    await Promise.all([
      User.countDocuments(baseFilter),
      User.countDocuments({ ...baseFilter, installStatus: "installed" }),
      ClientPlan.find({}).select({ store_hash: 1, base_plan_slug: 1 }).lean(),
      User.find(baseFilter).select({ store_hash: 1, installStatus: 1 }).lean(),
      StoreImageStat.aggregate([
        {
          $group: {
            _id: null,
            total_saved_bytes: { $sum: "$total_saved_bytes" },
            optimized_images: { $sum: "$optimized_images" },
          },
        },
      ]),
    ]);

  const planByHash = new Map(
    planDocs.map((row) => [row.store_hash, normalizePlanSlug(row.base_plan_slug)])
  );

  const planBreakdown = Object.fromEntries(PLAN_SLUGS.map((slug) => [slug, 0]));
  let trialCount = 0;

  for (const user of allUsers) {
    const plan = planByHash.get(user.store_hash) || "free";
    planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    if (user.installStatus === "installed" && plan === "free") {
      trialCount += 1;
    }
  }

  const totals = savedAgg[0] || {};

  return {
    total_clients: totalClients,
    active: activeCount,
    trial: trialCount,
    total_saved_bytes: Number(totals.total_saved_bytes) || 0,
    total_optimized_images: Number(totals.optimized_images) || 0,
    plan_breakdown: PLAN_SLUGS.map((slug) => ({
      name: slug,
      value: planBreakdown[slug] || 0,
    })),
  };
}

exports.listClients = async ({
  page = 1,
  limit = 20,
  search = "",
  installStatus = null,
  status = null,
  plan = null,
}) => {
  const { page: resolvedPage, limit: resolvedLimit, skip } = resolvePagination(
    { page, limit }
  );

  const filter = {};
  const resolvedInstall =
    installStatus || mapStatusFilterToInstall(status) || null;

  if (resolvedInstall) {
    filter.installStatus = resolvedInstall;
  }

  if (search && String(search).trim()) {
    const term = String(search).trim();
    filter.$or = [
      { store_hash: { $regex: term, $options: "i" } },
      { store_name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
    ];
  }

  if (plan) {
    const planHashes = await resolveStoreHashesForPlan(plan);
    filter.store_hash = { $in: planHashes.length ? planHashes : ["__none__"] };
  }

  // Trial = installed free-plan stores.
  if (status === "trial") {
    const freeHashes = await resolveStoreHashesForPlan("free");
    const existing = filter.store_hash?.$in;
    const merged = existing
      ? freeHashes.filter((hash) => existing.includes(hash))
      : freeHashes;
    filter.store_hash = { $in: merged.length ? merged : ["__none__"] };
    filter.installStatus = "installed";
  }

  // Active = installed paid-plan stores.
  if (status === "active") {
    const nonFreePlans = await ClientPlan.find({
      base_plan_slug: { $ne: "free" },
    })
      .select({ store_hash: 1 })
      .lean();
    const paidHashes = nonFreePlans.map((row) => row.store_hash).filter(Boolean);
    const existing = filter.store_hash?.$in;
    const merged = existing
      ? paidHashes.filter((hash) => existing.includes(hash))
      : paidHashes;
    filter.store_hash = { $in: merged.length ? merged : ["__none__"] };
    filter.installStatus = "installed";
  }

  const summaryFilter = {};
  if (search && String(search).trim()) {
    const term = String(search).trim();
    summaryFilter.$or = [
      { store_hash: { $regex: term, $options: "i" } },
      { store_name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
    ];
  }

  const [clients, total, summary] = await Promise.all([
    User.find(filter)
      .select(CLIENT_PROFILE_FIELDS)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(resolvedLimit)
      .lean(),
    User.countDocuments(filter),
    buildClientsSummary(summaryFilter),
  ]);

  return {
    clients: await enrichClientRows(clients),
    pagination: buildPagination(resolvedPage, resolvedLimit, total),
    summary,
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
    StoreOptimizationSettings.findOne({ store_hash: storeHash }).lean(),
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
      settings: settings ? [settings] : [],
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
  const client = await User.findOne({ store_hash: storeHash })
    .select({ ...CLIENT_PROFILE_FIELDS, access_token: 1 })
    .lean();

  if (!client) {
    return { error: "Client not found", client: null };
  }

  const [enriched] = await enrichClientRows([client]);
  const latestPayment = await PaymentHistory.findOne({
    store_hash: storeHash,
    status: "COMPLETED",
    $or: [
      { transaction_id: { $type: "string", $ne: "" } },
      { capture_id: { $type: "string", $ne: "" } },
    ],
  })
    .sort({ paid_at: -1, created_at: -1 })
    .select({ transaction_id: 1, capture_id: 1 })
    .lean();

  const detail = {
    ...(enriched || {}),
    access_token: client.access_token || null,
    transaction_id:
      latestPayment?.transaction_id || latestPayment?.capture_id || null,
  };

  const [stats, recentJobs, jobCounts] = await Promise.all([
    StoreImageStat.findOne({ store_hash: storeHash }).lean(),
    ImageJob.find({ store_hash: storeHash })
      .sort({ created_at: -1 })
      .limit(10)
      .lean(),
    ImageJob.aggregate([
      { $match: { store_hash: storeHash } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  return {
    error: null,
    client: detail,
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
    .select({ store_hash: 1, store_name: 1 })
    .lean();

  if (!client) {
    return { error: "Client not found", data: null };
  }

  const selectedPlan = await getStorePlanSlug(storeHash, "free");
  const [clientPlan, effectivePlan, globalPlans] = await Promise.all([
    getClientPlanByStore(storeHash),
    getEffectivePlanForStore(storeHash, selectedPlan),
    listPlans({ activeOnly: true }),
  ]);

  return {
    error: null,
    data: {
      store_hash: storeHash,
      store_name: client.store_name || null,
      selected_plan: selectedPlan,
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
