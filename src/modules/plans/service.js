const Plan = require("../../models/Plan");
const ClientPlan = require("../../models/ClientPlan");
const ImageStatus = require("../../models/ImageStatus");
const CategoryImageStatus = require("../../models/CategoryImageStatus");
const BrandImageStatus = require("../../models/BrandImageStatus");
const HomeBannerImage = require("../../models/HomeBannerImage");
const ImageJob = require("../../models/ImageJob");
const ImageJobItem = require("../../models/ImageJobItem");
const ImageOptimization = require("../../models/ImageOptimization");
const ImageOptimizationLog = require("../../models/ImageOptimizationLog");
const User = require("../../models/User");
const { notifyPlanLimitReached } = require("../../utils/planLimitNotify");
const {
  getStoreMonthlyOptimizedCount: readMonthlyUsageCount,
  listMonthlyUsageHistory,
  syncCurrentMonthUsage,
  getCurrentMonthQuotaStatus,
  recordMonthlyOptimization,
} = require("../../utils/monthlyUsage");

const DEFAULT_PLANS = [
  {
    slug: "free",
    name: "Free",
    description: "Up to 100 images per month",
    price: 0,
    currency: "USD",
    monthly_image_limit: 100,
    display_order: 1,
    is_active: true,
  },
  {
    slug: "starter",
    name: "Starter",
    description: "Up to 5,000 images per month",
    price: 5,
    currency: "USD",
    monthly_image_limit: 5_000,
    display_order: 2,
    is_active: true,
  },
  {
    slug: "pro",
    name: "Pro",
    description: "Up to 20,000 images per month",
    price: 10,
    currency: "USD",
    monthly_image_limit: 20_000,
    display_order: 3,
    is_active: true,
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    description: "Unlimited images per month",
    price: 20,
    currency: "USD",
    monthly_image_limit: null,
    display_order: 4,
    is_active: true,
  },
];

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

const MONTHLY_PLAN_LIMIT_MESSAGE =
  "Your monthly image optimization limit has been reached. Please wait for your plan to renew or upgrade your plan to continue.";

exports.MONTHLY_PLAN_LIMIT_MESSAGE = MONTHLY_PLAN_LIMIT_MESSAGE;

exports.buildPlanLimitApiBody = (quota = {}) => ({
  success: false,
  code: quota.code || "MONTHLY_QUOTA_EXCEEDED",
  message: quota.message || MONTHLY_PLAN_LIMIT_MESSAGE,
  upgrade_required: true,
  data: {
    monthly_used: quota.monthly_used ?? null,
    monthly_limit: quota.monthly_limit ?? null,
    remaining: quota.remaining ?? 0,
    plan: quota.plan_slug || null,
    plan_name: quota.plan_name || quota.plan?.name || null,
  },
});

function formatPlan(plan) {
  if (!plan) return null;
  return {
    id: plan._id,
    slug: plan.slug,
    name: plan.name,
    description: plan.description || null,
    price: Number(plan.price) || 0,
    currency: plan.currency || "USD",
    monthly_image_limit:
      plan.monthly_image_limit == null ? null : Number(plan.monthly_image_limit),
    is_active: Boolean(plan.is_active),
    display_order: Number(plan.display_order) || 0,
    paypal_plan_id: plan.paypal_plan_id || null,
    created_at: plan.created_at || null,
    updated_at: plan.updated_at || null,
  };
}

exports.ensureDefaultPlans = async () => {
  for (const seed of DEFAULT_PLANS) {
    await Plan.updateOne({ slug: seed.slug }, { $setOnInsert: seed }, { upsert: true });
  }
};

exports.listPlans = async ({ activeOnly = false } = {}) => {
  const filter = activeOnly ? { is_active: true } : {};
  const plans = await Plan.find(filter).sort({ display_order: 1, slug: 1 }).lean();
  return plans.map(formatPlan);
};

exports.getPlanBySlug = async (slug, { activeOnly = false } = {}) => {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;

  const filter = { slug: normalized };
  if (activeOnly) filter.is_active = true;

  const plan = await Plan.findOne(filter).lean();
  return formatPlan(plan);
};

