const StoreMonthlyUsage = require("../models/StoreMonthlyUsage");
const ClientPlan = require("../models/ClientPlan");
const Plan = require("../models/Plan");
const ImageStatus = require("../models/ImageStatus");
const CategoryImageStatus = require("../models/CategoryImageStatus");
const BrandImageStatus = require("../models/BrandImageStatus");
const HomeBannerImage = require("../models/HomeBannerImage");

const TYPE_COUNT_FIELDS = {
  product: "product_count",
  category: "category_count",
  brand: "brand_count",  
  home_banner: "home_banner_count",
};

function getMonthStart(date = new Date()) {
  const start = new Date(date);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

function getMonthPeriod(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    monthStart: getMonthStart(d),
  };
}

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

async function resolvePlanSnapshot(planSlug) {
  const slug = normalizeSlug(planSlug) || "free";
  const plan = await Plan.findOne({ slug, is_active: true }).lean();
  if (!plan) {
    const fallback = await Plan.findOne({ slug: "free", is_active: true }).lean();
    return {
      plan_slug: "free",
      monthly_image_limit:
        fallback?.monthly_image_limit == null ? null : Number(fallback.monthly_image_limit),
    };
  }

  return {
    plan_slug: slug,
    monthly_image_limit:
      plan.monthly_image_limit == null ? null : Number(plan.monthly_image_limit),
  };
}

async function resolveStorePlanSnapshot(storeHash) {
  const clientPlan = await ClientPlan.findOne({ store_hash: storeHash }).lean();
  return resolvePlanSnapshot(clientPlan?.base_plan_slug || "free");
}

async function countLegacyMonthlyOptimized(storeHash, monthStart) {
  const [products, categories, brands, homeBanners] = await Promise.all([
    ImageStatus.countDocuments({
      store_hash: storeHash,
      status: "optimized",
      optimized_at: { $gte: monthStart },
    }),
    CategoryImageStatus.countDocuments({
      store_hash: storeHash,
      status: "optimized",
      optimized_at: { $gte: monthStart },
    }),
    BrandImageStatus.countDocuments({
      store_hash: storeHash,
      status: "optimized",
      optimized_at: { $gte: monthStart },
    }),
    HomeBannerImage.countDocuments({
      store_hash: storeHash,
      optimization_status: "optimized",
      last_optimized_at: { $gte: monthStart },
    }),
  ]);

  return {
    images_optimized: products + categories + brands + homeBanners,
    product_count: products,
    category_count: categories,
    brand_count: brands,
    home_banner_count: homeBanners,
  };
}

