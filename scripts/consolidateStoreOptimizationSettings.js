/**
 * Collapse store_optimization_settings to one document per store_hash.
 * Prefers channel_id=1, else the most recently updated row.
 * Also replaces legacy compound unique indexes with store_hash unique.
 *
 * Usage:
 *   node backend/scripts/consolidateStoreOptimizationSettings.js
 *   node backend/scripts/consolidateStoreOptimizationSettings.js --dry-run
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const mongoose = require("mongoose");
const StoreOptimizationSettings = require("../src/models/StoreOptimizationSettings");

const dryRun = process.argv.includes("--dry-run");

async function dropLegacyIndexes(collection) {
  const indexes = await collection.indexes();
  const dropNames = [
    "store_hash_1_channel_id_1",
    "user_id_1_channel_id_1",
  ];
  for (const name of dropNames) {
    if (indexes.some((idx) => idx.name === name)) {
      if (dryRun) {
        console.log(`[dry-run] would drop index ${name}`);
      } else {
        await collection.dropIndex(name);
        console.log(`dropped index ${name}`);
      }
    }
  }
}

async function consolidate() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGODB_URI / MONGO_URI is not set");
  }

  await mongoose.connect(uri);
  const collection = StoreOptimizationSettings.collection;

  await dropLegacyIndexes(collection);

  const storeHashes = await StoreOptimizationSettings.distinct("store_hash");
  let kept = 0;
  let removed = 0;

  for (const storeHash of storeHashes) {
    const docs = await StoreOptimizationSettings.find({ store_hash: storeHash })
      .sort({ updated_at: -1 })
      .lean();

    if (docs.length <= 1) {
      if (docs[0] && docs[0].channel_id !== 1) {
        if (dryRun) {
          console.log(`[dry-run] would set channel_id=1 for ${storeHash}`);
        } else {
          await StoreOptimizationSettings.updateOne(
            { _id: docs[0]._id },
            { $set: { channel_id: 1 } }
          );
        }
      }
      kept += docs.length;
      continue;
    }

    const preferred =
      docs.find((d) => Number(d.channel_id) === 1) || docs[0];
    const removeIds = docs
      .filter((d) => String(d._id) !== String(preferred._id))
      .map((d) => d._id);

    if (dryRun) {
      console.log(
        `[dry-run] ${storeHash}: keep ${preferred._id} (channel ${preferred.channel_id}), remove ${removeIds.length}`
      );
    } else {
      await StoreOptimizationSettings.updateOne(
        { _id: preferred._id },
        { $set: { channel_id: 1 } }
      );
      const result = await StoreOptimizationSettings.deleteMany({
        _id: { $in: removeIds },
      });
      removed += result.deletedCount || 0;
      console.log(
        `${storeHash}: kept ${preferred._id}, deleted ${result.deletedCount}`
      );
    }
    kept += 1;
  }

  if (!dryRun) {
    await StoreOptimizationSettings.syncIndexes();
    console.log("synced mongoose indexes");
  } else {
    console.log("[dry-run] would sync mongoose indexes");
  }

  console.log({ dryRun, stores: storeHashes.length, kept, removed });
  await mongoose.disconnect();
}

consolidate().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