function buildPlanUpdateSet(updates = {}) {
  const $set = {};

  if (updates.name != null) $set.name = String(updates.name).trim();
  if (updates.description != null) {
    $set.description = String(updates.description).trim() || null;
  }
  if (updates.price != null) {
    const price = Number(updates.price);
    if (!Number.isFinite(price) || price < 0) {
      return { error: "price must be a non-negative number", $set: null };
    }
    $set.price = price;
  }
  if (updates.currency != null) {
    $set.currency = String(updates.currency).trim().toUpperCase() || "USD";
  }
  if (updates.display_order != null) {
    const displayOrder = Number(updates.display_order);
    if (!Number.isFinite(displayOrder)) {
      return { error: "display_order must be a number", $set: null };
    }
    $set.display_order = displayOrder;
  }
  if (updates.is_active != null) $set.is_active = Boolean(updates.is_active);

  if (updates.monthly_image_limit !== undefined) {
    if (updates.monthly_image_limit === null || updates.monthly_image_limit === "") {
      $set.monthly_image_limit = null;
    } else {
      const limit = Number(updates.monthly_image_limit);
      if (!Number.isFinite(limit) || limit < 1) {
        return {
          error: "monthly_image_limit must be null or a positive number",
          $set: null,
        };
      }
      $set.monthly_image_limit = limit;
    }
  }

  return { error: null, $set };
}

exports.updatePlans = async (plansPayload = []) => {
  if (!Array.isArray(plansPayload) || !plansPayload.length) {
    return { error: "plans array is required and must not be empty", plans: null };
  }

  const updated = [];

  for (const entry of plansPayload) {
    const normalized = normalizeSlug(entry?.slug);
    if (!normalized) {
      return { error: "Each plan must include a valid slug", plans: null };
    }

    const { error: fieldError, $set } = buildPlanUpdateSet(entry);
    if (fieldError) {
      return { error: `${normalized}: ${fieldError}`, plans: null };
    }

    if (!Object.keys($set).length) {
      return { error: `${normalized}: no valid fields to update`, plans: null };
    }

    const plan = await Plan.findOneAndUpdate(
      { slug: normalized },
      { $set },
      { returnDocument: "after" }
    ).lean();

    if (!plan) {
      return { error: `Plan not found: ${normalized}`, plans: null };
    }

    updated.push(formatPlan(plan));
  }

  updated.sort((a, b) => a.display_order - b.display_order || a.slug.localeCompare(b.slug));

  return { error: null, plans: updated };
};

exports.updatePlanBySlug = async (slug, updates = {}) => {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return { error: "Plan slug is required", plan: null };
  }

  const { error, $set } = buildPlanUpdateSet(updates);
  if (error) {
    return { error, plan: null };
  }

  if (!Object.keys($set).length) {
    return { error: "No valid fields to update", plan: null };
  }

  const plan = await Plan.findOneAndUpdate(
    { slug: normalized },
    { $set },
    { returnDocument: "after" }
  ).lean();

  if (!plan) {
    return { error: "Plan not found", plan: null };
  }

  return { error: null, plan: formatPlan(plan) };
};

exports.getMonthlyOptimizedCount = async (storeHash) => {
  return exports.getStoreMonthlyOptimizedCount(storeHash);
};

exports.getStoreMonthlyOptimizedCount = async (storeHash) => {
  return readMonthlyUsageCount(storeHash);
};

exports.listStoreMonthlyUsageHistory = listMonthlyUsageHistory;
exports.recordMonthlyOptimization = recordMonthlyOptimization;

function formatClientPlan(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    store_hash: doc.store_hash,
    assigned_by: doc.assigned_by ?? "system",
    base_plan_slug: doc.base_plan_slug || "free",
    started_at: doc.started_at ?? null,
    created_at: doc.created_at ?? null,
    updated_at: doc.updated_at ?? null,
  };
}

exports.formatClientPlan = formatClientPlan;

exports.getClientPlanByStore = async (storeHash) => {
  if (!storeHash) return null;
  const doc = await ClientPlan.findOne({ store_hash: storeHash }).lean();
  return formatClientPlan(doc);
};

