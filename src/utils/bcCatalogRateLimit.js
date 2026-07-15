const crypto = require("node:crypto");
const config = require("../config");
const { getRedis } = require("../db/redis");

const REDIS_KEY = "bc:catalog-fetch:request-times";
const POLL_MS = 50;
const WINDOW_MS = 1000;

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
  return Math.max(1, config.catalog?.bcMaxRequestsPerSecond ?? 2);
}

/**
 * Wait until a catalog products API slot is available (global across workers).
 */
async function acquireCatalogFetchSlot() {
  const redis = getRedis();
  const maxRps = getMaxRequestsPerSecond();

  while (true) {
    const now = Date.now();
    const member = `${now}:${crypto.randomUUID()}`;
    const acquired = await redis.eval(
      ACQUIRE_SLOT_LUA,
      1,
      REDIS_KEY,
      String(now),
      String(now - WINDOW_MS),
      String(maxRps),
      member
    );

    if (Number(acquired) === 1) {
      return;
    }

    await sleep(POLL_MS);
  }
}

/**
 * Rate-limited GET /v3/catalog/products (max N requests per second).
 */
async function fetchCatalogProducts(getFn, storeHash, params, headers = {}, axiosConfig = {}) {
  await acquireCatalogFetchSlot();

  const query =
    params instanceof URLSearchParams
      ? params.toString()
      : new URLSearchParams(params).toString();

  const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${query}`;
  return getFn(url, headers, axiosConfig);
}

module.exports = {
  acquireCatalogFetchSlot,
  fetchCatalogProducts,
  getMaxRequestsPerSecond,
};
