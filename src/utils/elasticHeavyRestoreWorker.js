const appConfig = require("../config");
const { createRedisConnection } = require("../db/redis");

const WAKE_CHANNEL = "image-restore-heavy:wake";
const SUPERVISOR_LOCK_KEY = "image-restore-heavy:supervisor-lock";

let pubClient = null;

function getPubClient() {
  if (!pubClient) {
    pubClient = createRedisConnection("heavy-restore-wake-pub");
  }
  return pubClient;
}

function isElasticHeavyRestoreEnabled() {
  return appConfig.restoreQueues?.elasticHeavy !== false;
}

async function signalHeavyRestoreWorkerNeeded() {
  if (!isElasticHeavyRestoreEnabled()) return;

  try {
    const redis = getPubClient();
    await redis.publish(WAKE_CHANNEL, String(Date.now()));
  } catch (err) {
    console.error("[elastic-heavy-restore-worker] wake signal failed", err?.message);
  }
}

module.exports = {
  WAKE_CHANNEL,
  SUPERVISOR_LOCK_KEY,
  isElasticHeavyRestoreEnabled,
  signalHeavyRestoreWorkerNeeded,
};
