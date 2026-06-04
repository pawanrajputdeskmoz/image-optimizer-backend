const sharp = require("sharp");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config");

/** Pass through to sharp; "original" skips cross-format conversion. */
exports.resolveOptimizeFormat = (outputFormat) => {
  const value = String(outputFormat ?? config.image.outputFormat)
    .trim()
    .toLowerCase();

  if (value === "original") return "original";
  if (value === "jpg") return "jpeg";
  if (["jpeg", "png", "webp", "avif"].includes(value)) return value;
  return config.image.outputFormat;
};



const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Same as getImageSizeFromUrl but retries (BC CDN can lag right after upload).
 */
exports.getImageSizeFromUrlWithRetry = async (imageUrl, options = {}) => {
  const retries = options.retries ?? config.image.sizeFetchRetries;
  const retryDelayMs =
    options.retryDelayMs ?? config.image.sizeFetchRetryDelayMs;
  let lastResult = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    lastResult = await exports.getImageSizeFromUrl(imageUrl, options);
    if (lastResult.bytes != null) {
      return lastResult;
    }
    if (attempt < retries - 1) {
      await sleep(retryDelayMs);
    }
  }

  return lastResult;
};


exports.getImageSizesFromUrls = async (items, options = {}) => {
  const concurrency =
    options.concurrency ?? config.image.sizeFetchConcurrency;
  const sizeByImageId = Object.create(null);

  if (!Array.isArray(items) || items.length === 0) {
    return sizeByImageId;
  }

  let index = 0;

  const worker = async () => {
    while (index < items.length) {
      const current = index;
      index += 1;

      const { imageId, url } = items[current];
      if (imageId == null || !url) {
        sizeByImageId[imageId] = {
          bytes: null,
          width: null,
          height: null,
          format: null,
          error: "Missing image id or url",
        };
        continue;
      }

      const result = await exports.getImageSizeFromUrl(url, options);
      sizeByImageId[imageId] = {
        bytes: result.bytes ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        format: result.format ?? null,
        ...(result.error ? { error: result.error } : {}),
      };
    }
  };

  const poolSize = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return sizeByImageId;
};


exports.getImageSizeFromUrl = async (imageUrl, options = {}) => {
  const timeoutMs = options.timeoutMs ?? config.image.fetchTimeoutMs;
  const maxBytes = options.maxBytes ?? config.image.maxBytes;

  if (!imageUrl || typeof imageUrl !== "string") {
    return {
      error: "imageUrl is required",
      bytes: null,
      width: null,
      height: null,
      format: null,
    };
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const buffer = Buffer.from(response.data);
    const meta = await sharp(buffer, { failOn: "none" }).metadata();

    return {
      bytes: buffer.length,
      width: meta.width ?? null,
      height: meta.height ?? null,
      format: meta.format ?? null,
    };
  } catch (err) {
    return {
      error: err.message || "Failed to fetch image size",
      bytes: null,
      width: null,
      height: null,
      format: null,
    };
  }
};


exports.buildOptimizationMetadataFromUrls = async (
  originalUrl,
  optimizedUrl,
  localFallback = {}
) => {
  const localOriginal = localFallback.original || {};
  const localOptimized = localFallback.optimized || {};

  const [originalFromUrl, optimizedFromUrl] = await Promise.all([
    originalUrl
      ? exports.getImageSizeFromUrl(originalUrl)
      : Promise.resolve({ bytes: null, width: null, height: null, format: null }),
    optimizedUrl
      ? exports.getImageSizeFromUrl(optimizedUrl)
      : Promise.resolve({ bytes: null, width: null, height: null, format: null }),
  ]);

  const original = {
    width: originalFromUrl.width ?? localOriginal.width ?? null,
    height: originalFromUrl.height ?? localOriginal.height ?? null,
    format: originalFromUrl.format ?? localOriginal.format ?? null,
    size:
      originalFromUrl.bytes != null
        ? originalFromUrl.bytes
        : localOriginal.size ?? null,
  };

  const optimized = {
    width: optimizedFromUrl.width ?? localOptimized.width ?? null,
    height: optimizedFromUrl.height ?? localOptimized.height ?? null,
    format: optimizedFromUrl.format ?? localOptimized.format ?? null,
    size:
      optimizedFromUrl.bytes != null
        ? optimizedFromUrl.bytes
        : localOptimized.size ?? null,
  };

  const origSize = Number(original.size) || 0;
  const optSize = Number(optimized.size) || 0;
  const savedBytes =
    origSize > 0 && optSize >= 0 ? Math.max(0, origSize - optSize) : 0;
  const savedPercentage =
    origSize > 0 ? Number(((savedBytes / origSize) * 100).toFixed(2)) : 0;

  return {
    original,
    optimized,
    saved_bytes: savedBytes,
    saved_percentage: savedPercentage,
    sources: {
      original: originalFromUrl.bytes != null ? "cdn" : "local",
      optimized: optimizedFromUrl.bytes != null ? "cdn" : "local",
    },
  };
};

