const User = require("../models/User");
const StoreOptimizationSettings = require("../models/StoreOptimizationSettings");

/**
 * When a store leaves a paid plan, turn off Cruise Control settings and
 * best-effort remove BigCommerce product/category auto-optimize webhooks.
 * Never throws — plan/subscription changes must still succeed.
 */
async function disableCruiseControlOnFreePlan(storeHash) {
  if (!storeHash) return;

  try {
    await StoreOptimizationSettings.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $set: {
          auto_optimize_new_images: false,
          auto_optimize_new_category_images: false,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    const user = await User.findOne({ store_hash: storeHash })
      .select({ access_token: 1 })
      .lean();
    const accessToken = user?.access_token ? String(user.access_token).trim() : "";
    if (!accessToken) {
      return;
    }

    const {
      disableProductWebhooks,
      disableCategoryWebhooks,
    } = require("../modules/setting/services");

    await Promise.all([
      disableProductWebhooks({ storeHash, accessToken }).catch((err) => {
        console.error("[disableCruiseControlOnFreePlan] product webhooks:", {
          storeHash,
          message: err?.message,
        });
      }),
      disableCategoryWebhooks({ storeHash, accessToken }).catch((err) => {
        console.error("[disableCruiseControlOnFreePlan] category webhooks:", {
          storeHash,
          message: err?.message,
        });
      }),
    ]);
  } catch (err) {
    console.error("[disableCruiseControlOnFreePlan]", {
      storeHash,
      message: err?.message,
    });
  }
}

module.exports = {
  disableCruiseControlOnFreePlan,
};
