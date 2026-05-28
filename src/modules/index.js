const { imageOptimizationRoutes } = require("./imageOptimization/routes");
const { installationRoutes } = require("./installation/routes");
const { queueRoutes } = require("./queue/routes");
const { settingRoutes } = require("./setting/routes");

module.exports = {
  imageOptimizationRoutes,
  installationRoutes,
  queueRoutes,
  settingRoutes,
};
