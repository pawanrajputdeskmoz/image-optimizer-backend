const { installApp, uninstallApp } = require("./controller");

async function installationRoutes(app) {
  app.get("/install", installApp);

  app.get("/uninstall", uninstallApp);
}

module.exports = { installationRoutes };
