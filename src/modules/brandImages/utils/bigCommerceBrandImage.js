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
 * Fetch a single brand from BigCommerce.
 * Returns the brand object or null if not found.
 */
async function fetchBrandById({ storeHash, accessToken, brandId }) {
  try {
    const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands/${brandId}`;
    const response = await get(url, bcJsonHeaders(accessToken), {
      timeout: config.api.bigCommerceTimeoutMs,
    });
    return response?.data || null;
  } catch (err) {
    if (err?.response?.status === 404) return null;
    console.error("[fetchBrandById] error:", err.message);
    return null;
  }
}

/**
 * Upload an image file to a BigCommerce brand via multipart POST.
 * BC endpoint: POST /v3/catalog/brands/{brand_id}/image
 * Returns { image_url } on success.
 */
async function uploadBrandImageToBc({ storeHash, accessToken, brandId, fileBuffer, outputFormat }) {
  const ext = resolveExtension(outputFormat);
  const mimeType = resolveMimeType(outputFormat);
  const fileName = `brand-${brandId}.${ext}`;

  const form = new FormData();
  form.append("image_file", new Blob([fileBuffer], { type: mimeType }), fileName);

  const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands/${brandId}/image`;
  const response = await postFormData(url, form, { "X-Auth-Token": accessToken });

  const imageUrl = response?.data?.image_url || null;
  return { image_url: imageUrl, raw: response?.data || null };
}

/**
 * Poll BC until the brand's live image_url reflects the upload.
 * Returns { verified, reason, image_url }.
 */
async function verifyBrandImageUpdate({
  storeHash,
  accessToken,
  brandId,
  expectedImageUrl,
  pollIntervalMs = 1500,
  maxRetries = 6,
}) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const brand = await fetchBrandById({ storeHash, accessToken, brandId });
      const liveUrl = brand?.image_url || null;

      if (liveUrl && liveUrl === expectedImageUrl) {
        return { verified: true, reason: null, image_url: liveUrl };
      }

      if (liveUrl && expectedImageUrl) {
        const liveName = liveUrl.split("/").pop();
        const expectedName = expectedImageUrl.split("/").pop();
        if (liveName && liveName === expectedName) {
          return { verified: true, reason: "filename match", image_url: liveUrl };
        }
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
    reason: `Brand image URL not yet updated after ${maxRetries} attempts`,
    image_url: null,
  };
}

/**
 * Upload an optimized brand image to BigCommerce.
 * Returns { image_url, upload_url }.
 */
async function replaceBrandImage({ storeHash, accessToken, brandId, fileBuffer, outputFormat }) {
  const { image_url } = await uploadBrandImageToBc({
    storeHash,
    accessToken,
    brandId,
    fileBuffer,
    outputFormat,
  });

  return { image_url, upload_url: image_url };
}

module.exports = {
  fetchBrandById,
  replaceBrandImage,
  verifyBrandImageUpdate,
};
