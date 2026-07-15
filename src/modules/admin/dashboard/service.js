const User = require("../../../models/User");
const ImageStatus = require("../../../models/ImageStatus");
const CategoryImageStatus = require("../../../models/CategoryImageStatus");
const BrandImageStatus = require("../../../models/BrandImageStatus");
const ImageJobItem = require("../../../models/ImageJobItem");
const CategoryJobItem = require("../../../models/CategoryJobItem");
const BrandJobItem = require("../../../models/BrandJobItem");
const StoreImageStat = require("../../../models/StoreImageStat");
const {
  getWorkerStatusSummary,
} = require("../workers/service");
const {
  checkMongoHealth,
  checkRedisHealth,
} = require("../health/service");

const OPTIMIZED_JOB_STATUSES = ["optimized", "metadata_updated"];
const TREND_WINDOW_DAYS = 7;

function getDayBoundaries() {
  const days = [];
  const now = new Date();

  for (let offset = TREND_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
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

function getTrendWindowStart() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (TREND_WINDOW_DAYS - 1));
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

function serviceStatusLabel(ok) {
  return {
    status: ok ? "ok" : "error",
    label: ok ? "Ok" : "Error",
  };
}

function buildTrend(current, previous) {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;

  if (previousValue <= 0) {
    const percent = currentValue > 0 ? 100 : 0;
    return {
      direction: currentValue > 0 ? "up" : "neutral",
      percent,
      label: "vs previous 7 days",
    };
  }

  const change = ((currentValue - previousValue) / previousValue) * 100;
  return {
    direction: change > 0 ? "up" : change < 0 ? "down" : "neutral",
    percent: Number(Math.abs(change).toFixed(1)),
    label: "vs previous 7 days",
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

  return {
    unit: "bytes",
    labels: dayLabels,
    values: points.map((row) => row.bytes),
    points,
    total_in_window: totalInWindow,
    total_in_window_display: formatStorageDisplay(totalInWindow),
    summary_label: `${formatStorageDisplay(totalInWindow)} saved in last 7 days`,
  };
}

function buildOptimizationByTypeChart(productCount, categoryCount, brandCount) {
  const chart = buildSegments([
    { key: "product", label: "Product", value: productCount, color: "green" },
    { key: "category", label: "Category", value: categoryCount, color: "orange" },
    { key: "brand", label: "Brand", value: brandCount, color: "blue" },
  ]);

  return {
    unit: "images",
    product_images: productCount,
    category_images: categoryCount,
    brand_images: brandCount,
    summary_label: `${chart.total.toLocaleString("en-US")} optimized images by type`,
    total: chart.total,
    segments: chart.segments,
  };
}

async function getMergedJobItemStatusMap() {
  const [productRows, categoryRows, brandRows] = await Promise.all([
    ImageJobItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    CategoryJobItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    BrandJobItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  const statusMap = {};
  for (const rows of [productRows, categoryRows, brandRows]) {
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

  const [product, category, brand] = await Promise.all([
    ImageStatus.aggregate([{ $match: match }, group]),
    CategoryImageStatus.aggregate([{ $match: match }, group]),
    BrandImageStatus.aggregate([{ $match: match }, group]),
  ]);

  return mergeDailyCounts([product, category, brand]);
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

  const [product, category, brand] = await Promise.all([
    ImageJobItem.aggregate([{ $match: match }, group]),
    CategoryJobItem.aggregate([{ $match: match }, group]),
    BrandJobItem.aggregate([{ $match: match }, group]),
  ]);

  return mergeDailyBytes([product, category, brand]);
}

function buildMetricCard({
  key,
  label,
  value,
  valueFormatted,
  previousValue,
  sparkline,
  color,
}) {
  return {
    key,
    label,
    value,
    value_formatted: valueFormatted,
    trend: buildTrend(value, previousValue),
    sparkline,
    color,
  };
}

exports.getDashboardCards = async () => {
  const dayBoundaries = getDayBoundaries();
  const dayLabels = dayBoundaries.map((day) => day.date);
  const trendWindowStart = getTrendWindowStart();
  const sevenDaysAgoEnd = dayBoundaries[0]?.end || trendWindowStart;

  const optimizedMatch = {
    status: "optimized",
    optimized_at: { $gte: trendWindowStart, $ne: null },
  };
  const savedMatch = {
    status: { $in: OPTIMIZED_JOB_STATUSES },
    completed_at: { $gte: trendWindowStart, $ne: null },
    saved_bytes: { $gt: 0 },
  };
  const savedGroup = { $group: { _id: null, bytes: { $sum: "$saved_bytes" } } };

  const [
    aggregateStats,
    totalClients,
    clientsSevenDaysAgo,
    activeStores,
    activeStoresSevenDaysAgo,
    clientSparkline,
    activeStoreSparkline,
    dailyOptimizedMap,
    dailySavedMap,
    productOptimized7d,
    categoryOptimized7d,
    brandOptimized7d,
    productSaved7d,
    categorySaved7d,
    brandSaved7d,
  ] = await Promise.all([
    StoreImageStat.aggregate([
      {
        $group: {
          _id: null,
          optimized_images: { $sum: "$optimized_images" },
          total_saved_bytes: { $sum: "$total_saved_bytes" },
        },
      },
    ]),
    User.countDocuments(),
    User.countDocuments({ created_at: { $lte: sevenDaysAgoEnd } }),
    User.countDocuments(activeStoreMatch()),
    User.countDocuments(activeStoreMatch(sevenDaysAgoEnd)),
    buildUserSparkline({}),
    buildActiveStoreSparkline(),
    getDailyOptimizedCounts(trendWindowStart),
    getDailySavedBytes(trendWindowStart),
    ImageStatus.countDocuments(optimizedMatch),
    CategoryImageStatus.countDocuments(optimizedMatch),
    BrandImageStatus.countDocuments(optimizedMatch),
    ImageJobItem.aggregate([{ $match: savedMatch }, savedGroup]),
    CategoryJobItem.aggregate([{ $match: savedMatch }, savedGroup]),
    BrandJobItem.aggregate([{ $match: savedMatch }, savedGroup]),
  ]);

  const optimizedInLast7Days =
    productOptimized7d + categoryOptimized7d + brandOptimized7d;
  const savedBytesInLast7Days =
    (productSaved7d[0]?.bytes || 0) +
    (categorySaved7d[0]?.bytes || 0) +
    (brandSaved7d[0]?.bytes || 0);

  const statTotals = aggregateStats[0] || {
    optimized_images: 0,
    total_saved_bytes: 0,
  };

  const totalOptimizedImages = Number(statTotals.optimized_images) || 0;
  const totalSavedBytes = Number(statTotals.total_saved_bytes) || 0;
  const previousOptimizedImages = Math.max(
    0,
    totalOptimizedImages - optimizedInLast7Days
  );
  const previousSavedBytes = Math.max(
    0,
    totalSavedBytes - savedBytesInLast7Days
  );

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
      key: "active_stores",
      label: "Active Stores",
      value: activeStores,
      valueFormatted: formatCountDisplay(activeStores),
      previousValue: activeStoresSevenDaysAgo,
      sparkline: activeStoreSparkline,
      color: "blue",
    }),
    buildMetricCard({
      key: "total_optimized_images",
      label: "Total Optimized Images",
      value: totalOptimizedImages,
      valueFormatted: formatCountDisplay(totalOptimizedImages),
      previousValue: previousOptimizedImages,
      sparkline: buildCumulativeSparkline(
        dayLabels,
        dailyOptimizedMap,
        totalOptimizedImages
      ),
      color: "green",
    }),
    buildMetricCard({
      key: "storage_saved",
      label: "Storage Saved",
      value: totalSavedBytes,
      valueFormatted: formatStorageDisplay(totalSavedBytes),
      previousValue: previousSavedBytes,
      sparkline: buildCumulativeSparkline(
        dayLabels,
        dailySavedMap,
        totalSavedBytes
      ),
      color: "orange",
    }),
  ];

  return {
    cards,
    checked_at: new Date().toISOString(),
  };
};

exports.getDashboardStats = async () => {
  const dayBoundaries = getDayBoundaries();
  const dayLabels = dayBoundaries.map((day) => day.date);
  const trendWindowStart = getTrendWindowStart();

  const [mongodb, redis, aggregateStats, jobItemStatusMap, dailySavedMap, productOptimized, categoryOptimized, brandOptimized, totalClients, activeStores, workerSummary] =
    await Promise.all([
      checkMongoHealth(),
      checkRedisHealth(),
      StoreImageStat.aggregate([
        {
          $group: {
            _id: null,
            optimized_images: { $sum: "$optimized_images" },
            total_saved_bytes: { $sum: "$total_saved_bytes" },
            total_original_size: { $sum: "$total_original_size" },
            average_saving_percent: { $avg: "$average_saving_percent" },
          },
        },
      ]),
      getMergedJobItemStatusMap(),
      getDailySavedBytes(trendWindowStart),
      ImageStatus.countDocuments({ status: "optimized" }),
      CategoryImageStatus.countDocuments({ status: "optimized" }),
      BrandImageStatus.countDocuments({ status: "optimized" }),
      User.countDocuments(),
      User.countDocuments(activeStoreMatch()),
      getWorkerStatusSummary(),
    ]);

  const statTotals = aggregateStats[0] || {
    optimized_images: 0,
    total_saved_bytes: 0,
    total_original_size: 0,
    average_saving_percent: 0,
  };

  const optimizedImages = Number(statTotals.optimized_images) || 0;
  const totalSavedBytes = Number(statTotals.total_saved_bytes) || 0;
  const avgSavingPercent =
    statTotals.average_saving_percent != null
      ? Number(Number(statTotals.average_saving_percent).toFixed(1))
      : statTotals.total_original_size > 0
        ? Number(
            (
              (totalSavedBytes / Number(statTotals.total_original_size)) *
              100
            ).toFixed(1)
          )
        : 0;

  const imageOptimization = buildImageOptimizationChart(jobItemStatusMap);
  const storageSavedTrend = buildStorageSavedTrendChart(dayLabels, dailySavedMap);
  const optimizationByType = buildOptimizationByTypeChart(
    productOptimized,
    categoryOptimized,
    brandOptimized
  );
  const workerStatusChart = buildSegments([
    { key: "running", label: "Running", value: workerSummary.running, color: "green" },
    { key: "stopped", label: "Stopped", value: workerSummary.stopped, color: "grey" },
    { key: "warn", label: "Warning", value: workerSummary.warn, color: "orange" },
    { key: "at_risk", label: "At Risk", value: workerSummary.at_risk, color: "red" },
  ]);

  const cards = {
    total_clients: totalClients,
    active_stores: activeStores,
    total_workers: workerSummary.total_workers,
    running: workerSummary.running,
    stopped: workerSummary.stopped,
    warn: workerSummary.warn,
    at_risk: workerSummary.at_risk,
    pending_jobs: workerSummary.pending_jobs,
    failed_jobs: workerSummary.failed_jobs,
    workers: workerSummary,
    optimized_images: optimizedImages,
    total_saved: {
      bytes: totalSavedBytes,
      value: formatBytesDisplay(totalSavedBytes),
      average_saving_percent: avgSavingPercent,
    },
    redis: serviceStatusLabel(redis.ok),
    database: serviceStatusLabel(mongodb.ok),
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
