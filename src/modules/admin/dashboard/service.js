const User = require("../../../models/User");
const ImageStatus = require("../../../models/ImageStatus");
const CategoryImageStatus = require("../../../models/CategoryImageStatus");
const ImageJobItem = require("../../../models/ImageJobItem");
const CategoryJobItem = require("../../../models/CategoryJobItem");
const StoreImageStat = require("../../../models/StoreImageStat");
const ClientPlan = require("../../../models/ClientPlan");
const PaymentHistory = require("../../../models/PaymentHistory");
const {
  getWorkerStatusSummary,
} = require("../workers/service");

const OPTIMIZED_JOB_STATUSES = ["optimized", "metadata_updated"];
const TREND_WINDOW_DAYS = 7;
const STORAGE_TREND_WINDOW_DAYS = 15;

function getDayBoundaries(windowDays = TREND_WINDOW_DAYS) {
  const days = [];
  const now = new Date();
  const totalDays = Math.max(1, Number(windowDays) || TREND_WINDOW_DAYS);

  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - offset);

    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    days.push({
      date: start.toISOString().slice(0, 10),
      start,
      end,
    });
  }

  return days;
}

function getTrendWindowStart(windowDays = TREND_WINDOW_DAYS) {
  const totalDays = Math.max(1, Number(windowDays) || TREND_WINDOW_DAYS);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (totalDays - 1));
  return start;
}

function formatCountDisplay(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 10_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return n.toLocaleString("en-US");
}

function formatStorageDisplay(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 4) {
    return `${(n / 1024 ** 4).toFixed(2)} TB`;
  }
  if (n >= 1024 ** 3) {
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  if (n >= 1024 ** 2) {
    return `${(n / 1024 ** 2).toFixed(2)} MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(2)} KB`;
  }
  return `${n} B`;
}

