const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const LOGS_DIR = path.join(process.cwd(), "logs");
const requestContext = new AsyncLocalStorage();

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

/** Local date + time for log headers: YYYY-MM-DD HH:mm:ss */
function formatDateTime(date = new Date()) {
  const stamp = dateStamp(date);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${stamp} ${hh}:${mm}:${ss}`;
}

function writeLine(line, { category = null } = {}) {
  try {
    ensureLogsDir();
    const stamp = dateStamp();
    const text = line.endsWith("\n") ? line : `${line}\n`;
    fs.appendFileSync(path.join(LOGS_DIR, `${stamp}.log`), text, "utf8");
    if (category) {
      const safe = String(category).replace(/[^a-zA-Z0-9_-]/g, "_");
      fs.appendFileSync(
        path.join(LOGS_DIR, `${safe}-${stamp}.log`),
        text,
        "utf8"
      );
    }
  } catch (err) {
    console.error("[fileLogger] write failed:", err?.message);
  }
}

/**
 * Append a simple line (legacy helper).
 * Format: [YYYY-MM-DD HH:mm:ss] message {meta}
 */
function appendDailyLog(message, { category = null, meta = null } = {}) {
  const time = formatDateTime();
  const metaText =
    meta && typeof meta === "object"
      ? ` ${safeJson(meta)}`
      : meta != null
        ? ` ${String(meta)}`
        : "";
  writeLine(`[${time}] ${message}${metaText}`, { category });
}

const SENSITIVE_KEYS = new Set([
  "authorization",
  "x-auth-token",
  "api-token",
  "access_token",
  "password",
  "smtp_pass",
  "pass",
  "secret",
  "client_secret",
]);

function redactValue(key, value) {
  if (value == null) return value;
  const k = String(key || "").toLowerCase();
  if (SENSITIVE_KEYS.has(k) || k.includes("token") || k.includes("password") || k.includes("secret")) {
    return "[REDACTED]";
  }
  return value;
}

function sanitize(data, depth = 0) {
  if (data == null || depth > 4) return data;
  if (Buffer.isBuffer(data)) return `[Buffer ${data.length} bytes]`;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) {
    return data.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = redactValue(key, sanitize(value, depth + 1));
  }
  return out;
}

function safeJson(value, maxLen = 4000) {
  try {
    const text = JSON.stringify(sanitize(value));
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…[truncated]`;
  } catch {
    return String(value);
  }
}

function getRequestContext() {
  return requestContext.getStore() || null;
}

function runWithRequestContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

function newRequestId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Structured multi-line log block.
 * @param {string} title
 * @param {Record<string, unknown>} [fields]
 * @param {{ category?: string }} [opts]
 */
function logBlock(title, fields = {}, opts = {}) {
  const ctx = getRequestContext();
  const time = formatDateTime();
  const reqId = ctx?.requestId ? ` req=${ctx.requestId}` : "";
  const lines = [`[${time}]${reqId} ${title}`];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") {
      lines.push(`  ${key}: ${safeJson(value)}`);
    } else {
      lines.push(`  ${key}: ${value}`);
    }
  }

  writeLine(lines.join("\n"), opts);
  // Also mirror briefly to console for PM2
  console.log(lines[0]);
}

function logRequestStart(details = {}) {
  logBlock("[REQUEST]", details, { category: "api" });
}

function logRequestEnd(details = {}) {
  logBlock("[RESPONSE]", details, { category: "api" });
}

function logCallApi(details = {}) {
  logBlock("[CALL API]", details, { category: "api" });
}

function logCallFunction(name, details = {}) {
  logBlock(`[CALL FUNCTION] ${name}`, details, { category: "api" });
}

module.exports = {
  LOGS_DIR,
  appendDailyLog,
  dateStamp,
  formatDateTime,
  sanitize,
  safeJson,
  getRequestContext,
  runWithRequestContext,
  newRequestId,
  logBlock,
  logRequestStart,
  logRequestEnd,
  logCallApi,
  logCallFunction,
};
