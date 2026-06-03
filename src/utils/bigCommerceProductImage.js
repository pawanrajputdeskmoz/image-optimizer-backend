const { get, put, post, postFormData, del } = require("./axiosUtils");

const bcJsonHeaders = (accessToken) => ({
  "X-Auth-Token": accessToken,
  Accept: "application/json",
  "Content-Type": "application/json",
});

function resolveMimeType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
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
  form.append("description", description || "");
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
}) {
  const form = buildProductImageUploadForm({
    fileBuffer,
    fileName,
    description,
    sortOrder,
    isThumbnail,
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
  await del(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
    bcJsonHeaders(accessToken)
  );
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
}) {
  try {
    const body = {};

    if (imageFile != null && String(imageFile).trim() !== "") {
      body.image_file = String(imageFile).trim();
    }

    if (description != null && String(description).trim() !== "") {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyImageReplacement({
  storeHash,
  productId,
  oldImageId,
  newImageId,
  accessToken,
  pollIntervalMs = 1000,
  maxRetries = 10,
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

async function purgeExternalCache({ productId, imageId, imageUrl }) {
  const rawUrls = String(process.env.IMAGE_REPLACEMENT_CACHE_PURGE_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  if (!rawUrls.length) {
    return { attempted: false, purged: 0, failed: 0 };
  }

  const payload = {
    event: "product_image_replaced",
    product_id: productId,
    image_id: imageId,
    image_url: imageUrl || null,
    occurred_at: new Date().toISOString(),
  };

  let purged = 0;
  let failed = 0;

  await Promise.all(
    rawUrls.map(async (url) => {
      try {
        await post(url, payload, {
          "Content-Type": "application/json",
        });
        purged += 1;
      } catch {
        failed += 1;
      }
    })
  );

  return { attempted: true, purged, failed };
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
  verifyPollIntervalMs = 1000,
  verifyMaxRetries = 10,
}) {
  const existingImages = await fetchProductImages({
    storeHash,
    productId,
    accessToken,
  });
  const oldImage = existingImages.find(
    (img) => Number(img?.id) === Number(oldImageId)
  );

  const uploadResult = await uploadProductImage({
    storeHash,
    productId,
    accessToken,
    fileBuffer,
    fileName,
    description,
    sortOrder,
    isThumbnail: false,
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

  if (shouldKeepThumbnail) {
    await updateProductImageMetadata({
      storeHash,
      productId,
      imageId: newImageId,
      accessToken,
      isThumbnail: true,
      sortOrder,
      description,
      imageFile: fileName,
    });
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
  buildProductImageUploadForm,
  fetchProductImages,
  uploadProductImage,
  deleteProductImage,
  updateProductImageMetadata,
  verifyImageReplacement,
  purgeExternalCache,
  replaceProductImage,
};
