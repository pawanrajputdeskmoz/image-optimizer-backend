const { get, put, postFormData, del } = require("../../../utils/axiosUtils");

const bcJsonHeaders = (accessToken) => ({
  "X-Auth-Token": accessToken,
  Accept: "application/json",
  "Content-Type": "application/json",
});

const LEGACY_AUTO_ALT_TEXT = new Set([
  "optimized image",
  "restored original image",
]);

function resolveMimeType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

/** Drop empty values and legacy app placeholder alt text. */
function normalizeUploadDescription(description) {
  if (description == null) return undefined;
  const trimmed = String(description).trim();
  if (!trimmed) return undefined;
  if (LEGACY_AUTO_ALT_TEXT.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function isLegacyAutoAltText(description) {
  if (description == null) return false;
  const trimmed = String(description).trim();
  if (!trimmed) return false;
  return LEGACY_AUTO_ALT_TEXT.has(trimmed.toLowerCase());
}

async function fetchProductImageById({
  storeHash,
  productId,
  imageId,
  accessToken,
}) {
  try {
    const response = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
      bcJsonHeaders(accessToken)
    );
    return response?.data || null;
  } catch (err) {
    if (err?.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Alt text to send on BC upload when templates may be disabled.
 * Only applies generated alt text when alt template feature is enabled.
 */
function resolveOptimizationUploadDescription({
  runAltText = false,
  newAltText = null,
  oldAltText = null,
} = {}) {
  if (runAltText) {
    const generated = normalizeUploadDescription(newAltText);
    if (generated) return generated;
  }
  return normalizeUploadDescription(oldAltText);
}

/**
 * Build multipart form for BC product image create (upload).
 */
function buildProductImageUploadForm({
  fileBuffer,
  fileName,
  description,
  sortOrder = 1,
  isThumbnail = false,
  forceEmptyDescription = false,
}) {
  const mimeType = resolveMimeType(fileName);
  const form = new FormData();
  form.append(
    "image_file",
    new Blob([fileBuffer], { type: mimeType }),
    fileName
  );
  form.append("is_thumbnail", String(Boolean(isThumbnail)));
  form.append("sort_order", String(sortOrder != null ? sortOrder : 1));
  const normalizedDescription = normalizeUploadDescription(description);
  if (normalizedDescription) {
    form.append("description", normalizedDescription);
  } else if (forceEmptyDescription) {
    form.append("description", "");
  }
  return form;
}

async function fetchProductImages({ storeHash, productId, accessToken }) {
  const response = await get(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images`,
    bcJsonHeaders(accessToken)
  );
  return Array.isArray(response?.data) ? response.data : [];
}

async function uploadProductImage({
  storeHash,
  productId,
  accessToken,
  fileBuffer,
  fileName,
  description,
  sortOrder,
  isThumbnail,
  forceEmptyDescription = false,
}) {
  const form = buildProductImageUploadForm({
    fileBuffer,
    fileName,
    description,
    sortOrder,
    isThumbnail,
    forceEmptyDescription,
  });

  const response = await postFormData(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images`,
    form,
    { "X-Auth-Token": accessToken }
  );

  return response?.data || null;
}

async function deleteProductImage({
  storeHash,
  productId,
  imageId,
  accessToken,
}) {
  try {
    await del(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
      bcJsonHeaders(accessToken)
    );
    return { deleted: true, notFound: false };
  } catch (err) {
    if (err?.response?.status === 404) {
      return { deleted: false, notFound: true };
    }
    throw err;
  }
}

async function updateProductImageMetadata({
  storeHash,
  productId,
  imageId,
  accessToken,
  imageFile,
  description,
  sortOrder,
  isThumbnail,
  clearDescription = false,
}) {
  try {
    const body = {};

    if (imageFile != null && String(imageFile).trim() !== "") {
      body.image_file = String(imageFile).trim();
    }

    if (clearDescription) {
      body.description = "";
    } else if (description != null && String(description).trim() !== "") {
      body.description = String(description).trim();
    }

    if (sortOrder != null && sortOrder !== "" && !Number.isNaN(Number(sortOrder))) {
      body.sort_order = Number(sortOrder);
    }

    if (isThumbnail != null && isThumbnail !== "") {
      body.is_thumbnail =
        typeof isThumbnail === "boolean"
          ? isThumbnail
          : ["true", "1", "yes"].includes(
              String(isThumbnail).trim().toLowerCase()
            );
    }

    if (Object.keys(body).length === 0) {
      return null;
    }

    const response = await put(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
      body,
      { headers: bcJsonHeaders(accessToken) }
    );

    return response?.data || response;
  } catch (error) {
    return {
      error: error.message,
      data: null,
    };
  }
}

/**
 * Ensure BC image description matches the intended value (including empty).
 */
async function syncProductImageDescription({
  storeHash,
  productId,
  imageId,
  accessToken,
  description,
  sortOrder,
  isThumbnail,
  maxAttempts = 2,
}) {
  const desired = normalizeUploadDescription(description);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const currentImage = await fetchProductImageById({
      storeHash,
      productId,
      imageId,
      accessToken,
    });
    const current = normalizeUploadDescription(currentImage?.description);

    if (desired) {
      if (current === desired) {
        return { ok: true, error: null };
      }
    } else if (!current) {
      return { ok: true, error: null };
    }

    const metadataResult = await updateProductImageMetadata({
      storeHash,
      productId,
      imageId,
      accessToken,
      ...(desired
        ? { description: desired }
        : { clearDescription: true }),
      sortOrder,
      isThumbnail,
    });

    if (metadataResult?.error && attempt === maxAttempts) {
      return { ok: false, error: metadataResult.error };
    }

    if (attempt < maxAttempts) {
      await sleep(200);
    }
  }

  return {
    ok: false,
    error: "Failed to sync BigCommerce image description",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyImageReplacement({
  storeHash,
  productId,
  oldImageId,
  newImageId,
  accessToken,
  pollIntervalMs = 400,
  maxRetries = 3,
}) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const images = await fetchProductImages({
      storeHash,
      productId,
      accessToken,
    });
    const hasNew = images.some((img) => Number(img?.id) === Number(newImageId));
    const hasOld = images.some((img) => Number(img?.id) === Number(oldImageId));

    if (hasNew && !hasOld) {
      return { verified: true, attempts: attempt };
    }

    if (attempt < maxRetries) {
      await sleep(pollIntervalMs);
    }
  }

  return { verified: false, attempts: maxRetries };
}

/**
 * Upload optimized image, preserve thumbnail, delete old image, verify on BC.
 */
async function replaceProductImage({
  storeHash,
  productId,
  oldImageId,
  accessToken,
  fileBuffer,
  fileName,
  description,
  sortOrder,
  isThumbnail,
  verifyPollIntervalMs = 400,
  verifyMaxRetries = 3,
}) {
  const existingImages = await fetchProductImages({
    storeHash,
    productId,
    accessToken,
  });
  const oldImage = existingImages.find(
    (img) => Number(img?.id) === Number(oldImageId)
  );

  if (!oldImage) {
    return {
      skipped: true,
      skipReason:
        "Image not found on BigCommerce product (already replaced or deleted)",
      oldImage: null,
      newImage: null,
      newImageId: null,
      verification: null,
    };
  }

  const uploadResult = await uploadProductImage({
    storeHash,
    productId,
    accessToken,
    fileBuffer,
    fileName,
    description,
    sortOrder,
    isThumbnail: false,
    forceEmptyDescription: !normalizeUploadDescription(description),
  });

  const newImage = uploadResult?.data || uploadResult;
  const newImageId = Number(newImage?.id);

  if (!Number.isFinite(newImageId)) {
    throw new Error("Failed to upload optimized image to BigCommerce");
  }

  const shouldKeepThumbnail =
    isThumbnail != null
      ? Boolean(isThumbnail)
      : Boolean(oldImage?.is_thumbnail);

  const normalizedDescription = normalizeUploadDescription(description);
  const metadataUpdate = {};
  if (normalizedDescription) {
    metadataUpdate.description = normalizedDescription;
  } else {
    metadataUpdate.clearDescription = true;
  }
  if (sortOrder != null && sortOrder !== "") {
    metadataUpdate.sortOrder = sortOrder;
  }
  if (shouldKeepThumbnail) {
    metadataUpdate.isThumbnail = true;
  }

  if (Object.keys(metadataUpdate).length > 0) {
    await updateProductImageMetadata({
      storeHash,
      productId,
      imageId: newImageId,
      accessToken,
      ...metadataUpdate,
    });
  }

  const syncResult = await syncProductImageDescription({
    storeHash,
    productId,
    imageId: newImageId,
    accessToken,
    description: normalizedDescription,
    sortOrder,
    isThumbnail: shouldKeepThumbnail ? true : isThumbnail,
  });

  if (!syncResult.ok) {
    console.warn("[replaceProductImage] description sync failed:", syncResult.error);
  }

  await deleteProductImage({
    storeHash,
    productId,
    imageId: oldImageId,
    accessToken,
  });

  const verification = await verifyImageReplacement({
    storeHash,
    productId,
    oldImageId,
    newImageId,
    accessToken,
    pollIntervalMs: verifyPollIntervalMs,
    maxRetries: verifyMaxRetries,
  });

  return {
    oldImage,
    newImage,
    newImageId,
    verification,
  };
}

module.exports = {
  resolveMimeType,
  normalizeUploadDescription,
  isLegacyAutoAltText,
  resolveOptimizationUploadDescription,
  buildProductImageUploadForm,
  fetchProductImages,
  fetchProductImageById,
  uploadProductImage,
  deleteProductImage,
  updateProductImageMetadata,
  syncProductImageDescription,
  verifyImageReplacement,
  replaceProductImage,
};
