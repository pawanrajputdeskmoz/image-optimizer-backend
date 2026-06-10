const { buildApp } = require("./app");
const config = require("./config");
const { port, host } = config.server;

let app;
let isShuttingDown = false;

async function shutdown() {
  if (!app || isShuttingDown) return;
  isShuttingDown = true;
  try {
    await app.close();
  } finally {
    app = null;
    isShuttingDown = false;
  }
}

async function startServer() {
  app = await buildApp();

  try {
    await app.listen({ port, host });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Stop the other server (Ctrl+C) or run: netstat -ano | findstr ":${port}"`
      );
    }
    throw err;
  }

  const onShutdown = async () => {
    await shutdown();
    process.exit(0);
  };

  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);

  return app;
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { startServer };
