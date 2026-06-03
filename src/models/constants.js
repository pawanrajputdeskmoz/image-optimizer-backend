/**
 * Shared enums for image optimization models.
 *
 * Status layers:
 * - IMAGE_JOB_STATUSES: whole run (ImageJob / ImageOptimizationJob collection)
 * - IMAGE_JOB_ITEM_STATUSES: per image inside one run (ImageJobItem)
 * - IMAGE_STATUS_VALUES: long-lived per-store image state (ImageStatus)
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
  "download",
  "upload",
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
};
