const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Persists downloads under storage/{year}/{month}/{day}/{storeHash}/ so old
 * months can be removed in bulk (e.g. delete storage/2026/04 for April).
 */
exports.downloadImage = async ({
 imageUrl,
 storeHash,
 productId,
 imageId,
 sourceType = "product",
 categoryId = null,
}) => {
 try {
 const now = new Date();
 const year = String(now.getFullYear());
 const month = String(now.getMonth() + 1).padStart(2, "0");
 const day = String(now.getDate()).padStart(2, "0");

 const baseDir = path.join(
   process.cwd(),
   "storage",
   year,
   month,
   day,
   storeHash
 );

 const isCategory = sourceType === "category";
 const storageSegment = isCategory ? "category" : null;
 const storageRoot = storageSegment
   ? path.join(baseDir, storageSegment)
   : baseDir;

 const originalImagesDir = path.join(storageRoot, "original");
 const optimizedImagesDir = path.join(storageRoot, "optimized");

 fs.mkdirSync(originalImagesDir, { recursive: true });
 fs.mkdirSync(optimizedImagesDir, { recursive: true });

 const assetId = crypto.randomUUID();

 // Extract extension from URL
 const extension =
   path.extname(new URL(imageUrl).pathname) || ".jpg";

 const fileName = `${assetId}${extension}`;

 // Final file path
 const filePath = path.join(originalImagesDir, fileName);

 // Download image as stream
 const response = await axios({
   method: "GET",
   url: imageUrl,
   responseType: "stream",
 });

 // Save file
 await new Promise((resolve, reject) => {
   const writer = fs.createWriteStream(filePath);

   response.data.pipe(writer);

   writer.on("finish", resolve);
   writer.on("error", reject);
 });
 console.log("Image downloaded successfully", fileName , filePath, originalImagesDir, optimizedImagesDir);

 // Return saved file path
 return {
   fileName,
   filePath,
   originalImagesDir,
   optimizedImagesDir,
   assetId,
 };
} catch (error) {
  return {
    error: error.message,
    filePath: null,
    optimizedImagesDir: null,
  };
}
};