function formatUsageRow(row) {
  if (!row) return null;

  const used = Number(row.images_optimized) || 0;
  const limit =
    row.monthly_image_limit == null ? null : Number(row.monthly_image_limit);

  return {
    id: row._id,
    store_hash: row.store_hash,
    year: row.year,
    month: row.month,
    images_optimized: used,
    product_count: row.product_count || 0,
    category_count: row.category_count || 0,
    brand_count: row.brand_count || 0,
    home_banner_count: row.home_banner_count || 0,
    plan_slug: row.plan_slug || "free",
    monthly_image_limit: limit,
    remaining: limit == null ? null : Math.max(0, limit - used),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

/**
 * Ensure the current month usage row exists with plan slug + monthly limit snapshot.
 */
async function syncCurrentMonthUsage(storeHash, planSlug, monthlyLimit) {
  if (!storeHash) return null;

  const { year, month } = getMonthPeriod();
  const snapshot = await resolvePlanSnapshot(planSlug);

  const resolvedSlug = normalizeSlug(planSlug) || snapshot.plan_slug;
  const resolvedLimit =
    monthlyLimit !== undefined
      ? monthlyLimit == null
        ? null
        : Number(monthlyLimit)
      : snapshot.monthly_image_limit;

  return StoreMonthlyUsage.findOneAndUpdate(
    { store_hash: storeHash, year, month },
    {
      $set: {
        plan_slug: resolvedSlug,
        monthly_image_limit: resolvedLimit,
      },
      $setOnInsert: {
        store_hash: storeHash,
        year,
        month,
        images_optimized: 0,
        product_count: 0,
        category_count: 0,
        brand_count: 0,
        home_banner_count: 0,
      },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();
}

async function ensureCurrentMonthUsage(storeHash) {
  if (!storeHash) return null;

  const { year, month } = getMonthPeriod();
  const existing = await StoreMonthlyUsage.findOne({ store_hash: storeHash, year, month }).lean();
  if (existing) {
    if (existing.monthly_image_limit !== undefined && existing.plan_slug) {
      return existing;
    }
    const snapshot = await resolveStorePlanSnapshot(storeHash);
    return syncCurrentMonthUsage(storeHash, snapshot.plan_slug, snapshot.monthly_image_limit);
  }

  const snapshot = await resolveStorePlanSnapshot(storeHash);
  return syncCurrentMonthUsage(storeHash, snapshot.plan_slug, snapshot.monthly_image_limit);
}

/**
 * Increment monthly usage when an image is newly optimized.
 */
async function recordMonthlyOptimization(
  storeHash,
  imageType = "product",
  count = 1,
  planSlug = null
) {
  if (!storeHash || count < 1) return null;

  const typeField = TYPE_COUNT_FIELDS[imageType];
  if (!typeField) return null;

  const { year, month } = getMonthPeriod();
  const snapshot = planSlug
    ? await resolvePlanSnapshot(planSlug)
    : await resolveStorePlanSnapshot(storeHash);

  const inc = {
    images_optimized: count,
    [typeField]: count,
  };

  return StoreMonthlyUsage.findOneAndUpdate(
    { store_hash: storeHash, year, month },
    {
      $inc: inc,
      $setOnInsert: {
        store_hash: storeHash,
        year,
        month,
        plan_slug: snapshot.plan_slug,
        monthly_image_limit: snapshot.monthly_image_limit,
      },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();
}

async function getMonthlyUsageRecord(storeHash, date = new Date()) {
  const { year, month } = getMonthPeriod(date);
  return StoreMonthlyUsage.findOne({ store_hash: storeHash, year, month }).lean();
}

async function getStoreMonthlyOptimizedCount(storeHash, date = new Date()) {
  if (!storeHash) return 0;

  const { year, month, monthStart } = getMonthPeriod(date);
  const record = await StoreMonthlyUsage.findOne({ store_hash: storeHash, year, month }).lean();

  if (record) {
    return Number(record.images_optimized) || 0;
  }

  const legacy = await countLegacyMonthlyOptimized(storeHash, monthStart);
  if (legacy.images_optimized > 0) {
    const snapshot = await resolveStorePlanSnapshot(storeHash);
    await StoreMonthlyUsage.findOneAndUpdate(
      { store_hash: storeHash, year, month },
      {
        $set: {
          images_optimized: legacy.images_optimized,
          product_count: legacy.product_count,
          category_count: legacy.category_count,
          brand_count: legacy.brand_count,
          home_banner_count: legacy.home_banner_count,
          plan_slug: snapshot.plan_slug,
          monthly_image_limit: snapshot.monthly_image_limit,
        },
        $setOnInsert: { store_hash: storeHash, year, month },
      },
      { upsert: true }
    );
  }

  return legacy.images_optimized;
}

async function getCurrentMonthQuotaStatus(storeHash) {
  if (!storeHash) {
    return {
      monthly_used: 0,
      monthly_limit: null,
      remaining: null,
      unlimited: true,
      usage: null,
    };
  }

  let record = await getMonthlyUsageRecord(storeHash);
  if (!record) {
    record = await ensureCurrentMonthUsage(storeHash);
  } else if (record.monthly_image_limit === undefined) {
    const snapshot = await resolveStorePlanSnapshot(storeHash);
    record = await syncCurrentMonthUsage(
      storeHash,
      snapshot.plan_slug,
      snapshot.monthly_image_limit
    );
  }

  const used = Number(record?.images_optimized) || 0;
  const limit =
    record?.monthly_image_limit == null ? null : Number(record.monthly_image_limit);

  if (limit == null) {
    return {
      monthly_used: used,
      monthly_limit: null,
      remaining: null,
      unlimited: true,
      usage: formatUsageRow(record),
    };
  }

  return {
    monthly_used: used,
    monthly_limit: limit,
    remaining: Math.max(0, limit - used),
    unlimited: false,
    usage: formatUsageRow(record),
  };
}

async function listMonthlyUsageHistory(storeHash, { limit = 12 } = {}) {
  if (!storeHash) return [];

  const rows = await StoreMonthlyUsage.find({ store_hash: storeHash })
    .sort({ year: -1, month: -1 })
    .limit(Math.min(Math.max(limit, 1), 60))
    .lean();

  return rows.map((row) => formatUsageRow(row));
}

/** @deprecated use syncCurrentMonthUsage */
async function syncCurrentMonthPlanSlug(storeHash, planSlug) {
  const snapshot = await resolvePlanSnapshot(planSlug);
  return syncCurrentMonthUsage(storeHash, snapshot.plan_slug, snapshot.monthly_image_limit);
}

module.exports = {
  getMonthStart,
  getMonthPeriod,
  recordMonthlyOptimization,
  getMonthlyUsageRecord,
  getStoreMonthlyOptimizedCount,
  getCurrentMonthQuotaStatus,
  listMonthlyUsageHistory,
  syncCurrentMonthUsage,
  syncCurrentMonthPlanSlug,
  ensureCurrentMonthUsage,
  countLegacyMonthlyOptimized,
  resolvePlanSnapshot,
  resolveStorePlanSnapshot,
};
