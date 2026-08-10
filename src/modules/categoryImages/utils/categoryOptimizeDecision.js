const {
  extractCategoryImageAssetId,
} = require("./categoryImageUrlUtils");

const OPTIMIZED_STATUSES = new Set(["optimized", "uploaded"]);
const IN_PROGRESS_STATUSES = new Set(["optimizing", "processing"]);

/**
 * Decide whether to skip, cleanup, and/or proceed with category image optimization.
 *
 * Rules:
 * - force → cleanup + optimize
 * - no DB status row → optimize (no cleanup needed; cleanup is a no-op)
 * - in progress → skip
 * - optimized/uploaded + same optimized_asset_id as live URL → skip
 * - different / missing asset_id or other status → cleanup + optimize
 */
function resolveCategoryOptimizeDecision({
  force = false,
  statusRow = null,
  liveImageUrl = null,
} = {}) {
  const status = String(statusRow?.status || "").toLowerCase();
  const liveAssetId = extractCategoryImageAssetId(liveImageUrl);
  const storedAssetId =
    statusRow?.optimized_asset_id != null &&
    String(statusRow.optimized_asset_id).trim() !== ""
      ? String(statusRow.optimized_asset_id)
      : null;

  if (force) {
    return {
      skip: false,
      shouldCleanup: true,
      reason: "force_reoptimize",
      status: status || null,
      liveAssetId,
      storedAssetId,
    };
  }

  if (IN_PROGRESS_STATUSES.has(status)) {
    return {
      skip: true,
      shouldCleanup: false,
      reason: "Category image is currently being optimized",
      status,
      liveAssetId,
      storedAssetId,
    };
  }

  if (!statusRow) {
    return {
      skip: false,
      shouldCleanup: false,
      reason: "no_existing_record",
      status: null,
      liveAssetId,
      storedAssetId: null,
    };
  }

  const assetMatches =
    Boolean(storedAssetId) &&
    Boolean(liveAssetId) &&
    storedAssetId === String(liveAssetId);

  if (OPTIMIZED_STATUSES.has(status) && assetMatches) {
    return {
      skip: true,
      shouldCleanup: false,
      reason: "Category image already optimized",
      status,
      liveAssetId,
      storedAssetId,
    };
  }

  return {
    skip: false,
    shouldCleanup: true,
    reason:
      !storedAssetId || !liveAssetId || storedAssetId !== String(liveAssetId)
        ? "optimized_asset_id_changed"
        : "reoptimize_stale_status",
    status,
    liveAssetId,
    storedAssetId,
  };
}

module.exports = {
  resolveCategoryOptimizeDecision,
  OPTIMIZED_STATUSES,
  IN_PROGRESS_STATUSES,
};