const ENCODE_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif"]);

function clampQuality(quality, fallback = config.image.encodeQuality) {
  const q = Number(quality);
  if (!Number.isFinite(q)) return fallback;
  return Math.min(100, Math.max(1, Math.round(q)));
}

function clampFrontendQuality(imageQuality, fallback = 80) {
  const q = Number(imageQuality);
  if (!Number.isFinite(q)) return fallback;
  return Math.min(100, Math.max(1, Math.round(q)));
}

/**
 * Frontend slider (e.g. 10 = low) → Sharp quality for real file-size reduction.
 */
function mapFrontendQualityToSharpQuality(imageQuality) {
  const q = clampFrontendQuality(imageQuality);
  if (q >= 75) return Math.min(100, Math.max(90, q >= 90 ? q : 95));
  if (q >= 45) return q >= 70 && q <= 75 ? q : 72;
  return q >= 50 && q <= 55 ? q : 52;
}

function resolveEncodeQuality(qualityOption) {
  return mapFrontendQualityToSharpQuality(
    clampQuality(qualityOption, config.image.encodeQuality)
  );
}

function normalizeInputFormat(format) {
  const f = String(format || "").toLowerCase();
  if (f === "jpg" || f === "jpe") return "jpeg";
  return f;
}



function needsResize(meta) {
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  return (
    w > config.image.optimizeMaxDimension ||
    h > config.image.optimizeMaxDimension
  );
}

function normalizeFormat(format) {
  const f = String(format || "").toLowerCase();
  if (f === "jpg" || f === "jpe") return "jpeg";
  if (ENCODE_FORMATS.has(f)) return f;
  return null;
}

/**
 * Map store settings → sharp output format.
 * Transparent sources stay PNG/WebP/AVIF unless merchant explicitly chose JPEG.
 */
function resolveOutputFormat(formatOption, inputFormat, hasAlpha = false) {
  const requested = String(
    formatOption || config.image.outputFormat
  ).toLowerCase();

  if (requested === "original" || requested === "null") {
    const normalized = normalizeFormat(inputFormat);
    if (normalized) return normalized;
    return hasAlpha ? "png" : "jpeg";
  }

  if (requested === "jpeg" || requested === "jpg") {
    return "jpeg";
  }

  // PNG with transparency must not be auto-converted to JPEG.
  if (hasAlpha && (inputFormat === "png" || inputFormat === "webp" || inputFormat === "avif")) {
    if (requested === "png" || requested === "webp" || requested === "avif") {
      return normalizeFormat(requested) || "png";
    }
    return normalizeFormat(inputFormat) || "png";
  }

  // Opaque non-PNG → JPEG when PNG output requested (smaller, no alpha needed).
  if (requested === "png" && !hasAlpha && inputFormat !== "png") {
    return "jpeg";
  }

  return normalizeFormat(requested) || config.image.outputFormat;
}

