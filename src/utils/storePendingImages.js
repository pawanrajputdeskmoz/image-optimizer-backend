const StoreImageStat = require("../models/StoreImageStat");

/**
 * Apply delta then floor at 0 so counters cannot drift negative.
 */
async function adjustCounterField(storeHash, field, delta, userId = null) {
  const amount = Number(delta) || 0;
  if (!storeHash || amount === 0) return { error: null };

  try {
    await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      [
        {
          $set: {
            [field]: {
              $max: [
                0,
                { $add: [{ $ifNull: [`$${field}`, 0] }, amount] },
              ],
            },
            ...(userId ? { user_id: userId } : {}),
            store_hash: { $ifNull: ["$store_hash", storeHash] },
          },
        },
      ],
      { upsert: true }
    );
    return { error: null };
  } catch (err) {
    console.error(`[adjustCounterField:${field}]`, err.message);
    return { error: err.message };
  }
}

/**
 * Adjust dashboard pending_images counter (floored at 0).
 */
async function adjustPendingImages(storeHash, delta, userId = null) {
  return adjustCounterField(storeHash, "pending_images", delta, userId);
}

/**
 * Replace catalog totals after a fresh catalog scan.
 */
async function setCatalogImageStats(
  storeHash,
  { totalCatalogImages = 0, userId = null } = {}
) {
  if (!storeHash) return { error: null };

  try {
    await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $set: {
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
    console.error("[setCatalogImageStats]", err.message);
    return { error: err.message };
  }
}

module.exports = {
  adjustPendingImages,
  setCatalogImageStats,
};
