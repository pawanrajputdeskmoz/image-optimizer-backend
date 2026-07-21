const mongoose = require("mongoose");
const { config: loadEnv } = require("dotenv");

loadEnv();

const models = require("../src/models");
const storeArg = process.argv.find((arg) => arg.startsWith("--store="));
const selectedStoreHash = storeArg ? storeArg.slice("--store=".length).trim() : null;

const storeOwnedModels = [
  models.BrandImage,
  models.BrandImageJobLog,
  models.BrandImageStatus,
  models.BrandJob,
  models.BrandJobItem,
  models.CategoryImage,
  models.CategoryImageLog,
  models.CategoryImageStatus,
  models.CategoryJob,
  models.CategoryJobItem,
  models.CategoryWebhookLog,
  models.ClientPlan,
  models.HomeBannerImage,
  models.ImageJob,
  models.ImageJobItem,
  models.ImageOldData,
  models.ImageOptimization,
  models.ImageOptimizationLog,
  models.ImageStatus,
  models.PaymentHistory,
  models.PlanLimitNotification,
  models.StoreCategoryWebhook,
  models.StoreCategoryWebhookEvent,
  models.StoreImageStat,
  models.StoreMonthlyUsage,
  models.StoreOptimizationSettings,
  models.StoreWebhook,
  models.StoreWebhookEvent,
  models.WebhookLog,
].filter(Boolean);

async function mergeLookup({
  sourceModel,
  targetModel,
  letFields,
  matchExpr,
  setFields,
  sourceMatch = {},
  sort = null,
}) {
  const scopedSourceMatch = selectedStoreHash
    ? { $and: [sourceMatch, { store_hash: selectedStoreHash }] }
    : sourceMatch;
  const lookupPipeline = [{ $match: { $expr: matchExpr } }];
  if (sort) lookupPipeline.push({ $sort: sort });
  lookupPipeline.push({ $limit: 1 });

  await sourceModel.collection
    .aggregate(
      [
        { $match: scopedSourceMatch },
        {
          $lookup: {
            from: targetModel.collection.name,
            let: letFields,
            pipeline: lookupPipeline,
            as: "_relation",
          },
        },
        { $set: { _relation: { $first: "$_relation" } } },
        { $match: { "_relation._id": { $exists: true } } },
        { $set: setFields },
        { $unset: "_relation" },
        {
          $merge: {
            into: sourceModel.collection.name,
            on: "_id",
            whenMatched: "merge",
            whenNotMatched: "discard",
          },
        },
      ],
      { allowDiskUse: true }
    )
    .toArray();

  console.log(`[relations] ${sourceModel.modelName} updated`);
}

async function backfillStoreOwners() {
  for (const model of storeOwnedModels) {
    await mergeLookup({
      sourceModel: model,
      targetModel: models.User,
      sourceMatch: {
        store_hash: { $type: "string" },
        $or: [{ user_id: { $exists: false } }, { user_id: null }],
      },
      letFields: { storeHash: "$store_hash" },
      matchExpr: { $eq: ["$store_hash", "$$storeHash"] },
      setFields: { user_id: "$_relation._id" },
    });
  }
}

async function backfillPlans() {
  const planLinks = [
    [models.ClientPlan, "base_plan_slug"],
    [models.PaymentHistory, "plan_slug"],
    [models.StoreMonthlyUsage, "plan_slug"],
  ];

  for (const [sourceModel, slugField] of planLinks) {
    await mergeLookup({
      sourceModel,
      targetModel: models.Plan,
      sourceMatch: {
        [slugField]: { $type: "string" },
        $or: [{ plan_id: { $exists: false } }, { plan_id: null }],
      },
      letFields: { planSlug: `$${slugField}` },
      matchExpr: { $eq: ["$slug", "$$planSlug"] },
      setFields: { plan_id: "$_relation._id" },
    });
  }
}

async function backfillJobs() {
  const jobLinks = [
    [models.ImageJobItem, models.ImageJob],
    [models.ImageOptimizationLog, models.ImageJob],
    [models.CategoryJobItem, models.CategoryJob],
    [models.CategoryImageLog, models.CategoryJob],
    [models.BrandJobItem, models.BrandJob],
    [models.BrandImageJobLog, models.BrandJob],
  ];

  for (const [sourceModel, jobModel] of jobLinks) {
    await mergeLookup({
      sourceModel,
      targetModel: jobModel,
      sourceMatch: {
        job_uuid: { $type: "string" },
        $or: [{ job_id: { $exists: false } }, { job_id: null }],
      },
      letFields: { jobUuid: "$job_uuid", storeHash: "$store_hash" },
      matchExpr: {
        $and: [
          { $eq: ["$job_uuid", "$$jobUuid"] },
          { $eq: ["$store_hash", "$$storeHash"] },
        ],
      },
      setFields: {
        job_id: "$_relation._id",
        user_id: { $ifNull: ["$user_id", "$_relation.user_id"] },
      },
    });
  }
}

