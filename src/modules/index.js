const { imageOptimizationRoutes } = require("./imageOptimization/routes");
const { categoryImagesRoutes } = require("./categoryImages/routes");
const { installationRoutes } = require("./installation/routes");
const { settingRoutes } = require("./setting/routes");
const { adminRoutes } = require("./admin");
const { paymentRoutes } = require("./payment/routes");

module.exports = {
  imageOptimizationRoutes,
  categoryImagesRoutes,
  installationRoutes,
  settingRoutes,
  adminRoutes,
  paymentRoutes,
};
