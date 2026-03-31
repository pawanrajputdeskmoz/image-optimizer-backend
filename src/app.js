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

const { imageOptimizationRoutes, installationRoutes } = require("./modules");
const { connectMongo } = require("./db/mongo");

async function buildApp() {

  const app = createFastifyInstance();
  await connectMongo();

  await app.register(multipartPlugin(), {
    attachFieldsToBody: true,
  });
  registerRequestLogging(app);

  await app.register(imageOptimizationRoutes, { prefix: "/api/image-optimizer" });
  await app.register(installationRoutes, { prefix: "/big-commerce" });

  return app;
}

function createFastifyInstance() {
  const create = fastifyModule.default ?? fastifyModule;
  return create({ logger: true });
}

function multipartPlugin() {
  return multipartModule.default ?? multipartModule;
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