exports.getEffectivePlanForStore = async (storeHash, fallbackSlug = "free") => {
  const clientPlan = await ClientPlan.findOne({ store_hash: storeHash }).lean();
  const baseSlug = normalizeSlug(clientPlan?.base_plan_slug || fallbackSlug || "free");
  let basePlan = await exports.getPlanBySlug(baseSlug, { activeOnly: true });
  if (!basePlan) {
    basePlan = await exports.getPlanBySlug("free", { activeOnly: true });
  }
  return basePlan;
};

async function assignStorePlan(storeHash, planSlug, { assignedBy = "client" } = {}) {
  const normalized = normalizeSlug(planSlug);
  const [plan, existingClientPlan] = await Promise.all([
    exports.getPlanBySlug(normalized, { activeOnly: true }),
    ClientPlan.findOne({ store_hash: storeHash }).lean(),
  ]);
  if (!plan) {
    return { error: "Plan not found or inactive", user: null, client_plan: null, plan: null };
  }

  const isPaidPlan = Number(plan.price) > 0;
  const $set = {
    base_plan_slug: normalized,
    assigned_by: assignedBy,
  };
  if (isPaidPlan && !existingClientPlan?.started_at) {
    $set.started_at = new Date();
  }

  const user = await User.findOneAndUpdate(
    { store_hash: storeHash },
    { $set: { selectedPlan: normalized } },
    { returnDocument: "after" }
  )
    .select({ selectedPlan: 1, store_hash: 1 })
    .lean();

  if (!user) {
    return { error: "Store not found", user: null, client_plan: null, plan: null };
  }

  const clientPlanDoc = await ClientPlan.findOneAndUpdate(
    { store_hash: storeHash },
    {
      $set: {
        ...$set,
        user_id: user._id,
        plan_id: plan.id,
      },
      $setOnInsert: { store_hash: storeHash },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();

  await syncCurrentMonthUsage(
    storeHash,
    normalized,
    plan.monthly_image_limit,
    user._id,
    plan.id
  );

  return {
    error: null,
    user,
    plan,
    client_plan: formatClientPlan(clientPlanDoc),
  };
}

exports.upsertClientPlan = async (storeHash, payload = {}, assignedBy = null) => {
  if (!storeHash) {
    return { error: "storeHash is required", client_plan: null, effective_plan: null, resume: null };
  }

  const baseSlug = normalizeSlug(payload.base_plan_slug || "free");
  const [basePlan, existingClientPlan] = await Promise.all([
    exports.getPlanBySlug(baseSlug, { activeOnly: true }),
    ClientPlan.findOne({ store_hash: storeHash }).lean(),
  ]);
  if (!baseSlug || !basePlan) {
    return { error: "Invalid base_plan_slug", client_plan: null, effective_plan: null, resume: null };
  }

  const isPaidPlan = Number(basePlan.price) > 0;
  const $set = {
    base_plan_slug: baseSlug,
    assigned_by: assignedBy || "admin",
  };
  if (isPaidPlan && !existingClientPlan?.started_at) {
    $set.started_at = new Date();
  }

  const user = await User.findOneAndUpdate(
    { store_hash: storeHash },
    { $set: { selectedPlan: baseSlug } },
    { returnDocument: "after" }
  )
    .select({ _id: 1 })
    .lean();

  if (!user) {
    return { error: "Store not found", client_plan: null, effective_plan: null, resume: null };
  }

  const clientPlanDoc = await ClientPlan.findOneAndUpdate(
    { store_hash: storeHash },
    {
      $set: {
        ...$set,
        user_id: user._id,
        plan_id: basePlan.id,
      },
      $setOnInsert: { store_hash: storeHash },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();

  await Promise.all([
    syncCurrentMonthUsage(
      storeHash,
      baseSlug,
      basePlan.monthly_image_limit,
      user._id,
      basePlan.id
    ),
    exports.clearPausedPlanLimitJobs(storeHash),
  ]);

  return {
    error: null,
    client_plan: formatClientPlan(clientPlanDoc),
    effective_plan: basePlan,
    resume: null,
  };
};

exports.deleteClientPlan = async (storeHash) => {
  if (!storeHash) {
    return { error: "storeHash is required", deleted: false, effective_plan: null, resume: null };
  }

  const result = await ClientPlan.deleteOne({ store_hash: storeHash });
  const user = await User.findOneAndUpdate(
    { store_hash: storeHash },
    { $set: { selectedPlan: "free" } },
    { returnDocument: "after" }
  )
    .select({ _id: 1 })
    .lean();
  const freePlan = await exports.getPlanBySlug("free", { activeOnly: true });
  await ClientPlan.findOneAndUpdate(
    { store_hash: storeHash },
    {
      $set: {
        ...(user?._id ? { user_id: user._id } : {}),
        ...(freePlan?.id ? { plan_id: freePlan.id } : {}),
        base_plan_slug: "free",
        assigned_by: "system",
      },
      $setOnInsert: { store_hash: storeHash },
    },
    { upsert: true }
  );
  await syncCurrentMonthUsage(
    storeHash,
    "free",
    freePlan?.monthly_image_limit ?? 100,
    user?._id || null,
    freePlan?.id || null
  );

  const effectivePlan = await exports.getEffectivePlanForStore(storeHash, "free");

  return {
    error: null,
    deleted: result.deletedCount > 0,
    effective_plan: effectivePlan,
    resume: null,
  };
};

exports.ensureClientPlan = async (storeHash, planSlug = "free", userId = null) => {
  if (!storeHash) return null;
  const normalized = normalizeSlug(planSlug) || "free";
  const existing = await ClientPlan.findOne({ store_hash: storeHash }).lean();
  if (existing) {
    const activePlan = await exports.getPlanBySlug(existing.base_plan_slug || "free", {
      activeOnly: true,
    });
    if (
      (userId && String(existing.user_id || "") !== String(userId)) ||
      (activePlan?.id && String(existing.plan_id || "") !== String(activePlan.id))
    ) {
      await ClientPlan.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...(userId ? { user_id: userId } : {}),
            ...(activePlan?.id ? { plan_id: activePlan.id } : {}),
          },
        }
      );
    }
    await syncCurrentMonthUsage(
      storeHash,
      existing.base_plan_slug || normalized,
      activePlan?.monthly_image_limit ?? null,
      userId || existing.user_id || null,
      activePlan?.id || existing.plan_id || null
    );
    return formatClientPlan(existing);
  }

  const plan = await exports.getPlanBySlug(normalized, { activeOnly: true });
  const doc = await ClientPlan.findOneAndUpdate(
    { store_hash: storeHash },
    {
      $setOnInsert: {
        ...(userId ? { user_id: userId } : {}),
        ...(plan?.id ? { plan_id: plan.id } : {}),
        store_hash: storeHash,
        base_plan_slug: normalized,
        assigned_by: "system",
      },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();

  await syncCurrentMonthUsage(
    storeHash,
    normalized,
    plan?.monthly_image_limit ?? null,
    userId,
    plan?.id || null
  );

  return formatClientPlan(doc);
};

exports.getMonthlyQuotaStatus = async (storeHash, planSlug) => {
  const normalizedSlug = planSlug || "free";
  const [effectivePlan, quota, slugPlan, freePlan] = await Promise.all([
    exports.getEffectivePlanForStore(storeHash, normalizedSlug),
    getCurrentMonthQuotaStatus(storeHash),
    exports.getPlanBySlug(normalizedSlug, { activeOnly: true }),
    exports.getPlanBySlug("free", { activeOnly: true }),
  ]);
  const fallback = effectivePlan || slugPlan || freePlan;

  if (!fallback) {
    return {
      plan: null,
      plan_slug: planSlug || "free",
      monthly_used: quota.monthly_used,
      monthly_limit: quota.monthly_limit ?? 100,
      remaining: quota.remaining ?? Math.max(0, 100 - quota.monthly_used),
      unlimited: quota.unlimited,
      usage: quota.usage,
    };
  }

  return {
    plan: fallback,
    plan_slug: fallback.slug,
    plan_name: fallback.name,
    monthly_used: quota.monthly_used,
    monthly_limit: quota.monthly_limit,
    remaining: quota.remaining,
    unlimited: quota.unlimited,
    usage: quota.usage,
  };
};

exports.canOptimizeImages = async (storeHash, planSlug, imagesNeeded = 1) => {
  const needed = Math.max(1, Number(imagesNeeded) || 1);
  const quota = await exports.getMonthlyQuotaStatus(storeHash, planSlug);

  if (quota.unlimited) {
    return {
      allowed: true,
      code: "UNLIMITED",
      message: null,
      ...quota,
      images_needed: needed,
      upgrade_required: false,
    };
  }

  if (quota.remaining <= 0) {
    return {
      allowed: false,
      code: "MONTHLY_QUOTA_EXCEEDED",
      message: MONTHLY_PLAN_LIMIT_MESSAGE,
      ...quota,
      images_needed: needed,
      upgrade_required: true,
    };
  }

  return {
    allowed: true,
    code: "OK",
    message: null,
    ...quota,
    images_needed: needed,
    upgrade_required: false,
  };
};

exports.resolveMonthlyImageLimit = async (planSlug) => {
  const plan = await exports.getPlanBySlug(planSlug || "free", { activeOnly: true });
  if (!plan) {
    const fallback = await exports.getPlanBySlug("free", { activeOnly: true });
    return fallback?.monthly_image_limit ?? 100;
  }
  return plan.monthly_image_limit;
};

exports.evaluatePlanForQueuedImages = async ({
  storeHash,
  planSlug,
  imagesToQueue,
}) => {
  const queued = Math.max(0, Number(imagesToQueue) || 0);
  const plan = await exports.getEffectivePlanForStore(storeHash, planSlug || "free");

  if (!plan) {
    return {
      allowed: false,
      code: "INVALID_PLAN",
      message: "Selected plan is not available. Please choose a valid plan.",
      plan_slug: planSlug || null,
      images_to_queue: queued,
    };
  }

  const quota = await getCurrentMonthQuotaStatus(storeHash);

  if (quota.unlimited) {
    return {
      allowed: true,
      code: "UNLIMITED",
      plan,
      images_to_queue: queued,
      monthly_used: quota.monthly_used,
      monthly_limit: null,
      remaining: null,
    };
  }

  const monthlyUsed = quota.monthly_used;
  const monthlyLimit = Number(quota.monthly_limit);
  const remaining = quota.remaining;

  if (queued > monthlyLimit) {
    return {
      allowed: false,
      code: "PLAN_LIMIT_EXCEEDED",
      message: `Your ${plan.name} plan allows up to ${monthlyLimit.toLocaleString("en-US")} images, but ${queued.toLocaleString("en-US")} images were found to optimize. Please upgrade your plan to continue.`,
      plan,
      plan_slug: plan.slug,
      plan_name: plan.name,
      plan_limit: monthlyLimit,
      monthly_used: monthlyUsed,
      remaining,
      images_to_queue: queued,
      upgrade_required: true,
    };
  }

  if (queued > remaining) {
    return {
      allowed: false,
      code: "MONTHLY_QUOTA_EXCEEDED",
      message: `Your ${plan.name} plan has ${remaining.toLocaleString("en-US")} image${remaining === 1 ? "" : "s"} remaining this month, but this job needs ${queued.toLocaleString("en-US")} images. Please upgrade your plan or wait until next month.`,
      plan,
      plan_slug: plan.slug,
      plan_name: plan.name,
      plan_limit: monthlyLimit,
      monthly_used: monthlyUsed,
      remaining,
      images_to_queue: queued,
      upgrade_required: true,
    };
  }

  return {
    allowed: true,
    code: "OK",
    plan,
    plan_slug: plan.slug,
    plan_name: plan.name,
    plan_limit: monthlyLimit,
    monthly_used: monthlyUsed,
    remaining: remaining - queued,
    images_to_queue: queued,
    upgrade_required: false,
  };
};

exports.pauseJobForPlanLimit = async ({
  jobUuid,
  storeHash,
  evaluation,
  totalImages = 0,
  queuedImages = 0,
  skippedImages = 0,
  sendNotification = true,
}) => {
  if (jobUuid && storeHash) {
    const pendingItems = await ImageJobItem.find({
      job_uuid: jobUuid,
      store_hash: storeHash,
      status: { $in: ["queued", "optimizing"] },
    })
      .select({ product_id: 1, image_id: 1 })
      .lean();

    if (pendingItems.length > 0) {
      const skipResult = await ImageJobItem.updateMany(
        {
          job_uuid: jobUuid,
          store_hash: storeHash,
          status: { $in: ["queued", "optimizing"] },
        },
        {
          $set: {
            status: "skipped",
            skip_reason: "Monthly plan limit reached",
            completed_at: new Date(),
            error_message: null,
          },
        }
      );

      const clearedCount = Number(skipResult.modifiedCount) || 0;

      const imageIds = pendingItems.map((row) => Number(row.image_id));
      const optimizedRows = await ImageOptimization.find({
        store_hash: storeHash,
        image_id: { $in: imageIds },
      })
        .select({ product_id: 1, image_id: 1 })
        .lean();

      const optimizedKeys = new Set(
        optimizedRows.map((row) => `${row.product_id}:${row.image_id}`)
      );

      const pairFilter = (rows) => ({
        store_hash: storeHash,
        status: { $in: ["pending", "optimizing"] },
        $or: rows.map((row) => ({
          product_id: row.product_id,
          image_id: row.image_id,
        })),
      });

      const revertOptimized = pendingItems.filter((row) =>
        optimizedKeys.has(`${row.product_id}:${row.image_id}`)
      );
      const unstuckOptimizing = pendingItems.filter(
        (row) => !optimizedKeys.has(`${row.product_id}:${row.image_id}`)
      );

      const statusOps = [];
      if (revertOptimized.length > 0) {
        statusOps.push(
          ImageStatus.updateMany(pairFilter(revertOptimized), {
            $set: { status: "optimized", image_update_status: "complete" },
          })
        );
      }
      if (unstuckOptimizing.length > 0) {
        statusOps.push(
          ImageStatus.updateMany(
            {
              ...pairFilter(unstuckOptimizing),
              status: "optimizing",
            },
            {
              $set: { status: "pending", image_update_status: "pending" },
            }
          )
        );
      }
      if (statusOps.length > 0) {
        await Promise.all(statusOps);
      }

      if (clearedCount > 0) {
        await ImageJob.updateOne(
          { job_uuid: jobUuid },
          {
            $inc: {
              processed_images: clearedCount,
              skipped_images: clearedCount,
            },
          }
        );
      }
    }
  }

  await ImageJob.updateOne(
    { job_uuid: jobUuid },
    {
      $set: {
        status: "paused_plan_limit",
        completed_at: null,
        ...(totalImages > 0 ? { total_images: totalImages } : {}),
        ...(queuedImages > 0 ? { queued_images: queuedImages } : {}),
        ...(skippedImages > 0 ? { skipped_images: skippedImages } : {}),
      },
    }
  );

  await ImageOptimizationLog.create({
    job_uuid: jobUuid,
    store_hash: storeHash,
    job_type: "bulk",
    log_type: "warning",
    step: "plan_limit",
    message:
      evaluation?.message ||
      "Bulk optimization paused — monthly plan limit reached. Please upgrade your plan or wait until next month, then try again.",
    meta: {
      code: evaluation?.code || "MONTHLY_QUOTA_EXCEEDED",
      plan_slug: evaluation?.plan_slug || null,
      plan_limit: evaluation?.plan_limit ?? null,
      monthly_used: evaluation?.monthly_used ?? null,
      remaining: evaluation?.remaining ?? null,
      images_to_queue: evaluation?.images_to_queue ?? queuedImages,
    },
  });

  if (sendNotification) {
    await notifyPlanLimitReached(storeHash, {
      message: evaluation?.message,
      planName: evaluation?.plan_name || null,
      planSlug: evaluation?.plan_slug || null,
      monthlyLimit: evaluation?.plan_limit ?? null,
      monthlyUsed: evaluation?.monthly_used ?? null,
    }).catch(() => {});
  }

  if (storeHash) {
    const { clearStoreOptimizationJobs } = require("../../queue/imageOptimizationQueues");
    await clearStoreOptimizationJobs(storeHash).catch((err) => {
      console.error("[pauseJobForPlanLimit] clearStoreOptimizationJobs:", err?.message);
    });
  }

  return { error: null };
};

/** Clears paused plan-limit jobs so the store can start a fresh bulk run after upgrade. */
exports.clearPausedPlanLimitJobs = async (storeHash) => {
  if (!storeHash) {
    return { error: "storeHash is required", cleared: 0 };
  }

  const result = await ImageJob.updateMany(
    {
      store_hash: storeHash,
      status: "paused_plan_limit",
      job_type: { $in: ["bulk", "checkBox"] },
    },
    {
      $set: {
        status: "failed",
        completed_at: new Date(),
      },
    }
  );

  return { error: null, cleared: result.modifiedCount || 0 };
};

exports.selectStorePlan = async (storeHash, planSlug) => {
  const normalized = normalizeSlug(planSlug);
  if (!storeHash || !normalized) {
    return { error: "storeHash and plan slug are required", user: null };
  }

  const assigned = await assignStorePlan(storeHash, normalized, { assignedBy: "client" });
  if (assigned.error) {
    return { error: assigned.error, user: null };
  }

  const cleared = await exports.clearPausedPlanLimitJobs(storeHash);

  return {
    error: null,
    user: assigned.user,
    plan: assigned.plan,
    client_plan: assigned.client_plan,
    cleared_paused_jobs: cleared.cleared,
  };
};

function comparePlanTier(currentPlan, targetPlan) {
  const currentOrder = Number(currentPlan?.display_order) || 0;
  const targetOrder = Number(targetPlan?.display_order) || 0;
  if (targetOrder > currentOrder) return 1;
  if (targetOrder < currentOrder) return -1;
  return 0;
}

exports.upgradeStorePlan = async (storeHash, planSlug) => {
  const normalized = normalizeSlug(planSlug);
  if (!storeHash || !normalized) {
    return {
      error: "storeHash and plan slug are required",
      code: "INVALID_REQUEST",
      user: null,
      previous_plan: null,
      plan: null,
      resume: null,
    };
  }

  const user = await User.findOne({ store_hash: storeHash })
    .select({ selectedPlan: 1, store_hash: 1 })
    .lean();

  if (!user) {
    return {
      error: "Store not found",
      code: "STORE_NOT_FOUND",
      user: null,
      previous_plan: null,
      plan: null,
      resume: null,
    };
  }

  const currentSlug = normalizeSlug(user.selectedPlan || "free");
  const effectiveCurrent = await exports.getEffectivePlanForStore(storeHash, currentSlug);
  const [previousPlan, targetPlan] = await Promise.all([
    Promise.resolve(effectiveCurrent),
    exports.getPlanBySlug(normalized, { activeOnly: true }),
  ]);

  if (!targetPlan) {
    return {
      error: "Plan not found or inactive",
      code: "PLAN_NOT_FOUND",
      user: null,
      previous_plan: previousPlan,
      plan: null,
      resume: null,
    };
  }

  const resolvedPrevious =
    previousPlan || (await exports.getPlanBySlug("free", { activeOnly: true }));

  if (currentSlug === normalized) {
    return {
      error: "You are already on this plan",
      code: "SAME_PLAN",
      user,
      previous_plan: resolvedPrevious,
      plan: targetPlan,
      resume: null,
    };
  }

  const tierComparison = comparePlanTier(resolvedPrevious, targetPlan);
  if (tierComparison <= 0) {
    return {
      error: "Target plan must be higher than your current plan. Use select-plan to change to a lower tier.",
      code: "NOT_AN_UPGRADE",
      user,
      previous_plan: resolvedPrevious,
      plan: targetPlan,
      resume: null,
    };
  }

  const assigned = await assignStorePlan(storeHash, normalized, { assignedBy: "client" });
  if (assigned.error) {
    return {
      error: assigned.error,
      code: "UPGRADE_FAILED",
      user: null,
      previous_plan: resolvedPrevious,
      plan: targetPlan,
      resume: null,
    };
  }

  const cleared = await exports.clearPausedPlanLimitJobs(storeHash);

  return {
    error: null,
    code: "UPGRADED",
    user: assigned.user,
    previous_plan: resolvedPrevious,
    plan: targetPlan,
    client_plan: assigned.client_plan,
    cleared_paused_jobs: cleared.cleared,
  };
};