/** Encode presets: strip bloat, no mozjpeg/sharpen, ~1% loss at store quality. */
function applySharpFormat(pipeline, format, quality) {
  switch (format) {
    case "jpeg":
    case "jpg":
      return pipeline.jpeg({
        // quality,
        // progressive: true,
        // mozjpeg: true,
        // optimiseCoding: true , 
        // chromaSubsampling: "4:2:0"

        quality: 82,

        mozjpeg: true,
      
        progressive: true,
      
        chromaSubsampling: "4:2:0",
      
        optimizeCoding: true,
      
        trellisQuantisation: true,
      
        overshootDeringing: true,
      
        optimizeScans: true,
      
        quantizationTable: 3
      });

    case "png":
      return pipeline.png({
        // compressionLevel: 9,
        // progressive: true,
        // palette: true,
        // quality: 80,
        // effort: 10,

        compressionLevel: 9,

        adaptiveFiltering: true,
      
        effort: 10,
      
        quality: 80,
      
        palette: true
      });

    case "webp":
      return pipeline.webp({
        quality: 80,
        effort: 6,
        smartSubsample: true

        // quality: 80,
        // effort: 6,
        // smartSubsample: true,
        // nearLossless: false,
        // alphaQuality: 80,
      });

    case "avif":
      return pipeline.avif({
        quality,
        effort: 4,
      });

    case "gif":
      return pipeline.gif();

    default:
      return pipeline.jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        optimiseCoding: true , 
        chromaSubsampling: "4:2:0"
      });
  }
}

/**
 * Strip EXIF/IPTC/XMP/ICC, fix orientation, optional downscale, re-encode for smaller files.
 */
