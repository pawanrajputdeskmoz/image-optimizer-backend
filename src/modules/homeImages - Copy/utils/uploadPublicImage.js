const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const sharp = require("sharp");
const config = require("../../../config");

function resolvePublicBaseUrl() {
  const base =
    process.env.PUBLIC_STORAGE_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REDIRECT_URI ||
    `http://localhost:${config.server.port}`;

  return String(base).replace(/\/$/, "");
}

function normalizeFormat(format) {
  const f = String(format || "").toLowerCase();
  if (f === "jpg") return "jpeg";
  if (["jpeg", "png", "webp", "gif"].includes(f)) return f;
  return "jpeg";
}

function getFormatFromUrl(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "jpeg";
  if (clean.endsWith(".png")) return "png";
  if (clean.endsWith(".webp")) return "webp";
  if (clean.endsWith(".gif")) return "gif";
  return "jpeg";
}

async function optimizeImageBuffer({
  buffer,
  quality = 82,
  maxWidth = config.image.optimizeMaxDimension,
  outputFormatInput = null,
  originalUrl = null,
}) {
  const metadata = await sharp(buffer, {
    failOn: "none",
    animated: false,
  }).metadata();

  const inputFormat = normalizeFormat(
    metadata.format || getFormatFromUrl(originalUrl)
  );
  const outputFormat = normalizeFormat(outputFormatInput || inputFormat);

  if (inputFormat === "gif") {
    return {
      success: false,
      error: "GIF skipped. Animated GIF optimization is not supported.",
      originalSize: buffer.length,
    };
  }

  let pipeline = sharp(buffer, {
    failOn: "none",
    animated: false,
  }).rotate();

  if (metadata.width && metadata.width > maxWidth) {
    pipeline = pipeline.resize({
      width: maxWidth,
      withoutEnlargement: true,
    });
  }

  pipeline = pipeline.withMetadata(false);

  let optimizedBuffer;

  if (outputFormat === "jpeg") {
    if (metadata.hasAlpha) {
      pipeline = pipeline.flatten({
        background: { r: 255, g: 255, b: 255 },
      });
    }

    optimizedBuffer = await pipeline
      .jpeg({
        quality,
        mozjpeg: true,
        progressive: true,
        chromaSubsampling: "4:2:0",
      })
      .toBuffer();
  } else if (outputFormat === "png") {
    optimizedBuffer = await pipeline
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: false,
      })
      .toBuffer();
  } else if (outputFormat === "webp") {
    optimizedBuffer = await pipeline
      .webp({
        quality,
        effort: 4,
      })
      .toBuffer();
  } else {
    optimizedBuffer = await pipeline
      .jpeg({
        quality,
        mozjpeg: true,
        progressive: true,
      })
      .toBuffer();
  }

  return {
    success: true,
    optimizedBuffer,
    originalSize: buffer.length,
    optimizedSize: optimizedBuffer.length,
    outputFormat,
    inputFormat,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
  };
}

async function uploadOptimizedBuffer({
  buffer,
  storeHash,
  outputFormat,
  subfolder = "home",
}) {
  const ext = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const safeStoreHash = String(storeHash).replace(/[^a-zA-Z0-9_-]/g, "");
  const fileName = `${Date.now()}-${crypto.randomUUID()}-optimized.${ext}`;

  const relativeFolder = path.join(
    "optimized",
    "bigcommerce",
    safeStoreHash,
    subfolder
  );

  const absoluteFolder = path.join(process.cwd(), "storage", relativeFolder);
  const absoluteFilePath = path.join(absoluteFolder, fileName);

  await fs.mkdir(absoluteFolder, { recursive: true });
  await fs.writeFile(absoluteFilePath, buffer);

  const storagePath = `/${relativeFolder.replace(/\\/g, "/")}/${fileName}`;
  const optimizedUrl = `${resolvePublicBaseUrl()}/storage${storagePath}`;

  return {
    optimizedUrl,
    storagePath,
    absoluteFilePath,
    fileName,
  };
}

async function downloadImageBuffer(imageUrl, timeoutMs = config.image.fetchTimeoutMs) {
  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: timeoutMs,
    maxRedirects: 5,
    maxContentLength: config.image.maxBytes,
    maxBodyLength: config.image.maxBytes,
    headers: {
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 BigCommerceImageOptimizer/1.0",
    },
  });

  return Buffer.from(response.data);
}

async function optimizeAndUploadImage({
  imageUrl,
  storeHash,
  quality = 82,
  maxWidth = config.image.optimizeMaxDimension,
  outputFormat = null,
  subfolder = "home",
}) {
  const originalBuffer = await downloadImageBuffer(imageUrl);
  const optimizeResult = await optimizeImageBuffer({
    buffer: originalBuffer,
    quality,
    maxWidth,
    outputFormatInput: outputFormat,
    originalUrl: imageUrl,
  });

  if (!optimizeResult.success) {
    return optimizeResult;
  }

  if (optimizeResult.optimizedSize >= optimizeResult.originalSize) {
    return {
      success: false,
      error:
        "Optimized image is not smaller than original. Widget was not updated.",
      originalSize: optimizeResult.originalSize,
      optimizedSize: optimizeResult.optimizedSize,
      savedBytes: optimizeResult.originalSize - optimizeResult.optimizedSize,
    };
  }

  const uploadResult = await uploadOptimizedBuffer({
    buffer: optimizeResult.optimizedBuffer,
    storeHash,
    outputFormat: optimizeResult.outputFormat,
    subfolder,
  });

  return {
    success: true,
    ...uploadResult,
    originalSize: optimizeResult.originalSize,
    optimizedSize: optimizeResult.optimizedSize,
    savedBytes: optimizeResult.originalSize - optimizeResult.optimizedSize,
    outputFormat: optimizeResult.outputFormat,
  };
}

module.exports = {
  resolvePublicBaseUrl,
  optimizeImageBuffer,
  uploadOptimizedBuffer,
  downloadImageBuffer,
  optimizeAndUploadImage,
};
