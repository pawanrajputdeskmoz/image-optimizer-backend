/**
 * Deletes storage/{year}/{month}/{day}/ for the day that is RESTORE_BACKUP_DAYS ago.
 * Run via OS scheduler (cron / Task Scheduler): npm run cleanup:storage
 */
const path = require("node:path");
const fs = require("node:fs/promises");
const { config: loadEnv } = require("dotenv");

const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => require("node:fs").existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

function parseRetentionDays() {
  const raw = process.env.RESTORE_BACKUP_DAYS;
  if (raw == null || raw === "") return 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function resolveTargetDayDir(retentionDays) {
  const target = new Date();
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() - retentionDays);

  const year = String(target.getFullYear());
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");

  const storageRoot = path.resolve(process.cwd(), "storage");
  const dayDir = path.resolve(storageRoot, year, month, day);

  if (dayDir !== storageRoot && !dayDir.startsWith(`${storageRoot}${path.sep}`)) {
    throw new Error(`Unsafe path: ${dayDir}`);
  }

  const relative = path.relative(storageRoot, dayDir);
  if (!/^\d{4}[\\/]\d{2}[\\/]\d{2}$/.test(relative)) {
    throw new Error(`Unexpected path depth: ${relative}`);
  }

  return { dayDir, dateLabel: `${year}-${month}-${day}` };
}

async function main() {
  const retentionDays = parseRetentionDays();
  const dryRun = String(process.env.DRY_RUN || "").trim().toLowerCase() === "true";
  const { dayDir, dateLabel } = resolveTargetDayDir(retentionDays);

  try {
    await fs.access(dayDir);
  } catch {
    console.log(`[cleanup:storage] skip ${dateLabel} — folder not found`);
    return;
  }

  if (dryRun) {
    console.log(`[cleanup:storage] dry-run would delete ${dayDir}`);
    return;
  }

  await fs.rm(dayDir, { recursive: true, force: true });
  console.log(`[cleanup:storage] deleted ${dateLabel} (${dayDir})`);
}

main().catch((err) => {
  console.error("[cleanup:storage] failed", err);
  process.exit(1);
});
