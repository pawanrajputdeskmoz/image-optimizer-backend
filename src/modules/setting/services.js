const { get, post, put, del } = require("../../utils/axiosUtils");
const config = require("../../config");
const StoreOptimizationSettings = require("../../models/StoreOptimizationSettings");
const StoreWebhook = require("../../models/StoreWebhook");
const StoreCategoryWebhook = require("../../models/StoreCategoryWebhook");
const { getWebhookAuthHeaders } = require("../../utils/bigCommerceWebhook");
const { appendWebhookLog } = require("../installation/utils/webhookActivityLog");
const { appendCategoryWebhookLog } = require("../installation/utils/categoryWebhookActivityLog");
const ClientPlan = require("../../models/ClientPlan");
const ImageStatus = require("../../models/ImageStatus");
const ImageJob = require("../../models/ImageJob");
const CategoryJob = require("../../models/CategoryJob");
const BrandJob = require("../../models/BrandJob");
const {
  getStoreDashboardStats,
  getStoreActiveBulkJobs,
} = require("../imageOptimization/services");
const {
  RUNNING_JOB_STATUSES,
  BULK_RESTORE_JOB_TYPES,
} = require("../../utils/bulkEntityActivity");
const {
  listPlans,
  getPlanBySlug,
  selectStorePlan,
  upgradeStorePlan,
  formatClientPlan,
  listStoreMonthlyUsageHistory,
  getMonthlyQuotaStatus,
} = require("../plans/service");

function clampCount(value) {
  return Math.max(0, Number(value) || 0);
}

async function sumPendingRestoreForModel(Model, storeHash) {
  const rows = await Model.aggregate([
    {
      $match: {
        store_hash: storeHash,
        job_type: { $in: BULK_RESTORE_JOB_TYPES },
        status: { $in: RUNNING_JOB_STATUSES },
      },
    },
    {
      $group: {
        _id: null,
        pending: {
          $sum: {
            $max: [
              0,
              { $subtract: ["$queued_images", "$processed_images"] },
            ],
          },
        },
      },
    },
  ]);
  return clampCount(rows[0]?.pending);
}

/** Pending restore images across product/category/brand active restore jobs. */
async function getPendingRestoreImagesCount(storeHash) {
  const [product, category, brand] = await Promise.all([
    sumPendingRestoreForModel(ImageJob, storeHash),
    sumPendingRestoreForModel(CategoryJob, storeHash),
    sumPendingRestoreForModel(BrandJob, storeHash),
  ]);
  return product + category + brand;
}

function formatCountDisplay(value) {
  const n = clampCount(value);
  return n.toLocaleString("en-US");
}

