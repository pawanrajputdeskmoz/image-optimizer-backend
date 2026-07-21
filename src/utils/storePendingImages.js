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

module.exports = {
  adjustPendingImages,
};
