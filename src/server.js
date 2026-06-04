const { buildApp } = require("./app");
const config = require("./config");
const { port, host } = config.server;

async function startServer() {
  const app = await buildApp();
  await app.listen({ port, host });
  return app;
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { startServer };
