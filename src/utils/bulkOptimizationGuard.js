const {
  BULK_ENTITY_TYPES,
  FULL_BULK_OPTIMIZATION_JOB_TYPES,
  BULK_OPTIMIZATION_JOB_TYPES,
  ENTITY_LABELS,
  isBulkEntityType,
  isFullBulkOptimizationActive,
  getEntityFullBulkBlockActivity,
  getActiveBulkOptimizationMap,
  getActiveBulkRestoreMap,
  isAnyBulkOptimizationActive,
} = require("./bulkEntityActivity");

const ENTITY_LABELS_LOWER = {
  product: "product",
  category: "category",
  brand: "brand",
};

function isBulkOptimizationJobType(jobType) {
  return BULK_OPTIMIZATION_JOB_TYPES.includes(jobType);
}

function isFullBulkOptimizationJobType(jobType) {
  return FULL_BULK_OPTIMIZATION_JOB_TYPES.includes(jobType);
}

function buildBulkBlockedMessage(entityType) {
  const label = ENTITY_LABELS[entityType] || "Image";
  return `${label} bulk optimization is already in progress. Please wait until the current job completes.`;
}

function buildBulkBlockedByRestoreMessage(entityType) {
  const label = ENTITY_LABELS[entityType] || "Image";
  return `${label} bulk restore is already in progress. Please wait until it completes before starting optimization.`;
}

function buildBulkQueuedMessage(entityType) {
  const label = ENTITY_LABELS[entityType] || "Image";
  return `${label} bulk optimization has been added to the queue.`;
}

function buildBulkAlreadyQueuedMessage(entityType) {
  return `${ENTITY_LABELS[entityType] || "Image"} images are already queued for optimization.`;
}

function buildPartialBulkMessage(blockedTypes = [], queuedTypes = []) {
  const blocked = blockedTypes.filter(isBulkEntityType);
  const queued = queuedTypes.filter(isBulkEntityType);

  if (blocked.length === 1 && queued.length === 1) {
    return `${buildBulkAlreadyQueuedMessage(blocked[0])} ${buildBulkQueuedMessage(queued[0])}`;
  }

  const blockedText = blocked
    .map((type) => `${ENTITY_LABELS[type]} images are already queued for optimization`)
    .join(". ");
  const queuedText = queued
    .map((type) => `${ENTITY_LABELS[type]} optimization has been added to the queue`)
    .join(". ");

  return [blockedText, queuedText].filter(Boolean).join(". ");
}

async function buildBulkBlockedResponse(storeHash, entityType, activity) {
  const { optimization, restore } =
    activity || (await getEntityFullBulkBlockActivity(storeHash, entityType));

  const [active_bulk_jobs, active_bulk_restores] = await Promise.all([
    getActiveBulkOptimizationMap(storeHash),
    getActiveBulkRestoreMap(storeHash),
  ]);

  const blockedBy = optimization ? "optimization" : "restore";
  const message = optimization
    ? buildBulkBlockedMessage(entityType)
    : buildBulkBlockedByRestoreMessage(entityType);

  return {
    success: false,
    blocked: true,
    entity_type: entityType,
    blocked_by: blockedBy,
    active_job: optimization,
    active_restore: restore,
    active_bulk_jobs,
    active_bulk_restores,
    message,
  };
}

async function replyIfBulkOptimizationBlocked(reply, storeHash, entityType) {
  const activity = await getEntityFullBulkBlockActivity(storeHash, entityType);
  if (!activity.optimization && !activity.restore) {
    return false;
  }

  await reply
    .status(409)
    .send(await buildBulkBlockedResponse(storeHash, entityType, activity));
  return true;
}

module.exports = {
  BULK_ENTITY_TYPES,
  BULK_OPTIMIZATION_JOB_TYPES,
  isBulkOptimizationJobType,
  isFullBulkOptimizationJobType,
  isFullBulkOptimizationActive,
  getActiveBulkOptimizationMap,
  isAnyBulkOptimizationActive,
  buildBulkBlockedMessage,
  buildBulkBlockedByRestoreMessage,
  buildBulkQueuedMessage,
  buildBulkAlreadyQueuedMessage,
  buildPartialBulkMessage,
  buildBulkBlockedResponse,
  replyIfBulkOptimizationBlocked,
};
