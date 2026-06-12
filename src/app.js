const fastifyModule = require("fastify");
const multipartModule = require("@fastify/multipart");
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("dotenv");

const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, ".env")].find((p) =>
  fs.existsSync(p)
);
if (envPath) {
  config({ path: envPath });
} else {  
  config();
}

const {
  imageOptimizationRoutes,
  homeImagesRoutes,
  categoryImagesRoutes,
  installationRoutes,
  settingRoutes,
} = require("./modules");
const { connectMongo } = require("./db/mongo");

async function buildApp() {

  const app = createFastifyInstance();
  await connectMongo();

  registerValidationErrorHandler(app);
  registerCors(app);
  await app.register(multipartPlugin(), {
    attachFieldsToBody: true,
  });
  registerStorageFiles(app);

  await app.register(imageOptimizationRoutes, { prefix: "/api/image-optimizer" });
  await app.register(homeImagesRoutes, { prefix: "/api/image-optimizer" });
  await app.register(categoryImagesRoutes, { prefix: "/api/category-images" });
  await app.register(settingRoutes, { prefix: "/api/settings" });
  await app.register(installationRoutes, { prefix: "/store" });

  return app;
}

function createFastifyInstance() {
  const create = fastifyModule.default ?? fastifyModule;
  return create({
    logger: true,
    ajv: {
      customOptions: {
        coerceTypes: true,
        allErrors: true,
        removeAdditional: "all",
        allowUnionTypes: true,
      },
    },
  });
}

function registerValidationErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      const errors = error.validation.map((e) => {
        const field = (e.instancePath || "").replace(/^\//, "") ||
          e.params?.missingProperty ||
          "body";
        return { field, message: e.message };
      });

      return reply.status(400).send({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    request.log.error(error);
    return reply
      .status(error.statusCode || 500)
      .send({ success: false, message: error.message || "Internal server error" });
  });
}

function multipartPlugin() {
  return multipartModule.default ?? multipartModule;
}

function registerCors(app) {
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const applyCorsHeaders = (request, reply) => {
    const origin = request.headers.origin ?? request.headers.Origin;
    if (!origin) return false;

    const allowAll = allowedOrigins.length === 0;
    const isAllowed =
      allowAll ||
      allowedOrigins.includes(origin) ||
      (origin.endsWith(".shares.zrok.io") && allowedOrigins.includes("*.shares.zrok.io"));

    if (!isAllowed) return false;

    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "origin");
    reply.header("access-control-allow-credentials", "true");
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    // If the browser asks to use specific headers, reflect them back.
    // This is required for custom headers like `api-token`, `app-key`, etc.
    const requestedHeaders = request.headers["access-control-request-headers"];
    reply.header(
      "access-control-allow-headers",
      requestedHeaders ||
        "authorization,content-type,accept,origin,x-requested-with,api-token,app-activant,app-key"
    );

    return true;
  };

  // Ensure preflight never falls through to "Route OPTIONS:* not found".
  app.options("/*", async (request, reply) => {
    applyCorsHeaders(request, reply);
    reply.code(204).send();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!applyCorsHeaders(request, reply)) return;
  });
}

function registerStorageFiles(app) {
  const storageRoot = path.resolve(process.cwd(), "storage");

  app.get("/storage/*", async (request, reply) => {
    const wildcard = request.params["*"];
    if (!wildcard) {
      return reply.status(404).send({ success: false, message: "Not found" });
    }

    const rel = path
      .normalize(String(wildcard).replace(/\\/g, "/"))
      .replace(/^(\.\.(\/|\\|$))+/, "");

    const filePath = path.resolve(storageRoot, rel);
    if (
      filePath !== storageRoot &&
      !filePath.startsWith(`${storageRoot}${path.sep}`)
    ) {
      return reply.status(403).send({ success: false, message: "Forbidden" });
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return reply.status(404).send({ success: false, message: "Not found" });
    }

    return reply.send(fs.createReadStream(filePath));
  });
}
module.exports = { buildApp };
