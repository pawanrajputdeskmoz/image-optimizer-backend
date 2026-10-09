const ImageStatus = require("../../../models/ImageStatus");
const CategoryImageStatus = require("../../../models/CategoryImageStatus");
const { buildPagination, resolvePagination } = require("../utils/pagination");

const PRODUCT_SOURCE = "product";
const CATEGORY_SOURCE = "category";
const SUPPORTED_SOURCES = new Set([PRODUCT_SOURCE, CATEGORY_SOURCE]);

function parseDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // YYYY-MM-DD from <input type="date">
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(
      `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildBaseMatch({ storeHash, status, dateFrom, dateTo }) {
  const match = {};

  if (storeHash) match.store_hash = storeHash;
  if (status) match.status = status;

  const from = parseDateBoundary(dateFrom, false);
  const to = parseDateBoundary(dateTo, true);
  if (from || to) {
    // Pending rows often have null optimized_at — fall back to created_at.
    const dateExpr = [];
    if (from) {
      dateExpr.push({
        $gte: [{ $ifNull: ["$optimized_at", "$created_at"] }, from],
      });
    }
    if (to) {
      dateExpr.push({
        $lte: [{ $ifNull: ["$optimized_at", "$created_at"] }, to],
      });
    }
    match.$expr = { $and: dateExpr };
  }

  return match;
}

function productProjectStage() {
  return {
    $project: {
      _id: 1,
      store_hash: 1,
      source_type: { $literal: PRODUCT_SOURCE },
      source_id: "$product_id",
      image_id: 1,
      status: 1,
      optimized_at: 1,
      created_at: 1,
      original_size: {
        $ifNull: [{ $arrayElemAt: ["$old.original.size", 0] }, 0],
      },
      optimized_size: {
        $ifNull: [{ $arrayElemAt: ["$old.optimized.size", 0] }, 0],
      },
      saved_size: {
        $ifNull: [{ $arrayElemAt: ["$old.saved_bytes", 0] }, 0],
      },
      compression_percent: {
        $ifNull: [{ $arrayElemAt: ["$old.saved_percentage", 0] }, 0],
      },
      error_message: { $literal: null },
      sort_at: { $ifNull: ["$optimized_at", "$created_at"] },
    },
  };
}

function categoryProjectStage() {
  return {
    $project: {
      _id: 1,
      store_hash: 1,
      source_type: { $literal: CATEGORY_SOURCE },
      source_id: "$category_id",
      image_id: "$category_id",
      status: 1,
      optimized_at: 1,
      created_at: 1,
      original_size: {
        $ifNull: [{ $arrayElemAt: ["$cat.original.size", 0] }, 0],
      },
      optimized_size: {
        $ifNull: [{ $arrayElemAt: ["$cat.optimized.size", 0] }, 0],
      },
      saved_size: {
        $ifNull: [{ $arrayElemAt: ["$cat.saved_bytes", 0] }, 0],
      },
      compression_percent: {
        $ifNull: [{ $arrayElemAt: ["$cat.saved_percentage", 0] }, 0],
      },
      error_message: { $literal: null },
      sort_at: { $ifNull: ["$optimized_at", "$created_at"] },
    },
  };
}

function productLookupStages() {
  return [
    {
      $lookup: {
        from: "image_old_datas",
        let: {
          storeHash: "$store_hash",
          productId: "$product_id",
          imageId: "$image_id",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$store_hash", "$$storeHash"] },
                  { $eq: ["$product_id", "$$productId"] },
                  { $eq: ["$image_id", "$$imageId"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "old",
      },
    },
    productProjectStage(),
  ];
}

function categoryLookupStages() {
  return [
    {
      $lookup: {
        from: "category_images",
        let: {
          storeHash: "$store_hash",
          categoryId: "$category_id",
          categoryImageId: "$category_image_id",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  {
                    $and: [
                      { $eq: ["$store_hash", "$$storeHash"] },
                      { $eq: ["$_id", "$$categoryImageId"] },
                    ],
                  },
                  {
                    $and: [
                      { $eq: ["$store_hash", "$$storeHash"] },
                      { $eq: ["$category_id", "$$categoryId"] },
                    ],
                  },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "cat",
      },
    },
    categoryProjectStage(),
  ];
}

function emptySummary() {
  return {
    total_images: 0,
    optimized_images: 0,
    failed_images: 0,
    pending_images: 0,
    skipped_images: 0,
    total_original_size: 0,
    total_optimized_size: 0,
    total_saved_size: 0,
    average_compression_percent: 0,
    last_optimized_at: null,
  };
}

function buildSummaryFromFacet(rows) {
  const summary = emptySummary();
  let compressionSum = 0;
  let compressionCount = 0;
  let lastOptimized = null;

  for (const row of rows) {
    const status = String(row._id || "").toLowerCase();
    const count = Number(row.count) || 0;
    summary.total_images += count;

    if (status === "optimized" || status === "uploaded" || status === "metadata_updated") {
      summary.optimized_images += count;
    } else if (status === "failed") {
      summary.failed_images += count;
    } else if (status === "skipped") {
      summary.skipped_images += count;
    } else if (
      status === "pending" ||
      status === "optimizing" ||
      status === "processing"
    ) {
      summary.pending_images += count;
    } else {
      summary.pending_images += count;
    }

    summary.total_original_size += Number(row.total_original_size) || 0;
    summary.total_optimized_size += Number(row.total_optimized_size) || 0;
    summary.total_saved_size += Number(row.total_saved_size) || 0;
    compressionSum += Number(row.compression_sum) || 0;
    compressionCount += Number(row.compression_count) || 0;

    if (row.last_optimized_at) {
      const at = new Date(row.last_optimized_at);
      if (!Number.isNaN(at.getTime())) {
        if (!lastOptimized || at > lastOptimized) lastOptimized = at;
      }
    }
  }

  summary.average_compression_percent =
    compressionCount > 0
      ? Number((compressionSum / compressionCount).toFixed(1))
      : 0;
  summary.last_optimized_at = lastOptimized ? lastOptimized.toISOString() : null;

  return summary;
}

function formatItem(row) {
  return {
    _id: String(row._id),
    store_hash: row.store_hash || null,
    source_type: row.source_type || null,
    source_id: row.source_id ?? null,
    image_id: row.image_id ?? null,
    original_size: Number(row.original_size) || 0,
    optimized_size: Number(row.optimized_size) || 0,
    saved_size: Number(row.saved_size) || 0,
    compression_percent: Number(row.compression_percent) || 0,
    status: row.status || null,
    error_message: row.error_message || null,
    optimized_at: row.optimized_at
      ? new Date(row.optimized_at).toISOString()
      : null,
  };
}

exports.listImageStats = async ({
  storeHash = null,
  sourceType = null,
  status = null,
  dateFrom = null,
  dateTo = null,
  page = 1,
  limit = 20,
} = {}) => {
  const normalizedSource = sourceType ? String(sourceType).trim().toLowerCase() : "";
  if (normalizedSource && !SUPPORTED_SOURCES.has(normalizedSource)) {
    const { page: resolvedPage, limit: resolvedLimit } = resolvePagination({
      page,
      limit,
    });
    return {
      items: [],
      pagination: buildPagination(resolvedPage, resolvedLimit, 0),
      summary: emptySummary(),
    };
  }

  const includeProduct =
    !normalizedSource || normalizedSource === PRODUCT_SOURCE;
  const includeCategory =
    !normalizedSource || normalizedSource === CATEGORY_SOURCE;

  const match = buildBaseMatch({
    storeHash: storeHash ? String(storeHash).trim() : null,
    status: status ? String(status).trim().toLowerCase() : null,
    dateFrom,
    dateTo,
  });

  const { page: resolvedPage, limit: resolvedLimit, skip } = resolvePagination({
    page,
    limit,
  });

  const summaryGroup = {
    $group: {
      _id: "$status",
      count: { $sum: 1 },
      total_original_size: { $sum: { $ifNull: ["$original_size", 0] } },
      total_optimized_size: { $sum: { $ifNull: ["$optimized_size", 0] } },
      total_saved_size: { $sum: { $ifNull: ["$saved_size", 0] } },
      compression_sum: { $sum: { $ifNull: ["$compression_percent", 0] } },
      compression_count: {
        $sum: {
          $cond: [{ $gt: [{ $ifNull: ["$compression_percent", 0] }, 0] }, 1, 0],
        },
      },
      last_optimized_at: { $max: "$optimized_at" },
    },
  };

  const facetStage = {
    $facet: {
      items: [
        { $sort: { sort_at: -1, _id: -1 } },
        { $skip: skip },
        { $limit: resolvedLimit },
      ],
      total: [{ $count: "count" }],
      by_status: [summaryGroup],
    },
  };

  let pipeline;

  if (includeProduct && includeCategory) {
    pipeline = [
      { $match: match },
      ...productLookupStages(),
      {
        $unionWith: {
          coll: "category_image_statuses",
          pipeline: [{ $match: match }, ...categoryLookupStages()],
        },
      },
      facetStage,
    ];
  } else if (includeProduct) {
    pipeline = [{ $match: match }, ...productLookupStages(), facetStage];
  } else {
    pipeline = [{ $match: match }, ...categoryLookupStages(), facetStage];
  }

  const Model = includeProduct ? ImageStatus : CategoryImageStatus;
  const [result] = await Model.aggregate(pipeline).allowDiskUse(true);
  const total = result?.total?.[0]?.count || 0;
  const items = (result?.items || []).map(formatItem);
  const summary = buildSummaryFromFacet(result?.by_status || []);

  return {
    items,
    pagination: buildPagination(resolvedPage, resolvedLimit, total),
    summary,
  };
};
