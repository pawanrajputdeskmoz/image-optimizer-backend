/**
 * Build storefront product image URL:
 * {storeUrl}/product_images/{image_file}
 *
 * @param {string} storeUrl - e.g. https://my-store.com
 * @param {string} imageFile - e.g. a/521/product.jpg (BigCommerce image_file)
 * @returns {string|null}
 */
exports.buildProductImageUrl = (storeUrl, imageFile) => {
  if (!storeUrl || !imageFile) {
    return null;
  }

  const base = String(storeUrl).trim().replace(/\/+$/, "");
  const file = String(imageFile).trim().replace(/^\/+/, "");

  if (!base || !file) {
    return null;
  }

  return `${base}/product_images/${file}`;
};

/**
 * Full URL passthrough; relative image_file → storeUrl/product_images/...
 */
exports.resolveProductImageUrl = (storeUrl, value, fallbackUrl = null) => {
  if (value == null || value === "") {
    return fallbackUrl;
  }

  const str = String(value).trim();
  if (/^https?:\/\//i.test(str)) {
    return str;
  }

  return exports.buildProductImageUrl(storeUrl, str) || fallbackUrl;
};
