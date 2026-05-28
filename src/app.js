const fastifyModule = require("fastify");
const multipartModule = require("@fastify/multipart");
const fs = require("node:fs");
const path = require("node:path");
const { STATUS_CODES } = require("node:http");
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
  installationRoutes,
  queueRoutes,
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
  registerRequestLogging(app);
  registerStorageFiles(app);

  await app.register(imageOptimizationRoutes, { prefix: "/api/image-optimizer" });
  await app.register(settingRoutes, { prefix: "/api/settings" });
  await app.register(installationRoutes, { prefix: "/store" });

  // Enqueue jobs without a prefix (exact route: POST /add-job)
  await app.register(queueRoutes);

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

function registerRequestLogging(app) {
  app.addHook("onRequest", async (request) => {
    request._requestStartNs = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startNs = request._requestStartNs ?? process.hrtime.bigint();
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const chalk = await getChalk();

    const getStatusColor = (status) => {
      if (status >= 500) return chalk.red;
      if (status >= 400) return chalk.yellow;
      if (status >= 300) return chalk.cyan;
      return chalk.green;
    };

    const statusColor = getStatusColor(reply.statusCode);
    const reasonText = reply.raw?.statusMessage || STATUS_CODES[reply.statusCode] || "Unknown";
    const maxWidth = 100;
    const divider = "─".repeat(22);

    const baseLines = [
      chalk.bold.blue("API Request Log"),
      chalk.gray(divider),
      `${chalk.white("Method")} : ${chalk.yellow(request.method)}`,
      `${chalk.white("Path  ")} : ${chalk.green(request.url)}`,
      `${chalk.white("Status")} : ${statusColor(String(reply.statusCode))}`,
      `${chalk.white("Reason")} : ${statusColor(reasonText)}`,
      `${chalk.white("Time  ")} : ${chalk.magenta(`${elapsedMs.toFixed(2)} ms`)}`,
    ];

    const lines = baseLines.flatMap((line) => wrapAnsiLine(line, maxWidth));
    const contentWidth = Math.min(
      maxWidth,
      Math.max(20, ...lines.map((line) => visibleLength(line)))
    );
    const horizontal = "─".repeat(contentWidth + 2);

    const box = [
      chalk.blue(`┌${horizontal}┐`),
      ...lines.map((line) => {
        const padding = " ".repeat(contentWidth - visibleLength(line));
        return `${chalk.blue("│")} ${line}${padding} ${chalk.blue("│")}`;
      }),
      chalk.blue(`└${horizontal}┘`),
    ].join("\n");

    console.log(box);
  });
}



// API logger config 
let chalkInstance = null;
let chalkPromise = null;

async function getChalk() {
  if (chalkInstance) return chalkInstance;
  if (!chalkPromise) {
    chalkPromise = import("chalk")
      .then((mod) => mod.default ?? mod)
      .catch(() => null);
  }

  const loaded = await chalkPromise;
  chalkInstance = loaded ?? createNoColorChalk();
  return chalkInstance;
}

function createNoColorChalk() {
  const id = (text) => String(text);
  return {
    red: id,
    yellow: id,
    cyan: id,
    green: id,
    gray: id,
    white: id,
    magenta: id,
    blue: id,
    bold: { blue: id },
  };
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

function stripAnsi(str) {
  return String(str).replace(/\x1B\[[0-9;]*m/g, "");
}

function wrapAnsiLine(line, maxWidth) {
  const raw = String(line);
  if (visibleLength(raw) <= maxWidth) return [raw];

  const openCodes = raw.match(/^\x1B\[[0-9;]*m/g)?.join("") ?? "";
  const closeCode = "\x1B[0m";

  const plain = stripAnsi(raw);
  const chunks = [];
  let start = 0;
  while (start < plain.length) {
    chunks.push(plain.slice(start, start + maxWidth));
    start += maxWidth;
  }

  return chunks.map((chunk) => `${openCodes}${chunk}${closeCode}`);
}

module.exports = { buildApp };
