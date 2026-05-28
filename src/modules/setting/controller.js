const StoreOptimizationSettings = require("../../models/StoreOptimizationSettings");

exports.getStoreOptimizationSettings = async (req, reply) => {
  const store_hash = req.storeHash;
  const doc = await StoreOptimizationSettings.findOne({ store_hash }).lean();

  if (!doc) {
    return reply.send({
      success: true,
      message: "No saved settings yet",
      data: null,
    });
  }

  return reply.send({
    success: true,
    message: "Settings loaded",
    data: doc,
  });
};

const ALLOWED_KEYS = new Set([
  "channel_id",
  "optimize_image_enabled",
  "is_filename_template_enabled",
  "filename_template",
  "is_alt_text_template_enabled",
  "alt_text_template",
  "image_quality",
  "output_format",
  "auto_optimize_new_images",
]);

exports.upsertStoreOptimizationSettings = async (req, reply) => {
  const store_hash = req.storeHash;
  const body = req.body || {};

  const $set = { store_hash };
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === "channel_id" && typeof body.channel_id !== "number") continue;
    $set[key] = body[key];
  }

  const doc = await StoreOptimizationSettings.findOneAndUpdate(
    { store_hash },
    { $set },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  return reply.send({
    success: true,
    message: "Settings saved",
    data: doc.toObject(),
  });
};
