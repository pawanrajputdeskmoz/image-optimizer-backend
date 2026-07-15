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

function envBool(key, fallback) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

const image = {
  fetchTimeoutMs: envInt("IMAGE_FETCH_TIMEOUT_MS", 12_000),
  maxBytes: envInt("IMAGE_MAX_BYTES", 25 * 1024 * 1024),
  sizeFetchConcurrency: envInt("IMAGE_SIZE_FETCH_CONCURRENCY", 16),
  sizeFetchRangeBytes: envInt("IMAGE_SIZE_FETCH_RANGE_BYTES", 65_535),
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
    optimizationHeavyConcurrency: envInt(
      "IMAGE_OPTIMIZATION_HEAVY_WORKER_CONCURRENCY",
      2
    ),
    optimizationStandardConcurrency: envInt(
      "IMAGE_OPTIMIZATION_STANDARD_WORKER_CONCURRENCY",
      2
    ),
    restoreConcurrency: envInt("IMAGE_RESTORE_WORKER_CONCURRENCY", 2),
    restoreHeavyConcurrency: envInt("IMAGE_RESTORE_HEAVY_WORKER_CONCURRENCY", 2),
    restoreStandardConcurrency: envInt(
      "IMAGE_RESTORE_STANDARD_WORKER_CONCURRENCY",
      2
    ),
    categoryOptimizationConcurrency: envInt(
      "CATEGORY_IMAGE_OPTIMIZATION_WORKER_CONCURRENCY",
      2
    ),
    categoryRestoreConcurrency: envInt(
      "CATEGORY_IMAGE_RESTORE_WORKER_CONCURRENCY",
      2
    ),
    catalogFetchConcurrency: envInt("CATALOG_FETCH_WORKER_CONCURRENCY", 2),
    brandOptimizationConcurrency: envInt(
      "BRAND_IMAGE_OPTIMIZATION_WORKER_CONCURRENCY",
      2
    ),
    brandRestoreConcurrency: envInt(
      "BRAND_IMAGE_RESTORE_WORKER_CONCURRENCY",
      2
    ),
    /** BullMQ job attempts for all workers (default 3) */
    jobAttempts: envInt("WORKER_JOB_ATTEMPTS", 3),
    /** Exponential backoff base delay in ms between job retries */
    jobBackoffDelayMs: envInt("WORKER_JOB_BACKOFF_DELAY_MS", 5000),
  },

  pagination: {
    defaultPage: 1,
    defaultLimit: 5,
    /** Max products per page for get-all-products */
    maxLimit: 10,
    /** Max categories per page for get-all-categories */
    categoryMaxLimit: 50,
    /** Max brands per page for get-all-brands */
    brandMaxLimit: 50,
  },

  catalog: {
    pageSize: envInt("CATALOG_PAGE_SIZE", 50),
    /** Max BigCommerce catalog/products API calls per second during catalog fetch */
    bcMaxRequestsPerSecond: envInt("CATALOG_FETCH_BC_MAX_RPS", 2),
  },

  optimization: {
    /** Images per BullMQ batch job (MongoDB ImageJobItem is source of truth) */
    batchSize: envInt("IMAGE_OPTIMIZATION_BATCH_SIZE", 500),
  },

  optimizationQueues: {
    /** Jobs with at least this many images route to image-optimization-heavy */
    heavyThreshold: envInt("IMAGE_OPTIMIZATION_HEAVY_THRESHOLD", 10_000),
    /** When true, heavy worker is spawned on demand by optimizationHeavySupervisor */
    elasticHeavy: envBool("IMAGE_OPTIMIZATION_ELASTIC_HEAVY", true),
    elasticHeavyPollMs: envInt("IMAGE_OPTIMIZATION_ELASTIC_HEAVY_POLL_MS", 15_000),
    elasticHeavyIdleShutdownMs: envInt(
      "IMAGE_OPTIMIZATION_ELASTIC_HEAVY_IDLE_SHUTDOWN_MS",
      5 * 60 * 1000
    ),
    elasticHeavySupervisorLockTtlSec: envInt(
      "IMAGE_OPTIMIZATION_ELASTIC_HEAVY_SUPERVISOR_LOCK_TTL_SEC",
      30
    ),
  },

  restore: {
    backupDays: envInt("RESTORE_BACKUP_DAYS", 30),
    /** MongoDB cursor / validation batch size for restore scans */
    dbChunkSize: envInt("RESTORE_DB_CHUNK_SIZE", 500),
    /** BullMQ add batch size when queueing restore worker jobs */
    queueBatchSize: envInt("RESTORE_QUEUE_BATCH_SIZE", 500),
    /** Parallel fs.access checks per restore chunk */
    fileCheckConcurrency: envInt("RESTORE_FILE_CHECK_CONCURRENCY", 50),
  },

  restoreQueues: {
    /** Restore jobs with at least this many images route to image-restore-heavy */
    heavyThreshold: envInt("IMAGE_RESTORE_HEAVY_THRESHOLD", 10_000),
    /** When true, heavy restore worker is spawned on demand by restoreHeavySupervisor */
    elasticHeavy: envBool("IMAGE_RESTORE_ELASTIC_HEAVY", true),
    elasticHeavyPollMs: envInt("IMAGE_RESTORE_ELASTIC_HEAVY_POLL_MS", 15_000),
    elasticHeavyIdleShutdownMs: envInt(
      "IMAGE_RESTORE_ELASTIC_HEAVY_IDLE_SHUTDOWN_MS",
      5 * 60 * 1000
    ),
    elasticHeavySupervisorLockTtlSec: envInt(
      "IMAGE_RESTORE_ELASTIC_HEAVY_SUPERVISOR_LOCK_TTL_SEC",
      30
    ),
  },

  storeDefaults: {
    optimize_image_enabled: true,
    is_filename_template_enabled: false,
    filename_template: "[name]",
    is_alt_text_template_enabled: false,
    alt_text_template: "[name]",
    image_quality: 80,
    output_format: image.outputFormat,
    auto_optimize_new_images: false,
    auto_optimize_new_category_images: false,
  },

  rateLimit: {
    webhookRegister: {
      max: envInt("WEBHOOK_REGISTER_RATE_LIMIT_MAX", 5),
      windowMs: envInt("WEBHOOK_REGISTER_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    },
  },

  admin: {
    /** Legacy API key auth (optional fallback) */
    apiKey: envString("ADMIN_API_KEY", ""),
    /** Bootstrap first admin when collection is empty */
    email: envString("ADMIN_EMAIL", ""),
    password: envString("ADMIN_PASSWORD", ""),
    name: envString("ADMIN_NAME", "Admin"),
    tokenExpiresIn: envString("ADMIN_JWT_EXPIRES_IN", "24h"),
  },

  paypal: (() => {
    const isLive = ["live", "production"].includes(envString("PAYPAL_ENV", "sandbox").toLowerCase());
    const frontendUrl = envString("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "");
    return {
      clientId: envString("PAYPAL_CLIENT_ID", ""),
      clientSecret: envString("PAYPAL_CLIENT_SECRET", ""),
      baseUrl: isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
      returnUrl: `${frontendUrl}/payment/success`,
      cancelUrl: `${frontendUrl}/payment/cancel`,
    };
  })(),

  mail: {
    enabled: envBool("MAIL_ENABLED", false),
    host: envString("SMTP_HOST", ""),
    port: envInt("SMTP_PORT", 587),
    secure: envBool("SMTP_SECURE", false),
    user: envString("SMTP_USER", ""),
    pass: envString("SMTP_PASS", ""),
    fromName: envString("MAIL_FROM_NAME", "Image Optimizer"),
    fromEmail: envString("MAIL_FROM_EMAIL", "no-reply@imageoptimizer.com"),
    frontendUrl: envString("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, ""),
  },
};