function formatMoneyDisplay(amount, currency = "USD") {
  const value = Number(amount) || 0;
  const code = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

function formatBytesDisplay(bytes) {
  const n = Number(bytes) || 0;
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

function buildTrend(current, previous, label = "vs previous 7 days") {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;

  if (previousValue <= 0) {
    const percent = currentValue > 0 ? 100 : 0;
    return {
      direction: currentValue > 0 ? "up" : "neutral",
      percent,
      label,
    };
  }

  const change = ((currentValue - previousValue) / previousValue) * 100;
  return {
    direction: change > 0 ? "up" : change < 0 ? "down" : "neutral",
    percent: Number(Math.abs(change).toFixed(1)),
    label,
  };
}

function buildSegments(items) {
  const total = items.reduce((sum, row) => sum + (row.value || 0), 0);
  return {
    total,
    segments: items.map((row) => ({
      ...row,
      percent: total > 0 ? Number(((row.value / total) * 100).toFixed(1)) : 0,
    })),
  };
}

function buildImageOptimizationChart(statusMap) {
  const optimized =
    (statusMap.optimized || 0) + (statusMap.metadata_updated || 0);
  const pending = (statusMap.queued || 0) + (statusMap.optimizing || 0);
  const failed = statusMap.failed || 0;
  const skipped = statusMap.skipped || 0;
  const other = (statusMap.restoring || 0) + (statusMap.restored || 0);
  const total = optimized + pending + failed + skipped + other;
  const percentOptimized =
    total > 0 ? Number(((optimized / total) * 100).toFixed(1)) : 0;

  const chart = buildSegments([
    { key: "optimized", label: "Optimized", value: optimized, color: "green" },
    { key: "pending", label: "Pending", value: pending, color: "orange" },
    { key: "failed", label: "Failed", value: failed, color: "red" },
  ]);

  return {
    unit: "images",
    total_images: total,
    optimized_images: optimized,
    pending_images: pending,
    failed_images: failed,
    skipped_images: skipped,
    percent_optimized: percentOptimized,
    summary_label: `${optimized.toLocaleString("en-US")} optimized out of ${total.toLocaleString("en-US")} images`,
    total: chart.total,
    segments: chart.segments,
  };
}

function mergeDailyCounts(groups) {
  const map = new Map();
  for (const rows of groups) {
    for (const row of rows) {
      const key = row._id;
      if (!key) continue;
      map.set(key, (map.get(key) || 0) + (row.count || 0));
    }
  }
  return map;
}

function mergeDailyBytes(groups) {
  const map = new Map();
  for (const rows of groups) {
    for (const row of rows) {
      const key = row._id;
      if (!key) continue;
      map.set(key, (map.get(key) || 0) + (row.bytes || 0));
    }
  }
  return map;
}

function buildCumulativeSparkline(dayLabels, dailyMap, totalNow) {
  const windowSum = dayLabels.reduce(
    (sum, day) => sum + (dailyMap.get(day) || 0),
    0
  );
  const baseline = Math.max(0, (Number(totalNow) || 0) - windowSum);
  let running = baseline;

  return dayLabels.map((day) => {
    running += dailyMap.get(day) || 0;
    return running;
  });
}

function buildStorageSavedTrendChart(dayLabels, dailySavedMap) {
  const points = dayLabels.map((date) => {
    const bytes = dailySavedMap.get(date) || 0;
    return {
      date,
      bytes,
      display: formatBytesDisplay(bytes),
    };
  });
  const totalInWindow = points.reduce((sum, row) => sum + row.bytes, 0);
  const windowDays = dayLabels.length || STORAGE_TREND_WINDOW_DAYS;

  return {
    unit: "bytes",
    labels: dayLabels,
    values: points.map((row) => row.bytes),
    points,
    window_days: windowDays,
    total_in_window: totalInWindow,
    total_in_window_display: formatStorageDisplay(totalInWindow),
    summary_label: `${formatStorageDisplay(totalInWindow)} saved in last ${windowDays} days`,
  };
}

function buildOptimizationByTypeChart(productCount, categoryCount) {
  const chart = buildSegments([
    { key: "product", label: "Product", value: productCount, color: "green" },
    { key: "category", label: "Category", value: categoryCount, color: "orange" },
  ]);

  return {
    unit: "images",
    product_images: productCount,
    category_images: categoryCount,
    summary_label: `${chart.total.toLocaleString("en-US")} optimized images by type`,
    total: chart.total,
    segments: chart.segments,
  };
}

async function getMergedJobItemStatusMap() {
  const [productRows, categoryRows] = await Promise.all([
    ImageJobItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    CategoryJobItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  const statusMap = {};
  for (const rows of [productRows, categoryRows]) {
    for (const row of rows) {
      if (!row?._id) continue;
      statusMap[row._id] = (statusMap[row._id] || 0) + (row.count || 0);
    }
  }

  return statusMap;
}

function activeStoreMatch(asOfDate = null) {
  const match = {
    installStatus: "installed",
    access_token: { $nin: [null, ""] },
  };

  if (asOfDate) {
    match.created_at = { $lte: asOfDate };
    match.$or = [
      { lastUninstalledAt: null },
      { lastUninstalledAt: { $gt: asOfDate } },
    ];
  }

  return match;
}

async function buildUserSparkline(matchBase) {
  const days = getDayBoundaries();
  const facet = {};

  days.forEach((day, index) => {
    facet[`day_${index}`] = [
      { $match: { ...matchBase, created_at: { $lte: day.end } } },
      { $count: "count" },
    ];
  });

  const [result] = await User.aggregate([{ $facet: facet }]);
  return days.map((_, index) => result[`day_${index}`][0]?.count || 0);
}

function payingPlanFilter(asOfDate = null) {
  const filter = {
    base_plan_slug: { $nin: ["free", null, ""] },
    subscription_status: "active",
  };
  if (asOfDate) {
    filter.$or = [
      { started_at: { $lte: asOfDate } },
      { started_at: null, created_at: { $lte: asOfDate } },
    ];
  }
  return filter;
}

async function countPayingStores(asOfDate = null) {
  const plans = await ClientPlan.find(payingPlanFilter(asOfDate))
    .select({ store_hash: 1 })
    .lean();
  const hashes = plans.map((row) => row.store_hash).filter(Boolean);
  if (!hashes.length) return 0;
  return User.countDocuments({
    ...activeStoreMatch(asOfDate),
    store_hash: { $in: hashes },
  });
}

async function buildPayingStoreSparkline() {
  const days = getDayBoundaries();
  const counts = await Promise.all(days.map((day) => countPayingStores(day.end)));
  return counts;
}

/** Completed charges only. Subscription id rows (I-...) are not money captures. */
function revenueChargeMatch(paidBefore = null) {
  const match = {
    status: "COMPLETED",
    transaction_id: { $type: "string", $gt: "" },
  };
  if (paidBefore) {
    match.paid_at = { $lte: paidBefore };
  }
  return match;
}

async function sumRevenue(paidBefore = null) {
  const [row] = await PaymentHistory.aggregate([
    { $match: revenueChargeMatch(paidBefore) },
    { $group: { _id: null, amount: { $sum: "$amount" }, currency: { $first: "$currency" } } },
  ]);
  return {
    amount: Number(row?.amount) || 0,
    currency: row?.currency || "USD",
  };
}

async function sumRevenueBetween(from, to) {
  const paidAt = {};
  if (from) paidAt.$gte = from;
  if (to) paidAt.$lt = to;
  const [row] = await PaymentHistory.aggregate([
    {
      $match: {
        ...revenueChargeMatch(),
        paid_at: paidAt,
      },
    },
    { $group: { _id: null, amount: { $sum: "$amount" }, currency: { $first: "$currency" } } },
  ]);
  return {
    amount: Number(row?.amount) || 0,
    currency: row?.currency || "USD",
  };
}

async function getDailyRevenue(since) {
  const rows = await PaymentHistory.aggregate([
    {
      $match: {
        ...revenueChargeMatch(),
        paid_at: { $gte: since, $ne: null },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$paid_at" } },
        amount: { $sum: "$amount" },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) {
    if (!row?._id) continue;
    map.set(row._id, Number(row.amount) || 0);
  }
  return map;
}

async function buildActiveStoreSparkline() {
  const days = getDayBoundaries();
  const facet = {};

  days.forEach((day, index) => {
    facet[`day_${index}`] = [
      { $match: activeStoreMatch(day.end) },
      { $count: "count" },
    ];
  });

  const [result] = await User.aggregate([{ $facet: facet }]);
  return days.map((_, index) => result[`day_${index}`][0]?.count || 0);
}

async function getDailyOptimizedCounts(since) {
  const match = {
    status: "optimized",
    optimized_at: { $gte: since, $ne: null },
  };
  const group = {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$optimized_at" } },
      count: { $sum: 1 },
    },
  };

  const [product, category] = await Promise.all([
    ImageStatus.aggregate([{ $match: match }, group]),
    CategoryImageStatus.aggregate([{ $match: match }, group]),
  ]);

  return mergeDailyCounts([product, category]);
}

async function getDailySavedBytes(since) {
  const match = {
    status: { $in: OPTIMIZED_JOB_STATUSES },
    completed_at: { $gte: since, $ne: null },
    saved_bytes: { $gt: 0 },
  };
  const group = {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$completed_at" } },
      bytes: { $sum: "$saved_bytes" },
    },
  };

  const [product, category] = await Promise.all([
    ImageJobItem.aggregate([{ $match: match }, group]),
    CategoryJobItem.aggregate([{ $match: match }, group]),
  ]);

  return mergeDailyBytes([product, category]);
}

function buildMetricCard({
  key,
  label,
  value,
  valueFormatted,
  previousValue,
  sparkline,
  color,
  trendLabel = "vs previous 7 days",
}) {
  return {
    key,
    label,
    value,
    value_formatted: valueFormatted,
    trend: buildTrend(value, previousValue, trendLabel),
    sparkline,
    color,
  };
}

exports.getDashboardCards = async () => {
  const dayBoundaries = getDayBoundaries();
  const dayLabels = dayBoundaries.map((day) => day.date);
  const trendWindowStart = getTrendWindowStart();
  const sevenDaysAgoEnd = dayBoundaries[0]?.end || trendWindowStart;
  const monthStart = getTrendWindowStart(30);
  const previousMonthStart = getTrendWindowStart(60);
  const monthDays = getDayBoundaries(30);
  const monthLabels = monthDays.map((day) => day.date);

  const [
    totalClients,
    clientsSevenDaysAgo,
    payingStores,
    payingStoresSevenDaysAgo,
    clientSparkline,
    payingStoreSparkline,
    revenueNow,
    revenueSevenDaysAgo,
    dailyRevenueMap,
    monthlyRevenue,
    previousMonthlyRevenue,
    monthlyDailyRevenueMap,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ created_at: { $lte: sevenDaysAgoEnd } }),
    countPayingStores(),
    countPayingStores(sevenDaysAgoEnd),
    buildUserSparkline({}),
    buildPayingStoreSparkline(),
    sumRevenue(),
    sumRevenue(sevenDaysAgoEnd),
    getDailyRevenue(trendWindowStart),
    sumRevenueBetween(monthStart, null),
    sumRevenueBetween(previousMonthStart, monthStart),
    getDailyRevenue(monthStart),
  ]);

  const cards = [
    buildMetricCard({
      key: "total_clients",
      label: "Total Clients",
      value: totalClients,
      valueFormatted: formatCountDisplay(totalClients),
      previousValue: clientsSevenDaysAgo,
      sparkline: clientSparkline,
      color: "purple",
    }),
    buildMetricCard({
      key: "paying_stores",
      label: "Paying Stores",
      value: payingStores,
      valueFormatted: formatCountDisplay(payingStores),
      previousValue: payingStoresSevenDaysAgo,
      sparkline: payingStoreSparkline,
      color: "blue",
    }),
    buildMetricCard({
      key: "total_revenue",
      label: "Total Revenue",
      value: revenueNow.amount,
      valueFormatted: formatMoneyDisplay(revenueNow.amount, revenueNow.currency),
      previousValue: revenueSevenDaysAgo.amount,
      sparkline: buildCumulativeSparkline(
        dayLabels,
        dailyRevenueMap,
        revenueNow.amount
      ),
      color: "green",
    }),
    buildMetricCard({
      key: "monthly_revenue",
      label: "Monthly Revenue",
      value: monthlyRevenue.amount,
      valueFormatted: formatMoneyDisplay(
        monthlyRevenue.amount,
        monthlyRevenue.currency || revenueNow.currency
      ),
      previousValue: previousMonthlyRevenue.amount,
      sparkline: buildCumulativeSparkline(
        monthLabels,
        monthlyDailyRevenueMap,
        monthlyRevenue.amount
      ),
      color: "orange",
      trendLabel: "vs previous 30 days",
    }),
  ];

  return {
    cards,
    checked_at: new Date().toISOString(),
  };
};

exports.getDashboardStats = async () => {
  const dayBoundaries = getDayBoundaries(STORAGE_TREND_WINDOW_DAYS);
  const dayLabels = dayBoundaries.map((day) => day.date);
  const trendWindowStart = getTrendWindowStart(STORAGE_TREND_WINDOW_DAYS);

  const [jobItemStatusMap, dailySavedMap, productOptimized, categoryOptimized, workerSummary] =
    await Promise.all([
      getMergedJobItemStatusMap(),
      getDailySavedBytes(trendWindowStart),
      ImageStatus.countDocuments({ status: "optimized" }),
      CategoryImageStatus.countDocuments({ status: "optimized" }),
      getWorkerStatusSummary(),
    ]);

  const imageOptimization = buildImageOptimizationChart(jobItemStatusMap);
  const storageSavedTrend = buildStorageSavedTrendChart(dayLabels, dailySavedMap);
  const optimizationByType = buildOptimizationByTypeChart(
    productOptimized,
    categoryOptimized
  );
  const workerStatusChart = buildSegments([
    { key: "running", label: "Running", value: workerSummary.running, color: "green" },
    { key: "stopped", label: "Stopped", value: workerSummary.stopped, color: "grey" },
    { key: "warn", label: "Warning", value: workerSummary.warn, color: "orange" },
    { key: "at_risk", label: "At Risk", value: workerSummary.at_risk, color: "red" },
  ]);

  const cards = {
    total_workers: workerSummary.total_workers,
    running: workerSummary.running,
    stopped: workerSummary.stopped,
    warn: workerSummary.warn,
    at_risk: workerSummary.at_risk,
    pending_jobs: workerSummary.pending_jobs,
    failed_jobs: workerSummary.failed_jobs,
    workers: workerSummary,
  };

  const charts = {
    worker_status: {
      unit: "workers",
      total_workers: workerSummary.total_workers,
      summary_label: workerSummary.summary_label,
      total: workerStatusChart.total,
      segments: workerStatusChart.segments,
    },
    image_optimization: imageOptimization,
    storage_saved_trend: storageSavedTrend,
    optimization_by_type: optimizationByType,
  };

  return {
    cards,
    charts,
    checked_at: new Date().toISOString(),
  };
};
