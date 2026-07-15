/**
 * Dev helper: release Redis locks for elastic heavy supervisors.
 * Run only when no supervisor windows are open (close old worker terminals first).
 */
const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const { createRedisConnection } = require("../src/db/redis");

const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

const LOCK_KEYS = [
  "image-optimization-heavy:supervisor-lock",
  "image-restore-heavy:supervisor-lock",
];

async function main() {
  const redis = createRedisConnection("clear-heavy-supervisor-locks");

  for (const key of LOCK_KEYS) {
    const holder = await redis.get(key);
    if (holder) {
      await redis.del(key);
      console.log(`[clear-locks] removed ${key} (was held by ${holder})`);
    } else {
      console.log(`[clear-locks] ${key} — no lock`);
    }
  }

  await redis.quit();
  console.log("[clear-locks] done");
}

main().catch((err) => {
  console.error("[clear-locks] failed", err);
  process.exit(1);
});
