/**
 * Application tuning defaults. Override via environment variables where noted.
 */

const fs = require("node:fs");
const path = require("node:path");
const { config: loadEnv } = require("dotenv");

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, "..", "..", ".env"),
].find((p) => fs.existsSync(p));

if (envPath) {
  loadEnv({ path: envPath });
} else {
  loadEnv();
}

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envString(key, fallback) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

const image = {
  fetchTimeoutMs: envInt("IMAGE_FETCH_TIMEOUT_MS", 12_000),
  maxBytes: envInt("IMAGE_MAX_BYTES", 25 * 1024 * 1024),
  sizeFetchConcurrency: envInt("IMAGE_SIZE_FETCH_CONCURRENCY", 8),
  outputFormat: envString("IMAGE_OUTPUT_FORMAT", "jpeg"),
  encodeQuality: envInt("IMAGE_ENCODE_QUALITY", 88),
  optimizeMaxDimension: envInt("OPTIMIZE_MAX_DIMENSION", 2560),
  sizeFetchRetries: envInt("BC_IMAGE_SIZE_FETCH_RETRIES", 4),
  sizeFetchRetryDelayMs: envInt("BC_IMAGE_SIZE_FETCH_DELAY_MS", 750),
};

module.exports = {
  server: {
    port: envInt("PORT", 3000),
    host: envString("HOST", "0.0.0.0"),
  },

  image,

  http: {
    axiosTimeoutMs: envInt("HTTP_AXIOS_TIMEOUT_MS", 20_000),
    axiosRetries: envInt("HTTP_AXIOS_RETRIES", 2),
    axiosRetryBaseDelayMs: envInt("HTTP_AXIOS_RETRY_BASE_DELAY_MS", 250),
  },

  api: {
    bigCommerceTimeoutMs: envInt("BIGCOMMERCE_API_TIMEOUT_MS", 10_000),
  },

  workers: {
    optimizationConcurrency: envInt(
      "IMAGE_OPTIMIZATION_WORKER_CONCURRENCY",
      2
    ),
    restoreConcurrency: envInt("IMAGE_RESTORE_WORKER_CONCURRENCY", 2),
  },

  pagination: {
    defaultPage: 1,
    defaultLimit: 5,
    maxLimit: 20,
  },

  catalog: {
    pageSize: envInt("CATALOG_PAGE_SIZE", 50),
  },

  restore: {
    backupDays: envInt("RESTORE_BACKUP_DAYS", 30),
  },

  storeDefaults: {
    optimize_image_enabled: true,
    is_filename_template_enabled: false,
    filename_template: "[name]",
    is_alt_text_template_enabled: false,
    alt_text_template: "[name]",
    image_quality: 80,
    output_format: image.outputFormat,
  },
};
