const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { createRedisConnection } = require("../db/redis");
const { getOptimizationQueue, TIER_HEAVY } = require("../queue/imageOptimizationQueues");
const {
  WAKE_CHANNEL,
  SUPERVISOR_LOCK_KEY,
  isElasticHeavyEnabled,
} = require("../utils/elasticHeavyOptimizationWorker");
const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

const POLL_MS = appConfig.optimizationQueues?.elasticHeavyPollMs ?? 15_000;
const IDLE_SHUTDOWN_MS =
  appConfig.optimizationQueues?.elasticHeavyIdleShutdownMs ?? 5 * 60 * 1000;
const LOCK_TTL_SEC =
  appConfig.optimizationQueues?.elasticHeavySupervisorLockTtlSec ?? 30;

const supervisorId = `${process.pid}@${os.hostname()}`;

let heavyChild = null;
let idleSince = null;
let pollTimer = null;
let shuttingDown = false;

const lockRedis = createRedisConnection("heavy-supervisor-lock");
const subRedis = createRedisConnection("heavy-supervisor-sub");

function log(message, meta = {}) {
  console.log("[optimization-heavy-supervisor]", message, meta);
}

async function acquireOrRenewLock() {
  const existing = await lockRedis.get(SUPERVISOR_LOCK_KEY);
  if (existing === supervisorId) {
    await lockRedis.expire(SUPERVISOR_LOCK_KEY, LOCK_TTL_SEC);
    return true;
  }

  const acquired = await lockRedis.set(
    SUPERVISOR_LOCK_KEY,
    supervisorId,
    "NX",
    "EX",
    LOCK_TTL_SEC
  );
  return acquired === "OK";
}

async function releaseLock() {
  const existing = await lockRedis.get(SUPERVISOR_LOCK_KEY);
  if (existing === supervisorId) {
    await lockRedis.del(SUPERVISOR_LOCK_KEY);
  }
}

async function getPendingHeavyCount() {
  const queue = getOptimizationQueue(TIER_HEAVY);
  const counts = await queue.getJobCounts("waiting", "active", "delayed");
  return (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
}

function spawnHeavyWorker() {
  if (heavyChild) return;

  const workerPath = path.join(__dirname, "imageOptimizationWorker.js");

  heavyChild = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      IMAGE_OPTIMIZATION_QUEUE_TIER: TIER_HEAVY,
    },
    stdio: "inherit",
  });

  heavyChild.on("exit", (code, signal) => {
    log("heavy worker exited", { code, signal, pid: heavyChild?.pid });
    heavyChild = null;
    idleSince = null;
  });

  heavyChild.on("error", (err) => {
    console.error("[optimization-heavy-supervisor] heavy worker spawn error", err);
    heavyChild = null;
    idleSince = null;
  });

  log("spawned heavy worker", { pid: heavyChild.pid });
}

function stopHeavyWorker(signal = "SIGTERM") {
  if (!heavyChild) return;

  log("stopping heavy worker", { pid: heavyChild.pid, signal });
  heavyChild.kill(signal);
}

async function reconcile() {
  if (shuttingDown) return;

  const hasLock = await acquireOrRenewLock();
  if (!hasLock) {
    log("another supervisor holds the lock — skipping reconcile");
    return;
  }

  const pending = await getPendingHeavyCount();

  if (pending > 0) {
    idleSince = null;
    spawnHeavyWorker();
    return;
  }

  if (!heavyChild) {
    idleSince = null;
    return;
  }

  if (!idleSince) {
    idleSince = Date.now();
    log("heavy queue empty — idle timer started", { idleShutdownMs: IDLE_SHUTDOWN_MS });
    return;
  }

  if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) {
    log("idle shutdown threshold reached");
    stopHeavyWorker("SIGTERM");
    idleSince = null;
  }
}

async function start() {
  if (!isElasticHeavyEnabled()) {
    log("elastic heavy disabled — use npm run worker:image-optimization-heavy");
    process.exit(0);
  }

  const hasLock = await acquireOrRenewLock();
  if (!hasLock) {
    const holder = await lockRedis.get(SUPERVISOR_LOCK_KEY);
    log("another supervisor is already running — exiting", {
      lockKey: SUPERVISOR_LOCK_KEY,
      holder: holder || "unknown",
      hint: "Close other optimization-heavy-supervisor windows, or run: npm run workers:clear-locks",
    });
    process.exit(0);
  }

  await subRedis.subscribe(WAKE_CHANNEL);
  subRedis.on("message", (channel) => {
    if (channel === WAKE_CHANNEL) {
      reconcile().catch((err) => {
        console.error("[optimization-heavy-supervisor] reconcile error", err);
      });
    }
  });

  pollTimer = setInterval(() => {
    reconcile().catch((err) => {
      console.error("[optimization-heavy-supervisor] poll reconcile error", err);
    });
  }, POLL_MS);

  await reconcile();
  log("started", { pollMs: POLL_MS, idleShutdownMs: IDLE_SHUTDOWN_MS });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`shutting down (${signal})`);

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  stopHeavyWorker("SIGTERM");

  try {
    await subRedis.unsubscribe(WAKE_CHANNEL);
    await subRedis.quit();
    await releaseLock();
    await lockRedis.quit();
  } catch (err) {
    console.error("[optimization-heavy-supervisor] shutdown error", err);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("[optimization-heavy-supervisor] start failed", err);
  process.exit(1);
});
