const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function resolveStorageRoot() {
  const cwdStorageRoot = path.resolve(process.cwd(), "storage");
  if (fs.existsSync(cwdStorageRoot)) {
    return cwdStorageRoot;
  }
  return path.resolve(__dirname, "../../storage");
}

function getPreviewSigningSecret() {
  return process.env.PREVIEW_URL_SECRET || process.env.JWT_SECRET || "";
}

function toPreviewStorageKey(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const normalized = filePath.trim().replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)storage\/(.+)$/i);
  return match?.[1] || null;
}

/** Strip path/query so OAuth REDIRECT_URI never breaks preview URLs. */
function normalizePublicBaseUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

function getPreviewBaseUrl(req) {
  const configured =
    process.env.PREVIEW_PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || "";
  if (configured) {
    return normalizePublicBaseUrl(configured);
  }

  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    req.protocol ||
    "http";
  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    req.headers.host ||
    "";
  if (host) {
    return `${proto}://${host}`;
  }

  return normalizePublicBaseUrl(process.env.REDIRECT_URI || "");
}

function buildPublicStorageUrl(req, filePath) {
  const key = toPreviewStorageKey(filePath);
  const base = getPreviewBaseUrl(req);
  if (!key || !base) return null;
  const encodedKey = key
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/storage/${encodedKey}`;
}

function buildSignedPreviewUrl(req, filePath) {
  const key = toPreviewStorageKey(filePath);
  const secret = getPreviewSigningSecret();
  const base = getPreviewBaseUrl(req);
  if (!key || !secret || !base) return null;

  const exp = Math.floor(Date.now() / 1000) + 5 * 60;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${key}:${exp}`)
    .digest("hex");
  return `${base}/api/image-optimizer/preview-file?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
}

/**
 * Prefer signed local-file preview URL, then public /storage URL, then CDN.
 */
function resolvePreviewUrl(req, filePath, cdnFallback) {
  return (
    buildSignedPreviewUrl(req, filePath) ||
    buildPublicStorageUrl(req, filePath) ||
    (typeof cdnFallback === "string" && cdnFallback.trim()
      ? cdnFallback.trim()
      : null)
  );
}

function previewMimeType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPathInsideRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

module.exports = {
  resolveStorageRoot,
  getPreviewSigningSecret,
  toPreviewStorageKey,
  getPreviewBaseUrl,
  buildPublicStorageUrl,
  buildSignedPreviewUrl,
  resolvePreviewUrl,
  previewMimeType,
  safeDecodeURIComponent,
  isPathInsideRoot,
};
