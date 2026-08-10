const {
  CategoryImage,
  CategoryImageStatus,
  CategoryImageLog,
  CategoryJobItem,
  CategoryWebhookLog,
} = require("../../../models");
const { deleteFile } = require("../../../utils/deleteFile");

/**
 * Remove all DB records and local backup files for a category image optimization run.
 * Called before re-optimize so stale CategoryImage rows and preview data do not linger.
 */
async function cleanupCategoryOptimizationRecords({
  storeHash,
  categoryId,
  includeLogs = true,
}) {
  const resolvedCategoryId = Number(categoryId);
  if (
    !storeHash ||
    !Number.isFinite(resolvedCategoryId) ||
    resolvedCategoryId <= 0
  ) {
    return {
      cleaned: false,
      hadRecords: false,
      deletedImageRecords: 0,
      error: "Invalid storeHash or categoryId",
    };
  }

  const dbQuery = {
    store_hash: storeHash,
    category_id: resolvedCategoryId,
  };

  const categoryImages = await CategoryImage.find(dbQuery)
    .select({ original_image_path: 1, optimized_image_path: 1 })
    .lean();

  const [
    hasStatus,
    hasLogs,
    hasJobItems,
    hasWebhookLogs,
  ] = await Promise.all([
    CategoryImageStatus.exists(dbQuery),
    includeLogs ? CategoryImageLog.exists(dbQuery) : false,
    includeLogs ? CategoryJobItem.exists(dbQuery) : false,
    includeLogs ? CategoryWebhookLog.exists(dbQuery) : false,
  ]);

  const hadRecords =
    categoryImages.length > 0 ||
    Boolean(hasStatus) ||
    Boolean(hasLogs) ||
    Boolean(hasJobItems) ||
    Boolean(hasWebhookLogs);

  if (!hadRecords) {
    return {
      cleaned: false,
      hadRecords: false,
      deletedImageRecords: 0,
      error: null,
    };
  }

  const deleteTasks = [
    CategoryImage.deleteMany(dbQuery),
    CategoryImageStatus.deleteMany(dbQuery),
  ];

  if (includeLogs) {
    deleteTasks.push(
      CategoryImageLog.deleteMany(dbQuery),
      CategoryJobItem.deleteMany(dbQuery),
      CategoryWebhookLog.deleteMany(dbQuery)
    );
  }

  try {
    await Promise.all(deleteTasks);
  } catch (err) {
    console.error(
      "[cleanupCategoryOptimizationRecords] DB cleanup error:",
      err.message
    );
    return {
      cleaned: false,
      hadRecords: true,
      deletedImageRecords: categoryImages.length,
      error: err.message,
    };
  }

  const filePaths = new Set();
  for (const row of categoryImages) {
    if (row.original_image_path) {
      filePaths.add(row.original_image_path);
    }
    if (row.optimized_image_path) {
      filePaths.add(row.optimized_image_path);
    }
  }

  await Promise.all(
    [...filePaths].map((filePath) =>
      deleteFile(filePath).catch((err) => {
        console.error(
          "[cleanupCategoryOptimizationRecords] delete file:",
          err.message
        );
      })
    )
  );

  return {
    cleaned: true,
    hadRecords: true,
    deletedImageRecords: categoryImages.length,
    error: null,
  };
}

module.exports = {
  cleanupCategoryOptimizationRecords,
};
