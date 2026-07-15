const {
  BULK_RESTORE_JOB_TYPES,
  ENTITY_LABELS,
  isBulkRestoreActive,
  getEntityBulkActivity,
  getActiveBulkOptimizationMap,
  getActiveBulkRestoreMap,
} = require("./bulkEntityActivity");

function isBulkRestoreJobType(jobType) {
  return BULK_RESTORE_JOB_TYPES.includes(jobType);
}

function buildBulkRestoreBlockedMessage(entityType) {
  const label = ENTITY_LABELS[entityType] || "Image";
  return `${label} bulk restore is already in progress. Please wait until the current job completes.`;
}

function buildBulkRestoreBlockedByOptimizationMessage(entityType) {
  const label = ENTITY_LABELS[entityType] || "Image";
  return `${label} bulk optimization is already in progress. Please wait until it completes before starting restore.`;
}

function buildBulkRestoreQueuedMessage(entityType) {
  const label = ENTITY_LABELS[entityType] || "Image";
  return `${label} bulk restore has been added to the queue.`;
}

async function buildBulkRestoreBlockedResponse(storeHash, entityType, activity) {
  const { optimization, restore } =
    activity || (await getEntityBulkActivity(storeHash, entityType));

  const [active_bulk_jobs, active_bulk_restores] = await Promise.all([
    getActiveBulkOptimizationMap(storeHash),
    getActiveBulkRestoreMap(storeHash),
  ]);

  const blockedBy = restore ? "restore" : "optimization";
  const message = restore
    ? buildBulkRestoreBlockedMessage(entityType)
    : buildBulkRestoreBlockedByOptimizationMessage(entityType);

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

async function replyIfBulkRestoreBlocked(reply, storeHash, entityType) {
  const activity = await getEntityBulkActivity(storeHash, entityType);
  if (!activity.optimization && !activity.restore) {
    return false;
  }

  await reply
    .status(409)
    .send(await buildBulkRestoreBlockedResponse(storeHash, entityType, activity));
  return true;
}

module.exports = {
  BULK_RESTORE_JOB_TYPES,
  isBulkRestoreJobType,
  isBulkRestoreActive,
  getActiveBulkRestoreMap,
  buildBulkRestoreBlockedMessage,
  buildBulkRestoreBlockedByOptimizationMessage,
  buildBulkRestoreQueuedMessage,
  buildBulkRestoreBlockedResponse,
  replyIfBulkRestoreBlocked,
};
