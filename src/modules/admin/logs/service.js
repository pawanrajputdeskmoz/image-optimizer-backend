const ImageOptimizationLog = require("../../../models/ImageOptimizationLog");
const WebhookLog = require("../../../models/WebhookLog");
const CategoryWebhookLog = require("../../../models/CategoryWebhookLog");
const CategoryImageLog = require("../../../models/CategoryImageLog");
const BrandImageJobLog = require("../../../models/BrandImageJobLog");
const { buildPagination, resolvePagination } = require("../utils/pagination");

const RECENT_ERROR_LOG_LIMIT = 10;

const ERROR_LOG_SOURCES = [
  {
    source: "optimization",
    category: "product-image",
    model: ImageOptimizationLog,
    fields: {
      message: 1,
      created_at: 1,
      store_hash: 1,
      job_uuid: 1,
      job_type: 1,
      step: 1,
    },
  },
  {
    source: "category_image",
    category: "category-image",
    model: CategoryImageLog,
    fields: {
      message: 1,
      created_at: 1,
      store_hash: 1,
      job_uuid: 1,
      job_type: 1,
      step: 1,
      category_id: 1,
    },
  },
  {
    source: "brand_image",
    category: "brand-image",
    model: BrandImageJobLog,
    fields: {
      message: 1,
      created_at: 1,
      store_hash: 1,
      job_uuid: 1,
      job_type: 1,
      step: 1,
      brand_id: 1,
    },
  },
  {
    source: "webhook",
    category: "webhook",
    model: WebhookLog,
    fields: {
      message: 1,
      created_at: 1,
      store_hash: 1,
      trace_id: 1,
      scope: 1,
      step: 1,
      product_id: 1,
      image_id: 1,
    },
  },
  {
    source: "category_webhook",
    category: "category-webhook",
    model: CategoryWebhookLog,
    fields: {
      message: 1,
      created_at: 1,
      store_hash: 1,
      trace_id: 1,
      scope: 1,
      step: 1,
      category_id: 1,
    },
  },
];

function formatTimeAgo(date) {
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function mapErrorLogRow(row, { source, category }) {
  return {
    message: row.message,
    category,
    source,
    created_at: row.created_at,
    time_ago: formatTimeAgo(row.created_at),
    store_hash: row.store_hash || null,
    job_uuid: row.job_uuid || null,
    trace_id: row.trace_id || null,
    step: row.step || null,
    job_type: row.job_type || null,
    scope: row.scope || null,
    product_id: row.product_id ?? null,
    image_id: row.image_id ?? null,
    category_id: row.category_id ?? null,
    brand_id: row.brand_id ?? null,
  };
}

const LOG_SOURCES = {
  optimization: {
    model: ImageOptimizationLog,
    fields: {
      job_uuid: 1,
      store_hash: 1,
      job_type: 1,
      image_id: 1,
      product_id: 1,
      log_type: 1,
      step: 1,
      message: 1,
      meta: 1,
      created_at: 1,
    },
  },
  webhook: {
    model: WebhookLog,
    fields: {
      trace_id: 1,
      store_hash: 1,
      event_hash: 1,
      scope: 1,
      product_id: 1,
      image_id: 1,
      log_type: 1,
      step: 1,
      sequence: 1,
      message: 1,
      meta: 1,
      created_at: 1,
    },
  },
  category_webhook: {
    model: CategoryWebhookLog,
    fields: {
      trace_id: 1,
      store_hash: 1,
      event_hash: 1,
      scope: 1,
      category_id: 1,
      log_type: 1,
      step: 1,
      sequence: 1,
      message: 1,
      meta: 1,
      created_at: 1,
    },
  },
};

function buildLogFilter({ storeHash, jobUuid, logType, step, traceId }) {
  const filter = {};
  if (storeHash) filter.store_hash = storeHash;
  if (logType) filter.log_type = logType;
  if (step) filter.step = step;
  if (jobUuid) filter.job_uuid = jobUuid;
  if (traceId) filter.trace_id = traceId;
  return filter;
}

exports.listLogs = async ({
  source = "optimization",
  page = 1,
  limit = 50,
  storeHash = null,
  jobUuid = null,
  logType = null,
  step = null,
  traceId = null,
}) => {
  const logSource = LOG_SOURCES[source];
  if (!logSource) {
    return {
      error: `Invalid log source. Use: ${Object.keys(LOG_SOURCES).join(", ")}`,
    };
  }

  const { page: resolvedPage, limit: resolvedLimit, skip } = resolvePagination(
    { page, limit },
    { limit: 50 }
  );

  const filter = buildLogFilter({ storeHash, jobUuid, logType, step, traceId });
  const Model = logSource.model;

  const [items, total] = await Promise.all([
    Model.find(filter)
      .select(logSource.fields)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(resolvedLimit)
      .lean(),
    Model.countDocuments(filter),
  ]);

  return {
    error: null,
    source,
    items,
    pagination: buildPagination(resolvedPage, resolvedLimit, total),
  };
};

exports.getLogSources = () =>
  Object.keys(LOG_SOURCES).map((key) => ({
    source: key,
    description:
      key === "optimization"
        ? "Product image optimization job logs"
        : key === "webhook"
          ? "Product webhook activity logs"
          : "Category webhook activity logs",
  }));

exports.getLogsSummary = async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    optimizationTotal,
    optimizationErrors,
    webhookTotal,
    webhookErrors,
    categoryTotal,
    categoryErrors,
  ] = await Promise.all([
    ImageOptimizationLog.countDocuments({ created_at: { $gte: since } }),
    ImageOptimizationLog.countDocuments({
      created_at: { $gte: since },
      log_type: "error",
    }),
    WebhookLog.countDocuments({ created_at: { $gte: since } }),
    WebhookLog.countDocuments({
      created_at: { $gte: since },
      log_type: "error",
    }),
    CategoryWebhookLog.countDocuments({ created_at: { $gte: since } }),
    CategoryWebhookLog.countDocuments({
      created_at: { $gte: since },
      log_type: "error",
    }),
  ]);

  return {
    window_hours: 24,
    since,
    optimization: { total: optimizationTotal, errors: optimizationErrors },
    webhook: { total: webhookTotal, errors: webhookErrors },
    category_webhook: { total: categoryTotal, errors: categoryErrors },
  };
};

exports.getRecentErrorLogs = async (limit = RECENT_ERROR_LOG_LIMIT) => {
  const resolvedLimit = Math.min(
    Math.max(Number(limit) || RECENT_ERROR_LOG_LIMIT, 1),
    50
  );

  const batches = await Promise.all(
    ERROR_LOG_SOURCES.map(async (entry) => {
      const rows = await entry.model
        .find({ log_type: "error" })
        .select(entry.fields)
        .sort({ created_at: -1 })
        .limit(resolvedLimit)
        .lean();

      return rows.map((row) => mapErrorLogRow(row, entry));
    })
  );

  const recentErrors = batches
    .flat()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, resolvedLimit);

  return {
    recent_errors: recentErrors,
    count: recentErrors.length,
    limit: resolvedLimit,
  };
};

exports.getLogTrace = async (source, traceId) => {
  if (source === "optimization") {
    return { error: "Use job_uuid filter for optimization logs", items: [] };
  }

  const logSource = LOG_SOURCES[source];
  if (!logSource) {
    return { error: "Invalid log source", items: [] };
  }

  const items = await logSource.model
    .find({ trace_id: traceId })
    .select(logSource.fields)
    .sort({ sequence: 1, created_at: 1 })
    .lean();

  return { error: null, items };
};
