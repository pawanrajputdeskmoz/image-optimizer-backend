const mongoose = require("mongoose");

let isConnected = false;

async function connectMongo() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.log("❌ MongoDB URI not found");
    process.exit(1);
  }

  if (isConnected) {
    return mongoose.connection;
  }

  try {
    const dbName = process.env.MONGODB_DB;
    const autoIndex =
      process.env.MONGOOSE_AUTO_INDEX != null
        ? process.env.MONGOOSE_AUTO_INDEX === "true"
        : process.env.NODE_ENV !== "production";

    await mongoose.connect(uri, {
      ...(dbName ? { dbName } : {}),
      autoIndex,
    });

    isConnected = true;

    const { HomeBannerImage } = require("../models");
    if (autoIndex && HomeBannerImage?.syncModelIndexes) {
      await HomeBannerImage.syncModelIndexes();
    }

    const { ensureDefaultPlans } = require("../modules/plans/service");
    await ensureDefaultPlans();

    console.log("✅ MongoDB connected via Mongoose");

    return mongoose.connection;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
}

function getDb() {
  if (!isConnected) {
    throw new Error("MongoDB is not connected. Call connectMongo() first.");
  }
  return mongoose.connection;
}

module.exports = { connectMongo, getDb };