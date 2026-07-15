const ImageJob = require("../models/ImageJob");
const CategoryJob = require("../models/CategoryJob");
const BrandJob = require("../models/BrandJob");

const BULK_ENTITY_TYPES = ["product", "category", "brand"];
const RUNNING_JOB_STATUSES = ["pending", "fetching", "processing"];
const BLOCKING_JOB_STATUSES = [...RUNNING_JOB_STATUSES, "paused_plan_limit"];
const FULL_BULK_OPTIMIZATION_JOB_TYPES = ["bulk"];
const CHECKBOX_OPTIMIZATION_JOB_TYPES = ["checkBox"];
const BULK_OPTIMIZATION_JOB_TYPES = [
  ...FULL_BULK_OPTIMIZATION_JOB_TYPES,
  ...CHECKBOX_OPTIMIZATION_JOB_TYPES,
];
const BULK_RESTORE_JOB_TYPES = ["restore_bulk", "restore_checkbox"];

const ENTITY_JOB_MODEL = {
  product: ImageJob,
  category: CategoryJob,
  brand: BrandJob,
};

const ENTITY_LABELS = {
  product: "Product",
  category: "Category",
  brand: "Brand",
};

function isBulkEntityType(entityType) {
  return BULK_ENTITY_TYPES.includes(entityType);
}

async function hasActiveJob(storeHash, entityType, jobTypes, statuses = BLOCKING_JOB_STATUSES) {
  if (!storeHash || !isBulkEntityType(entityType)) {
    return false;
  }

  const Model = ENTITY_JOB_MODEL[entityType];
  const exists = await Model.exists({
    store_hash: storeHash,
    status: { $in: statuses },
    job_type: { $in: jobTypes },
  });

  return Boolean(exists);
}

async function isFullBulkOptimizationActive(storeHash, entityType) {
  return hasActiveJob(
    storeHash,
    entityType,
    FULL_BULK_OPTIMIZATION_JOB_TYPES,
    BLOCKING_JOB_STATUSES
  );
}

async function isBulkOptimizationActive(storeHash, entityType) {
  return hasActiveJob(storeHash, entityType, BULK_OPTIMIZATION_JOB_TYPES, BLOCKING_JOB_STATUSES);
}

async function isBulkRestoreActive(storeHash, entityType) {
  return hasActiveJob(storeHash, entityType, BULK_RESTORE_JOB_TYPES, BLOCKING_JOB_STATUSES);
}

async function isBulkOptimizationRunning(storeHash, entityType) {
  return hasActiveJob(storeHash, entityType, BULK_OPTIMIZATION_JOB_TYPES, RUNNING_JOB_STATUSES);
}

async function isBulkRestoreRunning(storeHash, entityType) {
  return hasActiveJob(storeHash, entityType, BULK_RESTORE_JOB_TYPES, RUNNING_JOB_STATUSES);
}

async function getEntityBulkActivity(storeHash, entityType) {
  const [optimization, restore] = await Promise.all([
    isBulkOptimizationActive(storeHash, entityType),
    isBulkRestoreActive(storeHash, entityType),
  ]);

  return { optimization, restore };
}

/** Active full-store bulk job only — used to block another bulk run (not checkbox). */
async function getEntityFullBulkBlockActivity(storeHash, entityType) {
  const [optimization, restore] = await Promise.all([
    isFullBulkOptimizationActive(storeHash, entityType),
    isBulkRestoreActive(storeHash, entityType),
  ]);

  return { optimization, restore };
}

async function buildActivityMap(storeHash, checker) {
  if (!storeHash) {
    return { product: false, category: false, brand: false };
  }

  const [product, category, brand] = await Promise.all(
    BULK_ENTITY_TYPES.map((type) => checker(storeHash, type))
  );

  return { product, category, brand };
}

async function getActiveBulkOptimizationMap(storeHash) {
  return buildActivityMap(storeHash, isBulkOptimizationActive);
}

async function getActiveBulkRestoreMap(storeHash) {
  return buildActivityMap(storeHash, isBulkRestoreActive);
}

async function getRunningBulkOptimizationMap(storeHash) {
  return buildActivityMap(storeHash, isBulkOptimizationRunning);
}

async function getRunningBulkRestoreMap(storeHash) {
  return buildActivityMap(storeHash, isBulkRestoreRunning);
}

async function isAnyBulkOptimizationActive(storeHash) {
  const map = await getActiveBulkOptimizationMap(storeHash);
  return map.product || map.category || map.brand;
}

module.exports = {
  BULK_ENTITY_TYPES,
  FULL_BULK_OPTIMIZATION_JOB_TYPES,
  CHECKBOX_OPTIMIZATION_JOB_TYPES,
  BULK_OPTIMIZATION_JOB_TYPES,
  BULK_RESTORE_JOB_TYPES,
  ENTITY_LABELS,
  RUNNING_JOB_STATUSES,
  BLOCKING_JOB_STATUSES,
  isBulkEntityType,
  isFullBulkOptimizationActive,
  isBulkOptimizationActive,
  isBulkRestoreActive,
  isBulkOptimizationRunning,
  isBulkRestoreRunning,
  getEntityBulkActivity,
  getEntityFullBulkBlockActivity,
  getActiveBulkOptimizationMap,
  getActiveBulkRestoreMap,
  getRunningBulkOptimizationMap,
  getRunningBulkRestoreMap,
  isAnyBulkOptimizationActive,
};
