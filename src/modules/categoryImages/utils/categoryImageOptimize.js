const sharp = require("sharp");
const config = require("../../../config");

function normalizeFormat(format) {
  const f = String(format || "").toLowerCase();
  if (f === "jpg" || f === "jpe") return "jpeg";
  if (["jpeg", "png", "gif", "webp", "avif", "ico"].includes(f)) return f;
  return "jpeg";
}

function getFormatFromUrl(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "jpeg";
  if (clean.endsWith(".png")) return "png";
  if (clean.endsWith(".gif")) return "gif";
  if (clean.endsWith(".webp")) return "webp";
  if (clean.endsWith(".ico")) return "ico";
  return "jpeg";
}

/**
 * Map store output_format to BC-compatible upload format.
 * WebP/AVIF fall back to JPEG (no alpha) or PNG (alpha).
 */
function resolveCategoryOptimizeFormat(settingsFormat, originalFormat, hasAlpha) {
  const configured = String(settingsFormat || "jpeg").trim().toLowerCase();
  const normalized = configured === "jpg" ? "jpeg" : configured;

  if (["webp", "avif"].includes(normalized)) {
    return hasAlpha ? "png" : "jpeg";
  }

  if (normalized === "png") {
    return hasAlpha ? "png" : "jpeg";
  }

  if (normalized === "gif") {
    return originalFormat === "gif" ? "gif" : "jpeg";
  }

  if (normalized === "ico") {
    return originalFormat === "ico" ? "ico" : hasAlpha ? "png" : "jpeg";
  }

  return resolveCategoryOutputFormat(originalFormat, hasAlpha, false);
}

/**
 * BC category image upload supports JPEG, GIF, PNG, ICO only.
 */
function resolveCategoryOutputFormat(inputFormat, hasAlpha, isAnimatedGif) {
  if (isAnimatedGif) return null;

  if (inputFormat === "gif") return "gif";

  if (hasAlpha) return "png";

  if (inputFormat === "png" && !hasAlpha) return "jpeg";

  if (["webp", "avif", "ico"].includes(inputFormat)) {
    return hasAlpha ? "png" : "jpeg";
  }

  return "jpeg";
}

module.exports = {
  resolveCategoryOptimizeFormat,
  resolveCategoryOutputFormat,
  normalizeFormat,
  getFormatFromUrl,
};