function formatStorageDisplay(bytes) {
  const n = clampCount(bytes);
  if (n >= 1024 ** 4) {
    return `${(n / 1024 ** 4).toFixed(2)} TB`;
  }
  if (n >= 1024 ** 3) {
    return `${(n / 1024 ** 3).toFixed(1)} GB`;
  }
  if (n >= 1024 ** 2) {
    return `${(n / 1024 ** 2).toFixed(1)} MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${n} B`;
}

async function resolvePlanForDashboard(selectedPlan) {
  const plan = await getPlanBySlug(selectedPlan || "free", { activeOnly: true });
  if (plan) return plan;
  return getPlanBySlug("free", { activeOnly: true });
}

exports.listActivePlans = async (storeHash = null) => {
  try {
    const [plans, clientPlanDoc] = await Promise.all([
      listPlans({ activeOnly: true }),
      storeHash ? ClientPlan.findOne({ store_hash: storeHash }).lean() : null,
    ]);

    const clientPlan = clientPlanDoc ? formatClientPlan(clientPlanDoc) : null;
    let effectivePlan = null;

    if (storeHash) {
      const baseSlug = String(clientPlanDoc?.base_plan_slug || "free").trim().toLowerCase();
      effectivePlan =
        (await getPlanBySlug(baseSlug, { activeOnly: true })) ||
        (await getPlanBySlug("free", { activeOnly: true }));
    }

    return {
      error: null,
      data: {
        plans,
        selected_plan: effectivePlan?.slug || clientPlan?.base_plan_slug || "free",
        effective_plan: effectivePlan,
        client_plan: clientPlan,
      },
    };
  } catch (err) {
    console.error("[listActivePlans]", err.message);
    return { error: err.message, data: null };
  }
};

exports.selectClientPlan = async (storeHash, planSlug) => {
  try {
    const result = await selectStorePlan(storeHash, planSlug);
    if (result.error) {
      return { error: result.error, data: null };
    }
    return {
      error: null,
      data: {
        selected_plan: result.plan?.slug || planSlug,
        plan: result.plan,
        client_plan: result.client_plan || null,
        cleared_paused_jobs: result.cleared_paused_jobs ?? 0,
      },
    };
  } catch (err) {
    console.error("[selectClientPlan]", err.message);
    return { error: err.message, data: null };
  }
};

exports.upgradeClientPlan = async (storeHash, planSlug) => {
  try {
    const result = await upgradeStorePlan(storeHash, planSlug);
    if (result.error) {
      return {
        error: result.error,
        code: result.code || "UPGRADE_FAILED",
        data: {
          previous_plan: result.previous_plan || null,
          plan: result.plan || null,
        },
      };
    }

    return {
      error: null,
      code: result.code,
      data: {
        selected_plan: result.plan?.slug || planSlug,
        previous_plan: result.previous_plan,
        plan: result.plan,
        client_plan: result.client_plan || null,
        cleared_paused_jobs: result.cleared_paused_jobs ?? 0,
      },
    };
  } catch (err) {
    console.error("[upgradeClientPlan]", err.message);
    return { error: err.message, code: "UPGRADE_FAILED", data: null };
  }
};

exports.getClientMonthlyUsageHistory = async (storeHash, { limit = 12 } = {}) => {
  try {
    const history = await listStoreMonthlyUsageHistory(storeHash, { limit });
    return { error: null, data: history };
  } catch (err) {
    console.error("[getClientMonthlyUsageHistory]", err.message);
    return { error: err.message, data: null };
  }
};

exports.getClientDashboardStats = async (storeHash, selectedPlan = null) => {
  if (!storeHash) {
    return { error: "storeHash is required", data: null };
  }

  try {
    const [
      { error: statsError, data: stats },
      quota,
      { error: activeBulkError, data: activeBulkData },
      pausedPlanJobs,
      pendingRestoreImages,
    ] = await Promise.all([
      getStoreDashboardStats(storeHash),
      getMonthlyQuotaStatus(storeHash, selectedPlan || "free"),
      getStoreActiveBulkJobs(storeHash),
      ImageJob.countDocuments({
        store_hash: storeHash,
        status: "paused_plan_limit",
        job_type: { $in: ["bulk", "checkBox"] },
      }),
      getPendingRestoreImagesCount(storeHash),
    ]);

    const activeJob = Boolean(activeBulkData?.active_job);

    if (statsError) {
      return { error: statsError, data: null };
    }

    if (activeBulkError) {
      return { error: activeBulkError, data: null };
    }

    const pendingImages = clampCount(stats?.pending_images);
    const optimizedImages = clampCount(stats?.optimized_images);
    const totalSavedBytes = clampCount(stats?.total_saved_bytes);
    const pendingRestore = clampCount(pendingRestoreImages);
    const plan = quota.plan || (await resolvePlanForDashboard(selectedPlan));
    const monthlyLimit =
      quota.monthly_limit == null ? null : clampCount(quota.monthly_limit);
    const monthlyUsed = clampCount(quota.monthly_used);
    const monthlyRemaining =
      quota.remaining == null ? null : clampCount(quota.remaining);
    const quotaPercent =
      monthlyLimit == null || monthlyLimit <= 0
        ? 0
        : Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100));

    return {
      error: null,
      data: {
        pending_images: {
          value: pendingImages,
          display: formatCountDisplay(pendingImages),
          subtitle: "Waiting for optimization",
        },
        pending_restore_images: {
          value: pendingRestore,
          display: formatCountDisplay(pendingRestore),
          subtitle: "Waiting for restore",
        },
        pending_mode: pendingRestore > 0 ? "restore" : "optimize",
        optimized_images: {
          value: optimizedImages,
          display: formatCountDisplay(optimizedImages),
          subtitle: "Successfully optimized",
        },
        total_data_saved: {
          value: totalSavedBytes,
          display: formatStorageDisplay(totalSavedBytes),
          subtitle: "Reduced storage usage",
        },
        image_quota: {
          percent: quotaPercent,
          display: monthlyLimit == null ? "Unlimited" : `${quotaPercent}%`,
          used: monthlyUsed,
          limit: monthlyLimit,
          remaining: monthlyRemaining,
          plan: quota.plan_slug || plan?.slug || selectedPlan || "free",
          plan_name: quota.plan_name || plan?.name || "Free",
          plan_price: plan?.price ?? 0,
          subtitle: "Current monthly usage",
        },
        failed_images: clampCount(stats?.failed_images),
        average_saving_percent: Number(stats?.average_saving_percent) || 0,
        last_optimized_at: stats?.last_optimized_at || null,
        active_job: Boolean(activeJob),
        active_bulk_jobs: activeBulkData?.active_bulk_jobs || {
          product: false,
          category: false,
          brand: false,
        },
        active_bulk_restores: activeBulkData?.active_bulk_restores || {
          product: false,
          category: false,
          brand: false,
        },
        paused_plan_limit: pausedPlanJobs > 0,
        paused_plan_jobs: pausedPlanJobs,
      },
    };
  } catch (err) {
    console.error("[getClientDashboardStats]", err.message);
    return { error: err.message, data: null };
  }
};

