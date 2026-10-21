const crypto = require("node:crypto");
const config = require("../config");
const { getRedis } = require("../db/redis");

const POLL_MS = 50;
const WINDOW_MS = 1000;
/** Fail open if Redis is slow/down so workers do not hang forever. */
const ACQUIRE_TIMEOUT_MS = 10_000;

const ACQUIRE_SLOT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, 0, window_start)
local count = redis.call("ZCARD", key)
if count < limit then
  redis.call("ZADD", key, now, member)
  redis.call("EXPIRE", key, 2)
  return 1
end
return 0
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMaxRequestsPerSecond() {
  return Math.max(
    1,
    config.api?.bcMaxRequestsPerSecond ??
      config.catalog?.bcMaxRequestsPerSecond ??
      2
  );
}

function redisKeyForStore(storeHash) {
  const hash = String(storeHash || "").trim().toLowerCase();
  if (hash) return `bc:api:request-times:${hash}`;
  return "bc:api:request-times:global";
}

/**
 * Extract store hash from a BigCommerce API URL.
 * e.g. https://api.bigcommerce.com/stores/abc123/v3/...
 */
function extractStoreHashFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/api\.bigcommerce\.com\/stores\/([^/?#]+)/i);
  return match?.[1] || null;
}

function isBigCommerceApiUrl(url) {
  return typeof url === "string" && /api\.bigcommerce\.com/i.test(url);
}

/**
 * Wait until a BigCommerce API slot is available for this store
 * (shared across all API processes / workers via Redis).
 */
async function acquireBigCommerceApiSlot(storeHash = null) {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return;
  }

  const maxRps = getMaxRequestsPerSecond();
  const key = redisKeyForStore(storeHash);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const now = Date.now();
      const member = `${now}:${crypto.randomUUID()}`;
      const acquired = await redis.eval(
        ACQUIRE_SLOT_LUA,
        1,
        key,
        String(now),
        String(now - WINDOW_MS),
        String(maxRps),
        member
      );

      if (Number(acquired) === 1) {
        return;
      }
    } catch (err) {
      console.error("[bc-api-rate-limit] acquire failed, continuing:", err?.message);
      return;
    }

    await sleep(POLL_MS);
  }
}

/** @deprecated Prefer acquireBigCommerceApiSlot(storeHash) */
async function acquireCatalogFetchSlot(storeHash = null) {
  return acquireBigCommerceApiSlot(storeHash);
}

/**
 * Rate-limited GET /v3/catalog/products (max N requests per second per store).
 * Throttle also happens inside axiosUtils for all BC URLs.
 */
async function fetchCatalogProducts(getFn, storeHash, params, headers = {}, axiosConfig = {}) {
  const query =
    params instanceof URLSearchParams
      ? params.toString()
      : new URLSearchParams(params).toString();

  const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${query}`;
  return getFn(url, headers, axiosConfig);
}

module.exports = {
  acquireBigCommerceApiSlot,
  acquireCatalogFetchSlot,
  fetchCatalogProducts,
  getMaxRequestsPerSecond,
  extractStoreHashFromUrl,
  isBigCommerceApiUrl,
};
