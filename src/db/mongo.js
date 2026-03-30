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

    await mongoose.connect(uri, dbName ? { dbName } : {});

    isConnected = true;

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