async function encodeWithSharp(originalSRC, { format, quality, meta: metaIn }) {
  const meta =
    metaIn || (await sharp(originalSRC, { failOn: "none" }).metadata());
  const inputFormat = normalizeInputFormat(meta.format);
  const hasAlpha = Boolean(meta.hasAlpha);
  const outputFormat = resolveOutputFormat(format, inputFormat, hasAlpha);
  const isGif = inputFormat === "gif" || outputFormat === "gif";

  let pipeline = sharp(originalSRC, { failOn: "none" });

  if (meta.orientation && meta.orientation !== 1) {
    pipeline = pipeline.rotate();
  }

   // Resize (VERY IMPORTANT)
   if (!isGif) {
    pipeline = pipeline.resize({
      width: config.image.optimizeMaxDimension,
      height: config.image.optimizeMaxDimension,
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
      fastShrinkOnLoad: true,
    });
  }

  if (!isGif && needsResize(meta)) {
    pipeline = pipeline.resize({
      width: config.image.optimizeMaxDimension,
      height: config.image.optimizeMaxDimension,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  if (outputFormat === "jpeg" && hasAlpha) {
    pipeline = pipeline.flatten({
      background: { r: 255, g: 255, b: 255 },
    });
  }

  pipeline = pipeline.withMetadata(false);
  pipeline = applySharpFormat(pipeline, outputFormat, quality);

  const { data, info } = await pipeline.toBuffer({
    resolveWithObject: true,
  });

  return { data, info, outputFormat, meta };
}

/** Try encode; step quality down slightly until file is smaller than original. */
async function encodeForSmallerFile(originalSRC, options, originalSize) {
  const baseQuality = resolveEncodeQuality(options.quality);
  const attempts = [
    baseQuality,
    Math.max(75, baseQuality - 4),
    Math.max(70, baseQuality - 8),
  ];
  const seen = new Set();

  for (const quality of attempts) {
    if (seen.has(quality)) continue;
    seen.add(quality);

    const result = await encodeWithSharp(originalSRC, {
      format: options.format,
      quality,
      meta: options.meta,
    });

    if (result.data.length < originalSize) {
      return { ...result, encodeQuality: quality };
    }
  }

  const last = await encodeWithSharp(originalSRC, {
    format: options.format,
    quality: baseQuality,
    meta: options.meta,
  });

  return { ...last, encodeQuality: baseQuality };
}

async function loadOriginalBytes(originalSRC, meta) {
  const data = await fs.readFile(originalSRC);
  const fromPath = path.extname(originalSRC).replace(/^\./, "").toLowerCase();
  const fileExtension = fromPath
    ? fromPath === "jpg"
      ? "jpeg"
      : fromPath
    : normalizeFormat(meta.format) || "jpeg";

  return {
    data,
    optimizedInfo: {
      width: meta.width,
      height: meta.height,
      format: meta.format,
      size: data.length,
    },
    fileExtension,
    usedOriginalBytes: true,
  };
}

async function resolveOptimizedFilePath({
  originalSRC,
  outputPath,
  outputBaseName,
  fileExtension,
}) {
  const resolvedOutputPath = path.resolve(outputPath);
  let finalPath = resolvedOutputPath;

  try {
    const stat = await fs.stat(resolvedOutputPath);
    if (stat.isDirectory()) {
      const baseName =
        outputBaseName != null && String(outputBaseName).length > 0
          ? String(outputBaseName)
          : path.parse(originalSRC).name || "optimized";

      finalPath = path.join(
        resolvedOutputPath,
        `${baseName}-optimized.${fileExtension}`
      );
    }
  } catch {
    // Treat outputPath as a full file path.
  }

  return finalPath;
}

/**
 * Optimize for smaller file size: strip metadata, re-encode (~1% quality loss OK).
 * Uses original bytes only when encoded output would be larger.
 *
 * @param {string} originalSRC - Path to source file
 * @param {object} options
 * @param {number} [options.quality] - Frontend/store slider 1–100
 * @param {string} [options.format] - jpeg | png | webp | avif | original
 * @param {string} [options.outputPath] - Directory or file path to write
 * @param {string} [options.outputBaseName] - Base name when outputPath is a directory
 */
exports.optimizeImage = async (originalSRC, options = {}) => {
  try {
    const { outputPath, outputBaseName } = options;

    const encodeQuality = resolveEncodeQuality(options.quality);
    const originalStat = await fs.stat(originalSRC);
    const originalSize = originalStat.size;
    const meta = await sharp(originalSRC, { failOn: "none" }).metadata();

    const originalStats = {
      width: meta.width,
      height: meta.height,
      format: meta.format,
      size: originalSize,
    };

    const {
      data: encoded,
      info,
      outputFormat,
      encodeQuality: usedEncodeQuality,
    } = await encodeForSmallerFile(
      originalSRC,
      { format: options.format, quality: options.quality, meta },
      originalSize
    );

    let data = encoded;
    let optimizedInfo = info;
    let usedOriginalBytes = false;
    let fileExtension = outputFormat;

    if (encoded.length >= originalSize) {
      const passthrough = await loadOriginalBytes(originalSRC, meta);
      data = passthrough.data;
      optimizedInfo = passthrough.optimizedInfo;
      fileExtension = passthrough.fileExtension;
      usedOriginalBytes = true;
    }

    const savedBytes = Math.max(0, originalStats.size - optimizedInfo.size);
    const savedPercent =
      originalStats.size > 0
        ? Number(((savedBytes / originalStats.size) * 100).toFixed(2))
        : 0;

    let savedPath = null;

    if (outputPath) {
      const finalPath = await resolveOptimizedFilePath({
        originalSRC,
        outputPath,
        outputBaseName,
        fileExtension,
      });

      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, data);
      savedPath = finalPath;
    }

    return {
      optimizedImage: {
        outputPath: savedPath,
        original: originalStats,
        optimized: {
          width: optimizedInfo.width,
          height: optimizedInfo.height,
          format: optimizedInfo.format,
          size: optimizedInfo.size,
        },
        compression: {
          savedBytes,
          savedPercent,
        },
        usedOriginalBytes,
        quality: usedEncodeQuality ?? encodeQuality,
        format: fileExtension,
      },
    };
  } catch (err) {
    return {
      error: err.message,
      outputPath: null,
    };
  }
};

exports.mapFrontendQualityToSharpQuality = mapFrontendQualityToSharpQuality;
exports.resolveEncodeQuality = resolveEncodeQuality;