const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(process.cwd(), "logs");

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function dateStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Append a line to logs/YYYY-MM-DD.log (and optional category file).
 * Never throws — logging must not break request flow.
 */
function appendDailyLog(message, { category = null, meta = null } = {}) {
  try {
    ensureLogsDir();
    const stamp = dateStamp();
    const time = new Date().toISOString();
    const metaText =
      meta && typeof meta === "object"
        ? ` ${JSON.stringify(meta)}`
        : meta != null
          ? ` ${String(meta)}`
          : "";
    const line = `[${time}] ${message}${metaText}\n`;

    fs.appendFileSync(path.join(LOGS_DIR, `${stamp}.log`), line, "utf8");

    if (category) {
      const safe = String(category).replace(/[^a-zA-Z0-9_-]/g, "_");
      fs.appendFileSync(
        path.join(LOGS_DIR, `${safe}-${stamp}.log`),
        line,
        "utf8"
      );
    }
  } catch (err) {
    console.error("[fileLogger] write failed:", err?.message);
  }
}

module.exports = {
  LOGS_DIR,
  appendDailyLog,
  dateStamp,
};
