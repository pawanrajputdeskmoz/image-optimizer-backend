const StoreImageStat = require("../models/StoreImageStat");

/**
 * Adjust dashboard pending_images counter (can be negative for completions).
 */
async function adjustPendingImages(storeHash, delta, userId = null) {
  const amount = Number(delta) || 0;
  if (!storeHash || amount === 0) return { error: null };

  try {
    await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $inc: { pending_images: amount },
        ...(userId ? { $set: { user_id: userId } } : {}),
        $setOnInsert: { store_hash: storeHash },
      },
      { upsert: true }
    );
    return { error: null };
  } catch (err) {
    console.error("[adjustPendingImages]", err.message);
    return { error: err.message };
  }
}

/**
 * Adjust catalog-derived pending image count shown on the dashboard.
 */
async function adjustCatalogPendingImages(storeHash, delta, userId = null) {
  const amount = Number(delta) || 0;
  if (!storeHash || amount === 0) return { error: null };

  try {
    await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $inc: { catalog_pending_images: amount },
        ...(userId ? { $set: { user_id: userId } } : {}),
        $setOnInsert: { store_hash: storeHash },
      },
      { upsert: true }
    );
    return { error: null };
  } catch (err) {
    console.error("[adjustCatalogPendingImages]", err.message);
    return { error: err.message };
  }
}

/**
 * Replace dashboard catalog counts after a fresh catalog scan.
 */
async function setCatalogPendingImages(
  storeHash,
  { pending = 0, totalCatalogImages = 0, userId = null } = {}
) {
  if (!storeHash) return { error: null };

  try {
    await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $set: {
          catalog_pending_images: Math.max(0, Number(pending) || 0),
          total_catalog_images: Math.max(0, Number(totalCatalogImages) || 0),
          last_catalog_sync_at: new Date(),
          ...(userId ? { user_id: userId } : {}),
        },
        $setOnInsert: { store_hash: storeHash },
      },
      { upsert: true }
    );
    return { error: null };
  } catch (err) {
    console.error("[setCatalogPendingImages]", err.message);
    return { error: err.message };
  }
}

module.exports = {
  adjustPendingImages,
  adjustCatalogPendingImages,
  setCatalogPendingImages,
};
