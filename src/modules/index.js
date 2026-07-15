const { imageOptimizationRoutes } = require("./imageOptimization/routes");
const { homeImagesRoutes } = require("./homeImages/routes");
const { categoryImagesRoutes } = require("./categoryImages/routes");
const { brandImagesRoutes } = require("./brandImages/routes");
const { installationRoutes } = require("./installation/routes");
const { settingRoutes } = require("./setting/routes");
const { adminRoutes } = require("./admin");
const { paymentRoutes } = require("./payment/routes");

module.exports = {
  imageOptimizationRoutes,
  homeImagesRoutes,
  categoryImagesRoutes,
  brandImagesRoutes,
  installationRoutes,
  settingRoutes,
  adminRoutes,
  paymentRoutes,
};
