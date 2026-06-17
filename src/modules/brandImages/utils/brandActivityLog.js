const BrandImageJobLog = require("../../../models/BrandImageJobLog");
const { normalizeJobType } = require("../../../models/constants");

function standaloneBrandJobUuid(storeHash, brandId = null) {
  const base = `brand:${String(storeHash || "unknown")}`;
  return brandId != null ? `${base}:${Number(brandId)}` : base;
}

function resolveBrandJobUuid(logContext = {}, storeHash, brandId = null) {
  if (logContext.jobUuid) {
    return logContext.jobUuid;
  }
  return standaloneBrandJobUuid(storeHash || logContext.storeHash, brandId);
}

async function appendBrandImageJobLog({
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
    await BrandImageJobLog.create({
      job_uuid: jobUuid || standaloneBrandJobUuid(storeHash, brandId),
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
