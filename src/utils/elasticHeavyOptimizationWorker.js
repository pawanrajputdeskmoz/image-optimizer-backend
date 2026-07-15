const appConfig = require("../config");
const { createRedisConnection } = require("../db/redis");

const WAKE_CHANNEL = "image-optimization-heavy:wake";
const SUPERVISOR_LOCK_KEY = "image-optimization-heavy:supervisor-lock";

let pubClient = null;

function getPubClient() {
  if (!pubClient) {
    pubClient = createRedisConnection("heavy-worker-wake-pub");
  }
  return pubClient;
}

function isElasticHeavyEnabled() {
  return appConfig.optimizationQueues?.elasticHeavy !== false;
}

async function signalHeavyWorkerNeeded() {
  if (!isElasticHeavyEnabled()) return;

  try {
    const redis = getPubClient();
    await redis.publish(WAKE_CHANNEL, String(Date.now()));
  } catch (err) {
    console.error("[elastic-heavy-worker] wake signal failed", err?.message);
  }
}

module.exports = {
  WAKE_CHANNEL,
  SUPERVISOR_LOCK_KEY,
  isElasticHeavyEnabled,
  signalHeavyWorkerNeeded,
};
