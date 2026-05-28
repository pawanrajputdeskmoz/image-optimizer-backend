const { installApp, uninstallApp, loadBigComApp} = require("./controller");

async function installationRoutes(app) {
  app.get("/install", installApp);

  app.get("/uninstall", uninstallApp);

  app.post("/load-application",loadBigComApp)
}

module.exports = { installationRoutes };
