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
 * Append a tabular log block with a blank line before it
 * so consecutive entries (and old vs new logs) stay easy to scan.
 */
function appendDailyLog(message, { category = null, meta = null } = {}) {
  const fields =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? meta
      : meta != null
        ? { meta }
        : {};
  const block = formatLogTable({
    time: formatDateTime(),
    title: message,
    category,
    fields,
  });
  writeLine(block, { category });
  return block;
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

const LOG_SEP = "-".repeat(88);
const VALUE_MAX_LEN = 4000;
/** Fixed key column so every log table lines up the same way. */
const KEY_COL_WIDTH = 20;

function visibleFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function computeKeyWidth(headerRows, fields) {
  let max = KEY_COL_WIDTH;
  for (const [key] of headerRows) {
    max = Math.max(max, String(key).length);
  }
  for (const key of Object.keys(fields)) {
    max = Math.max(max, String(key).length);
  }
  return max;
}

function formatCellValue(value, valueIndent) {
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  try {
    let json = JSON.stringify(sanitize(value), null, 2);
    if (json.length > VALUE_MAX_LEN) {
      json = `${json.slice(0, VALUE_MAX_LEN)}\n…[truncated]`;
    }
    const pad = " ".repeat(valueIndent);
    return json
      .split("\n")
      .map((line, i) => (i === 0 ? line : `${pad}${line}`))
      .join("\n");
  } catch {
    return String(value);
  }
}

function formatRow(key, value, keyWidth) {
  const label = String(key).padEnd(keyWidth, " ");
  return `${label} ${formatCellValue(value, keyWidth + 1)}`;
}

/**
 * Two-column table: header (TIME / SCOPE / EVENT) then field rows.
 * Leading blank line keeps old and new entries visually separated.
 */
function formatLogTable({
  time,
  title,
  category = null,
  requestId = null,
  fields = {},
} = {}) {
  const body = visibleFields(fields);
  const headerRows = [
    ["TIME", time],
    ["SCOPE", category || "-"],
    ["EVENT", title],
  ];
  if (requestId) headerRows.push(["REQUEST ID", requestId]);

  const keyWidth = computeKeyWidth(headerRows, body);
  const lines = [""];
  lines.push(LOG_SEP);
  for (const [key, value] of headerRows) {
    lines.push(formatRow(key, value, keyWidth));
  }
  if (Object.keys(body).length) {
    lines.push(LOG_SEP);
    for (const [key, value] of Object.entries(body)) {
      lines.push(formatRow(key, value, keyWidth));
    }
  }
  lines.push(LOG_SEP);
  return lines.join("\n");
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
  const block = formatLogTable({
    time,
    title,
    category: opts.category || null,
    requestId: ctx?.requestId || null,
    fields,
  });
  writeLine(block, opts);
  console.log(`[${time}] ${title}`);
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
  formatLogTable,
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
