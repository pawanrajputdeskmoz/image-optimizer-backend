/**
 * Shared enums for image optimization models.
 *
 * Status layers:
 * - IMAGE_JOB_STATUSES: whole run (ImageJob / ImageOptimizationJob collection)
 * - IMAGE_JOB_ITEM_STATUSES: per image inside one run (ImageJobItem)
 * - IMAGE_STATUS_VALUES: long-lived per-store image state (ImageStatus)
 * - StoreImageStat: store-wide optimization totals (products, etc.)
 */

const JOB_TYPES = [
  "single",
  "bulk",
  "webhook",
  "reoptimize",
  "checkBox",
  "restore_single",
  "restore_bulk",
  "restore_checkbox",
];

const JOB_TYPES_SET = new Set(JOB_TYPES);

const IMAGE_JOB_STATUSES = ["pending", "processing", "completed", "failed"];

const IMAGE_JOB_ITEM_STATUSES = [
  "queued",
  "optimizing",
  "optimized",
  "metadata_updated",
  "restoring",
  "restored",
  "failed",
  "skipped",
];

const IMAGE_STATUS_VALUES = ["pending", "optimizing", "optimized", "failed"];

const IMAGE_UPDATE_STATUS_VALUES = [
  "pending",
  "processing",
  "complete",
  "failed",
];

const LOG_TYPES = ["info", "warning", "error"];

const LOG_STEPS = [
  "queue",
  "skip",
  "skip_upload",
  "download",
  "upload",
  "verify",
  "optimize",
  "optimize_failed",
  "restore",
  "restore_failed",
  "bc_delete",
  "bc_metadata",
  "stat_update",
  "rollback",
  "file_cleanup",
  "worker",
  "complete",
];

const RESTORE_JOB_TYPES = [
  "restore_single",
  "restore_bulk",
  "restore_checkbox",
];

const RESTORE_JOB_TYPES_SET = new Set(RESTORE_JOB_TYPES);

function isRestoreJobType(jobType) {
  return RESTORE_JOB_TYPES_SET.has(String(jobType || "").trim());
}

function normalizeJobType(jobType) {
  const value = String(jobType || "").trim();
  return JOB_TYPES_SET.has(value) ? value : null;
}

const HOME_BANNER_SOURCE_TYPES = [
  "widget",
  "marketing_banner",
  "content_page",
  "storefront_html",
];

const HOME_BANNER_OPTIMIZATION_STATUSES = [
  "pending",
  "optimizing",
  "optimized",
  "failed",
  "skipped",
];

const CATEGORY_IMAGE_STATUS_VALUES = [
  "pending",
  "optimizing",
  "optimized",
  "failed",
  "processing",
  "uploaded",
  "skipped",
];

const CATEGORY_IMAGE_UPDATE_STATUS_VALUES = [
  "pending",
  "processing",
  "complete",
  "failed",
];

module.exports = {
  JOB_TYPES,
  JOB_TYPES_SET,
  RESTORE_JOB_TYPES,
  RESTORE_JOB_TYPES_SET,
  isRestoreJobType,
  normalizeJobType,
  IMAGE_JOB_STATUSES,
  IMAGE_JOB_ITEM_STATUSES,
  IMAGE_STATUS_VALUES,
  IMAGE_UPDATE_STATUS_VALUES,
  LOG_TYPES,
  LOG_STEPS,
  HOME_BANNER_SOURCE_TYPES,
  HOME_BANNER_OPTIMIZATION_STATUSES,
  CATEGORY_IMAGE_STATUS_VALUES,
  CATEGORY_IMAGE_UPDATE_STATUS_VALUES,
};
