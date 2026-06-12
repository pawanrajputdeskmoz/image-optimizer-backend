const CategoryImageLog = require("../../../models/CategoryImageLog");
const { normalizeJobType } = require("../../../models/constants");

function standaloneCategoryJobUuid(storeHash, categoryId = null) {
  const base = `category:${String(storeHash || "unknown")}`;
  return categoryId != null ? `${base}:${Number(categoryId)}` : base;
}

function resolveCategoryJobUuid(logContext = {}, storeHash, categoryId = null) {
  if (logContext.jobUuid) {
    return logContext.jobUuid;
  }
  return standaloneCategoryJobUuid(storeHash || logContext.storeHash, categoryId);
}

async function appendCategoryImageLog({
  jobUuid,
  storeHash,
  channelId = 1,
  treeId = null,
  jobType = "single",
  categoryId,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || !message || categoryId == null) {
    return {
      error: "storeHash, categoryId and message are required for category image log",
    };
  }

  try {
    const validJobType = normalizeJobType(jobType) || "single";
    await CategoryImageLog.create({
      job_uuid: jobUuid || standaloneCategoryJobUuid(storeHash, categoryId),
      store_hash: storeHash,
      channel_id: Number(channelId) || 1,
      tree_id: treeId != null ? Number(treeId) : null,
      source_type: "category",
      job_type: validJobType,
      category_id: Number(categoryId),
      log_type: logType,
      step,
      message: String(message),
      meta,
    });
    return { error: null };
  } catch (err) {
    console.error("[appendCategoryImageLog]", err.message, {
      jobUuid,
      storeHash,
      categoryId,
      step,
      logType,
    });
    return { error: err.message };
  }
}

module.exports = {
  appendCategoryImageLog,
  standaloneCategoryJobUuid,
  resolveCategoryJobUuid,
};
