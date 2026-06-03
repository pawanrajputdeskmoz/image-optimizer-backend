const ImageOptimizationLog = require("../models/ImageOptimizationLog");
const { normalizeJobType } = require("../models/constants");

/**
 * Standalone job_uuid when no bulk/single job row exists (e.g. sync API).
 */
function standaloneJobUuid(storeHash) {
  return `standalone:${String(storeHash || "unknown")}`;
}

function resolveJobUuid(logContext = {}, storeHash) {
  if (logContext.jobUuid) {
    return logContext.jobUuid;
  }
  return standaloneJobUuid(storeHash || logContext.storeHash);
}

/**
 * Persist one row to ImageOptimizationLog. Never throws; returns { error } on failure.
 */
async function appendImageLog({
  jobUuid,
  storeHash,
  jobType = "single",
  imageId = null,
  productId = null,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || !message) {
    return { error: "storeHash and message are required for image activity log" };
  }

  try {
    const validJobType = normalizeJobType(jobType) || "single";
    await ImageOptimizationLog.create({
      job_uuid: jobUuid || standaloneJobUuid(storeHash),
      store_hash: storeHash,
      job_type: validJobType,
      image_id: imageId,
      product_id: productId,
      log_type: logType,
      step,
      message: String(message),
      meta,
    });
    return { error: null };
  } catch (err) {
    console.error("[appendImageLog]", err.message);
    return { error: err.message };
  }
}

module.exports = {
  appendImageLog,
  standaloneJobUuid,
  resolveJobUuid,
};
