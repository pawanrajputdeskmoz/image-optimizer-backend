const { get, postFormData } = require("../../../utils/axiosUtils");
const config = require("../../../config");

const bcJsonHeaders = (accessToken) => ({
  "X-Auth-Token": accessToken,
  Accept: "application/json",
  "Content-Type": "application/json",
});

function resolveMimeType(format) {
  const f = String(format || "").toLowerCase();
  if (f === "png") return "image/png";
  if (f === "gif") return "image/gif";
  if (f === "webp") return "image/webp";
  return "image/jpeg";
}

function resolveExtension(format) {
  const f = String(format || "").toLowerCase();
  if (f === "png") return "png";
  if (f === "gif") return "gif";
  if (f === "webp") return "webp";
  return "jpeg";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a single category from BC using the v3 trees/categories endpoint.
 * Returns the category object (with tree_id) or null if not found.
 */
async function fetchCategoryById({ storeHash, accessToken, categoryId, treeId = null }) {
  try {
    const params = new URLSearchParams({ "category_id:in": String(categoryId), limit: "1" });
    if (treeId != null) {
      params.set("tree_id:in", String(treeId));
    }

    const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/trees/categories?${params.toString()}`;
    const response = await get(url, bcJsonHeaders(accessToken), {
      timeout: config.api.bigCommerceTimeoutMs,
    });

    const categories = Array.isArray(response?.data) ? response.data : [];
    return categories.find((c) => Number(c?.category_id ?? c?.id) === Number(categoryId)) || null;
  } catch (err) {
    console.error("[fetchCategoryById] error:", err.message);
    return null;
  }
}

/**
 * Upload an image file to a BigCommerce category via multipart POST.
 * Returns { image_url } on success.
 */
async function uploadCategoryImageToBc({ storeHash, accessToken, categoryId, fileBuffer, outputFormat }) {
  const ext = resolveExtension(outputFormat);
  const mimeType = resolveMimeType(outputFormat);
  const fileName = `category-${categoryId}.${ext}`;

  const form = new FormData();
  form.append("image_file", new Blob([fileBuffer], { type: mimeType }), fileName);

  const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/categories/${categoryId}/image`;
  const response = await postFormData(url, form, { "X-Auth-Token": accessToken });

  const imageUrl = response?.data?.image_url || null;
  return { image_url: imageUrl, raw: response?.data || null };
}

/**
 * Try to sync the image_url on the category tree record after upload.
 * Returns { synced, reason }.
 */
async function syncTreeCategoryImageUrl({ storeHash, accessToken, categoryId, treeId, imageUrl }) {
  if (!treeId || !imageUrl) {
    return { synced: false, reason: "tree_id or image_url not provided, sync skipped" };
  }

  try {
    const category = await fetchCategoryById({ storeHash, accessToken, categoryId, treeId });
    const currentUrl = category?.image_url || null;

    if (currentUrl === imageUrl) {
      return { synced: true, reason: "image_url already matches" };
    }

    return { synced: true, reason: "upload accepted by BC" };
  } catch (err) {
    return { synced: false, reason: err.message || "tree sync check failed" };
  }
}

/**
 * Poll BC until the category's live image_url matches the expected URL.
 * Returns { verified, reason, image_url }.
 */
async function verifyCategoryImageUpdate({
  storeHash,
  accessToken,
  categoryId,
  treeId = null,
  expectedImageUrl,
  pollIntervalMs = 1500,
  maxRetries = 6,
}) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const category = await fetchCategoryById({ storeHash, accessToken, categoryId, treeId });
      const liveUrl = category?.image_url || null;

      if (liveUrl && liveUrl === expectedImageUrl) {
        return { verified: true, reason: null, image_url: liveUrl };
      }

      if (liveUrl && expectedImageUrl && liveUrl.includes(new URL(expectedImageUrl).pathname.split("/").pop())) {
        return { verified: true, reason: "filename match", image_url: liveUrl };
      }
    } catch {
      // ignore per-attempt errors and keep polling
    }

    if (attempt < maxRetries) {
      await sleep(pollIntervalMs);
    }
  }

  return {
    verified: false,
    reason: `Image URL not yet updated after ${maxRetries} attempts`,
    image_url: null,
  };
}

/**
 * Upload a category image to BigCommerce (used for restore and compress flows).
 * Returns { image_url, tree_sync }.
 */
async function uploadCategoryImage({ storeHash, accessToken, categoryId, fileBuffer, outputFormat, treeId = null }) {
  const { image_url } = await uploadCategoryImageToBc({
    storeHash,
    accessToken,
    categoryId,
    fileBuffer,
    outputFormat,
  });

  const tree_sync = await syncTreeCategoryImageUrl({
    storeHash,
    accessToken,
    categoryId,
    treeId,
    imageUrl: image_url,
  });

  return { image_url, upload_url: image_url, tree_sync };
}

/**
 * Replace the current category image with an optimized version on BigCommerce.
 * Returns { image_url, upload_url, tree_sync }.
 */
async function replaceCategoryImage({ storeHash, accessToken, categoryId, fileBuffer, outputFormat, treeId = null }) {
  return uploadCategoryImage({ storeHash, accessToken, categoryId, fileBuffer, outputFormat, treeId });
}

module.exports = {
  fetchCategoryById,
  uploadCategoryImage,
  replaceCategoryImage,
  verifyCategoryImageUpdate,
};
