const BrandImageJobLog = require("../../../models/BrandImageJobLog");
const { normalizeJobType } = require("../../../models/constants");

const BULK_BRAND_JOB_TYPES = new Set([
  "checkBox",
  "bulk",
  "restore_checkbox",
  "restore_bulk",
  "webhook",
  "reoptimize",
]);

function standaloneBrandJobUuid(storeHash, brandId = null) {
  const base = `brand:${String(storeHash || "unknown")}`;
  return brandId != null ? `${base}:${Number(brandId)}` : base;
}

function resolveBrandJobUuid(logContext = {}, storeHash, brandId = null) {
  if (logContext.jobUuid) {
    return logContext.jobUuid;
  }

  const jobType = normalizeJobType(logContext.jobType) || "single";
  if (BULK_BRAND_JOB_TYPES.has(jobType)) {
    return null;
  }

  return standaloneBrandJobUuid(storeHash || logContext.storeHash, brandId);
}

async function appendBrandImageJobLog({
  userId = null,
  jobId = null,
  jobUuid,
  storeHash,
  jobType = "single",
  brandId,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || !message || brandId == null) {
    return {
      error: "storeHash, brandId and message are required for brand image job log",
    };
  }

  try {
    const validJobType = normalizeJobType(jobType) || "single";
    const resolvedJobUuid =
      jobUuid ||
      resolveBrandJobUuid({ jobType: validJobType, storeHash }, storeHash, brandId);

    if (!resolvedJobUuid) {
      console.warn("[appendBrandImageJobLog] missing jobUuid for bulk job", {
        jobType: validJobType,
        storeHash,
        brandId,
        step,
      });
      return { error: null };
    }

    await BrandImageJobLog.create({
      user_id: userId,
      job_id: jobId,
      job_uuid: resolvedJobUuid,
      store_hash: storeHash,
      source_type: "brand",
      job_type: validJobType,
      brand_id: Number(brandId),
      log_type: logType,
      step,
      message: String(message),
      meta,
    });
    return { error: null };
  } catch (err) {
    console.error("[appendBrandImageJobLog]", err.message, {
      jobUuid,
      storeHash,
      brandId,
      step,
      logType,
    });
    return { error: err.message };
  }
}

module.exports = {
  appendBrandImageJobLog,
  standaloneBrandJobUuid,
  resolveBrandJobUuid,
};
