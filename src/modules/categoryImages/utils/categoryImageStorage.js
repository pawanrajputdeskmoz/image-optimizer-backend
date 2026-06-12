const path = require("node:path");
const fs = require("node:fs/promises");
const { downloadImage } = require("../../../utils/downloadImage");

function resolveOptimizedFileExtension(outputFormat) {
  const format = String(outputFormat || "jpeg").toLowerCase();
  if (format === "png") return ".png";
  if (format === "gif") return ".gif";
  if (format === "ico") return ".ico";
  return ".jpg";
}

async function downloadCategoryImageToStorage({ imageUrl, storeHash, categoryId }) {
  const result = await downloadImage({
    imageUrl,
    storeHash,
    sourceType: "category",
    categoryId,
    productId: categoryId,
    imageId: categoryId,
  });

  if (result.error || !result.filePath) {
    return {
      error: result.error || "Failed to download category image",
      originalImagePath: null,
      optimizedImagesDir: null,
      assetId: null,
    };
  }

  return {
    error: null,
    originalImagePath: result.filePath,
    optimizedImagesDir: result.optimizedImagesDir,
    assetId: result.assetId,
  };
}

async function saveOptimizedCategoryImageToStorage({
  optimizedImagesDir,
  assetId,
  outputFormat,
  fileBuffer,
}) {
  const extension = resolveOptimizedFileExtension(outputFormat);
  const fileName = `${assetId}-optimized${extension}`;
  const optimizedImagePath = path.join(optimizedImagesDir, fileName);

  await fs.mkdir(optimizedImagesDir, { recursive: true });
  await fs.writeFile(optimizedImagePath, fileBuffer);

  return optimizedImagePath;
}

module.exports = {
  downloadCategoryImageToStorage,
  saveOptimizedCategoryImageToStorage,
  resolveOptimizedFileExtension,
};
