/**
 * Extract BigCommerce category image asset ID from CDN URL filename.
 * Example: category-40__25497.jpeg → "25497"
 */
function extractCategoryImageAssetId(url) {
  if (!url || typeof url !== "string") {
    return null;
  }

  let filename = "";
  try {
    filename = new URL(url).pathname.split("/").pop() || "";
  } catch {
    filename = url.split("/").pop()?.split("?")[0] || "";
  }

  const match = filename.match(/__([0-9]+)(?:\.[^.]+)?$/i);
  return match ? match[1] : null;
}

module.exports = {
  extractCategoryImageAssetId,
};