async function backfillImages() {
  for (const sourceModel of [models.ImageStatus, models.ImageOldData]) {
    await mergeLookup({
      sourceModel,
      targetModel: models.ImageOptimization,
      sourceMatch: {
        $or: [
          { image_optimization_id: { $exists: false } },
          { image_optimization_id: null },
        ],
      },
      letFields: {
        storeHash: "$store_hash",
        productId: "$product_id",
        imageId: "$image_id",
      },
      matchExpr: {
        $and: [
          { $eq: ["$store_hash", "$$storeHash"] },
          { $eq: ["$product_id", "$$productId"] },
          { $eq: ["$image_id", "$$imageId"] },
        ],
      },
      setFields: {
        image_optimization_id: "$_relation._id",
        user_id: { $ifNull: ["$user_id", "$_relation.user_id"] },
      },
    });
  }

  await mergeLookup({
    sourceModel: models.CategoryImageStatus,
    targetModel: models.CategoryImage,
    sourceMatch: {
      $or: [{ category_image_id: { $exists: false } }, { category_image_id: null }],
    },
    letFields: {
      storeHash: "$store_hash",
      categoryId: "$category_id",
    },
    matchExpr: {
      $and: [
        { $eq: ["$store_hash", "$$storeHash"] },
        { $eq: ["$category_id", "$$categoryId"] },
      ],
    },
    sort: { updated_at: -1, _id: -1 },
    setFields: {
      category_image_id: "$_relation._id",
      user_id: { $ifNull: ["$user_id", "$_relation.user_id"] },
    },
  });

  await mergeLookup({
    sourceModel: models.BrandImageStatus,
    targetModel: models.BrandImage,
    sourceMatch: {
      $or: [{ brand_image_id: { $exists: false } }, { brand_image_id: null }],
    },
    letFields: {
      storeHash: "$store_hash",
      brandId: "$brand_id",
    },
    matchExpr: {
      $and: [
        { $eq: ["$store_hash", "$$storeHash"] },
        { $eq: ["$brand_id", "$$brandId"] },
      ],
    },
    sort: { updated_at: -1, _id: -1 },
    setFields: {
      brand_image_id: "$_relation._id",
      user_id: { $ifNull: ["$user_id", "$_relation.user_id"] },
    },
  });
}

async function backfillWebhooks() {
  const webhookLinks = [
    [models.StoreWebhookEvent, models.StoreWebhook],
    [models.StoreCategoryWebhookEvent, models.StoreCategoryWebhook],
  ];

  for (const [eventModel, registrationModel] of webhookLinks) {
    await mergeLookup({
      sourceModel: eventModel,
      targetModel: registrationModel,
      sourceMatch: {
        scope: { $type: "string" },
        $or: [{ webhook_id: { $exists: false } }, { webhook_id: null }],
      },
      letFields: { storeHash: "$store_hash", scope: "$scope" },
      matchExpr: {
        $and: [
          { $eq: ["$store_hash", "$$storeHash"] },
          { $eq: ["$scope", "$$scope"] },
        ],
      },
      setFields: {
        webhook_id: "$_relation._id",
        user_id: { $ifNull: ["$user_id", "$_relation.user_id"] },
      },
    });
  }

  const logLinks = [
    [models.WebhookLog, models.StoreWebhookEvent],
    [models.CategoryWebhookLog, models.StoreCategoryWebhookEvent],
  ];

  for (const [logModel, eventModel] of logLinks) {
    await mergeLookup({
      sourceModel: logModel,
      targetModel: eventModel,
      sourceMatch: {
        event_hash: { $type: "string" },
        $or: [
          { webhook_event_id: { $exists: false } },
          { webhook_event_id: null },
        ],
      },
      letFields: { storeHash: "$store_hash", eventHash: "$event_hash" },
      matchExpr: {
        $and: [
          { $eq: ["$store_hash", "$$storeHash"] },
          { $eq: ["$event_hash", "$$eventHash"] },
        ],
      },
      setFields: {
        webhook_event_id: "$_relation._id",
        user_id: { $ifNull: ["$user_id", "$_relation.user_id"] },
      },
    });

    await eventModel.collection
      .aggregate(
        [
          {
            $lookup: {
              from: logModel.collection.name,
              localField: "_id",
              foreignField: "webhook_event_id",
              pipeline: [
                { $group: { _id: null, sequence: { $max: "$sequence" } } },
              ],
              as: "_logs",
            },
          },
          { $set: { _logs: { $first: "$_logs" } } },
          { $set: { log_sequence: { $ifNull: ["$_logs.sequence", 0] } } },
          { $unset: "_logs" },
          {
            $merge: {
              into: eventModel.collection.name,
              on: "_id",
              whenMatched: "merge",
              whenNotMatched: "discard",
            },
          },
        ],
        { allowDiskUse: true }
      )
      .toArray();
  }
}

async function createIndexes() {
  for (const model of Object.values(models)) {
    if (!model?.createIndexes || !model?.modelName) continue;
    await model.createIndexes();
    console.log(`[indexes] ${model.modelName} ready`);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri, {
    ...(process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {}),
    autoIndex: false,
  });

  if (selectedStoreHash) {
    console.log(`[relations] scoped to store ${selectedStoreHash}`);
  }

  if (process.argv.includes("--indexes-only")) {
    await createIndexes();
    return;
  }

  await backfillStoreOwners();
  await backfillPlans();
  await backfillJobs();
  await backfillImages();
  await backfillWebhooks();

  if (process.argv.includes("--with-indexes")) {
    await createIndexes();
  }
}

main()
  .then(() => {
    console.log("[relations] migration complete");
  })
  .catch((error) => {
    console.error("[relations] migration failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