const PRODUCT_CREATED_SCOPE = "store/product/created";
const PRODUCT_UPDATED_SCOPE = "store/product/updated";
const PRODUCT_WEBHOOK_SCOPES = [PRODUCT_CREATED_SCOPE, PRODUCT_UPDATED_SCOPE];
const ALL_PRODUCT_WEBHOOK_SCOPES = PRODUCT_WEBHOOK_SCOPES;

const CATEGORY_CREATED_SCOPE = "store/category/created";
const CATEGORY_UPDATED_SCOPE = "store/category/updated";
const CATEGORY_WEBHOOK_SCOPES = [CATEGORY_CREATED_SCOPE, CATEGORY_UPDATED_SCOPE];
const ALL_CATEGORY_WEBHOOK_SCOPES = CATEGORY_WEBHOOK_SCOPES;

function getWebhookDestination() {
  if (!process.env.REDIRECT_URI) {
    return null;
  }
  return `${String(process.env.REDIRECT_URI).replace(/\/$/, "")}/store/webhook`;
}

function buildBigCommerceHeaders(accessToken) {
  return {
    "X-Auth-Token": accessToken,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function registerWebhook({ storeHash, accessToken, scope }) {
  const destination = getWebhookDestination();
  if (!destination) {
    throw Object.assign(new Error("REDIRECT_URI is not configured"), { statusCode: 500 });
  }

  const headers = buildBigCommerceHeaders(accessToken);
  const requestConfig = { timeout: config.api.bigCommerceTimeoutMs };
  const webhookHeaders = getWebhookAuthHeaders();

  try {
    const data = await post(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/hooks`,
      { scope, destination, is_active: true, headers: webhookHeaders },
      headers,
      requestConfig
    );

    return {
      scope,
      destination,
      hook: data?.data || null,
      alreadyExists: false,
    };
  } catch (err) {
    const status = err?.response?.status;
    if (status === 409 || status === 422) {
      const existingHook = await findRegisteredHook({
        storeHash,
        accessToken,
        scope,
        destination,
      });

      if (existingHook?.id) {
        const updatedHook = await updateWebhook({
          storeHash,
          accessToken,
          hookId: existingHook.id,
          scope,
          destination,
        });

        return {
          scope,
          destination,
          hook: updatedHook || existingHook,
          alreadyExists: true,
        };
      }

      return {
        scope,
        destination,
        hook: existingHook || null,
        alreadyExists: true,
      };
    }
    throw err;
  }
}

async function findRegisteredHook({ storeHash, accessToken, scope, destination }) {
  const hooks = await listAppWebhooks({ storeHash, accessToken });

  return (
    hooks.find(
      (hook) => hook.scope === scope && (!destination || hook.destination === destination)
    ) || null
  );
}

async function updateWebhook({ storeHash, accessToken, hookId, scope, destination }) {
  const headers = buildBigCommerceHeaders(accessToken);
  const requestConfig = { timeout: config.api.bigCommerceTimeoutMs };

  const data = await put(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/hooks/${hookId}`,
    {
      scope,
      destination,
      is_active: true,
      headers: getWebhookAuthHeaders(),
    },
    {
      ...requestConfig,
      headers,
    }
  );

  return data?.data || null;
}

async function listAppWebhooks({ storeHash, accessToken }) {
  const headers = buildBigCommerceHeaders(accessToken);
  const requestConfig = { timeout: config.api.bigCommerceTimeoutMs };

  const data = await get(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/hooks?limit=250`,
    headers,
    requestConfig
  );

  return Array.isArray(data?.data) ? data.data : [];
}

function mapHookToDbEntry(hook, scope, destination) {
  const hookId = Number(hook?.id ?? hook?.hook_id);
  if (!Number.isFinite(hookId)) {
    return null;
  }

  return {
    hook_id: hookId,
    scope: String(hook?.scope || scope || "").trim(),
    destination: String(hook?.destination || destination || "").trim(),
    is_active: hook?.is_active !== false,
    registered_at: new Date(),
  };
}

async function syncAutoOptimizeFlag(storeHash, enabled) {
  await StoreOptimizationSettings.findOneAndUpdate(
    { store_hash: storeHash, channel_id: 1 },
    { $set: { auto_optimize_new_images: Boolean(enabled) } },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

async function syncCategoryAutoOptimizeFlag(storeHash, enabled) {
  await StoreOptimizationSettings.findOneAndUpdate(
    { store_hash: storeHash, channel_id: 1 },
    { $set: { auto_optimize_new_category_images: Boolean(enabled) } },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

async function syncProductWebhooksInDb(storeHash, { results = [], enabled }) {
  await syncAutoOptimizeFlag(storeHash, enabled);

  if (!enabled) {
    const deleted = await StoreWebhook.deleteMany({
      store_hash: storeHash,
      scope: { $in: ALL_PRODUCT_WEBHOOK_SCOPES },
    });

    await appendWebhookLog({
      traceId: `webhook-disable-${storeHash}-${Date.now()}`,
      storeHash,
      step: "webhook_disable",
      message: "Removed product webhook registrations from database",
      meta: { deleted_count: deleted.deletedCount || 0 },
    });
    return;
  }

  for (const result of results) {
    const entry = mapHookToDbEntry(result.hook, result.scope, result.destination);
    if (!entry) {
      console.warn("[syncProductWebhooksInDb] skipped hook without id", {
        storeHash,
        scope: result.scope,
      });
      continue;
    }

    await StoreWebhook.findOneAndUpdate(
      { store_hash: storeHash, scope: entry.scope },
      {
        $set: {
          store_hash: storeHash,
          hook_id: entry.hook_id,
          scope: entry.scope,
          destination: entry.destination,
          is_active: entry.is_active,
          registered_at: entry.registered_at,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    await appendWebhookLog({
      traceId: `webhook-register-${storeHash}-${entry.scope}`,
      storeHash,
      scope: entry.scope,
      step: "webhook_register",
      message: "Saved product webhook registration in database",
      meta: {
        hook_id: entry.hook_id,
        destination: entry.destination,
      },
    });
  }

  console.log("[syncProductWebhooksInDb] saved", {
    storeHash,
    count: results.filter((result) => mapHookToDbEntry(result.hook, result.scope, result.destination)).length,
  });
}

exports.getStoreProductWebhooks = async (storeHash) => {
  return StoreWebhook.find({
    store_hash: storeHash,
    scope: { $in: PRODUCT_WEBHOOK_SCOPES },
  })
    .sort({ scope: 1 })
    .lean();
};

exports.syncAutoOptimizeNewImages = async (storeHash, enabled) => {
  await syncAutoOptimizeFlag(storeHash, enabled);
};

exports.registerProductCreatedWebhook = async ({ storeHash, accessToken }) => {
  if (!storeHash || !accessToken) {
    throw Object.assign(new Error("Store credentials are required"), { statusCode: 400 });
  }

  const results = await exports.registerProductWebhooks({ storeHash, accessToken });
  const alreadyExists = results.length > 0 && results.every((result) => result.alreadyExists);
  const destination = results[0]?.destination || getWebhookDestination();

  await syncProductWebhooksInDb(storeHash, {
    results,
    enabled: results.length > 0,
  });

  return {
    scopes: results.map((result) => result.scope),
    destination,
    hooks: results,
    alreadyExists,
  };
};

exports.registerProductWebhooks = async ({ storeHash, accessToken }) => {
  if (!storeHash || !accessToken || !getWebhookDestination()) {
    return [];
  }

  const results = [];

  for (const scope of PRODUCT_WEBHOOK_SCOPES) {
    try {
      const result = await registerWebhook({ storeHash, accessToken, scope });
      results.push(result);
    } catch (err) {
      console.error("[registerProductWebhooks]", { storeHash, scope, message: err.message });
    }
  }

  return results;
};

exports.disableProductWebhooks = async ({ storeHash, accessToken }) => {
  if (!storeHash || !accessToken) {
    throw Object.assign(new Error("Store credentials are required"), { statusCode: 400 });
  }

  const destination = getWebhookDestination();
  const hooks = await listAppWebhooks({ storeHash, accessToken });
  const headers = buildBigCommerceHeaders(accessToken);
  const requestConfig = { timeout: config.api.bigCommerceTimeoutMs };

  const matchingHooks = hooks.filter(
    (hook) =>
      ALL_PRODUCT_WEBHOOK_SCOPES.includes(hook.scope) &&
      (!destination || hook.destination === destination)
  );

  const deleted = [];

  for (const hook of matchingHooks) {
    try {
      await del(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/hooks/${hook.id}`,
        headers,
        requestConfig
      );
      deleted.push({ id: hook.id, scope: hook.scope });
    } catch (err) {
      console.error("[disableProductWebhooks]", {
        storeHash,
        hookId: hook.id,
        message: err.message,
      });
    }
  }

  await syncProductWebhooksInDb(storeHash, {
    results: [],
    enabled: false,
  });

  return {
    destination,
    deleted,
    notFound: deleted.length === 0,
  };
};

async function syncCategoryWebhooksInDb(storeHash, { results = [], enabled }) {
  await syncCategoryAutoOptimizeFlag(storeHash, enabled);

  if (!enabled) {
    const deleted = await StoreCategoryWebhook.deleteMany({
      store_hash: storeHash,
      scope: { $in: ALL_CATEGORY_WEBHOOK_SCOPES },
    });

    await appendCategoryWebhookLog({
      traceId: `category-webhook-disable-${storeHash}-${Date.now()}`,
      storeHash,
      step: "webhook_disable",
      message: "Removed category webhook registrations from database",
      meta: { deleted_count: deleted.deletedCount || 0 },
    });
    return;
  }

  for (const result of results) {
    const entry = mapHookToDbEntry(result.hook, result.scope, result.destination);
    if (!entry) {
      console.warn("[syncCategoryWebhooksInDb] skipped hook without id", {
        storeHash,
        scope: result.scope,
      });
      continue;
    }

    await StoreCategoryWebhook.findOneAndUpdate(
      { store_hash: storeHash, scope: entry.scope },
      {
        $set: {
          store_hash: storeHash,
          hook_id: entry.hook_id,
          scope: entry.scope,
          destination: entry.destination,
          is_active: entry.is_active,
          registered_at: entry.registered_at,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    await appendCategoryWebhookLog({
      traceId: `category-webhook-register-${storeHash}-${entry.scope}`,
      storeHash,
      scope: entry.scope,
      step: "webhook_register",
      message: "Saved category webhook registration in database",
      meta: {
        hook_id: entry.hook_id,
        destination: entry.destination,
      },
    });
  }

  console.log("[syncCategoryWebhooksInDb] saved", {
    storeHash,
    count: results.filter((result) => mapHookToDbEntry(result.hook, result.scope, result.destination)).length,
  });
}

exports.getStoreCategoryWebhooks = async (storeHash) => {
  return StoreCategoryWebhook.find({
    store_hash: storeHash,
    scope: { $in: CATEGORY_WEBHOOK_SCOPES },
  })
    .sort({ scope: 1 })
    .lean();
};

exports.registerCategoryCreatedWebhook = async ({ storeHash, accessToken }) => {
  if (!storeHash || !accessToken) {
    throw Object.assign(new Error("Store credentials are required"), { statusCode: 400 });
  }

  const results = await exports.registerCategoryWebhooks({ storeHash, accessToken });
  const alreadyExists = results.length > 0 && results.every((result) => result.alreadyExists);
  const destination = results[0]?.destination || getWebhookDestination();

  await syncCategoryWebhooksInDb(storeHash, {
    results,
    enabled: results.length > 0,
  });

  return {
    scopes: results.map((result) => result.scope),
    destination,
    hooks: results,
    alreadyExists,
  };
};

exports.registerCategoryWebhooks = async ({ storeHash, accessToken }) => {
  if (!storeHash || !accessToken || !getWebhookDestination()) {
    return [];
  }

  const results = [];

  for (const scope of CATEGORY_WEBHOOK_SCOPES) {
    try {
      const result = await registerWebhook({ storeHash, accessToken, scope });
      results.push(result);
    } catch (err) {
      console.error("[registerCategoryWebhooks]", { storeHash, scope, message: err.message });
    }
  }

  return results;
};

exports.disableCategoryWebhooks = async ({ storeHash, accessToken }) => {
  if (!storeHash || !accessToken) {
    throw Object.assign(new Error("Store credentials are required"), { statusCode: 400 });
  }

  const destination = getWebhookDestination();
  const hooks = await listAppWebhooks({ storeHash, accessToken });
  const headers = buildBigCommerceHeaders(accessToken);
  const requestConfig = { timeout: config.api.bigCommerceTimeoutMs };

  const matchingHooks = hooks.filter(
    (hook) =>
      ALL_CATEGORY_WEBHOOK_SCOPES.includes(hook.scope) &&
      (!destination || hook.destination === destination)
  );

  const deleted = [];

  for (const hook of matchingHooks) {
    try {
      await del(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/hooks/${hook.id}`,
        headers,
        requestConfig
      );
      deleted.push({ id: hook.id, scope: hook.scope });
    } catch (err) {
      console.error("[disableCategoryWebhooks]", {
        storeHash,
        hookId: hook.id,
        message: err.message,
      });
    }
  }

  await syncCategoryWebhooksInDb(storeHash, {
    results: [],
    enabled: false,
  });

  return {
    destination,
    deleted,
    notFound: deleted.length === 0,
  };
};
