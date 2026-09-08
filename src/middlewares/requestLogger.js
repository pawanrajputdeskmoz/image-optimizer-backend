/**
 * Global Fastify request / response logger.
 * Writes structured blocks to logs/YYYY-MM-DD.log (+ api-YYYY-MM-DD.log).
 */

const {
  runWithRequestContext,
  newRequestId,
  logRequestStart,
  logRequestEnd,
  logBlock,
  sanitize,
} = require("../utils/fileLogger");

const SKIP_PATH_PREFIXES = ["/storage/"];
const MAX_RESPONSE_LOG_LEN = 4000;

function shouldSkip(url) {
  if (!url) return true;
  const pathOnly = String(url).split("?")[0];
  if (pathOnly === "/favicon.ico") return true;
  return SKIP_PATH_PREFIXES.some((p) => pathOnly.startsWith(p));
}

function pickBody(body) {
  if (body == null) return undefined;
  if (typeof body !== "object") return body;
  const clone = {};
  for (const [k, v] of Object.entries(body)) {
    if (
      v &&
      typeof v === "object" &&
      (v.type === "file" || Buffer.isBuffer(v?._buf) || Buffer.isBuffer(v))
    ) {
      clone[k] = "[file]";
    } else {
      clone[k] = v;
    }
  }
  return sanitize(clone);
}

function summarizeResponsePayload(payload) {
  if (payload == null) return undefined;
  if (typeof payload === "string") {
    return payload.length > MAX_RESPONSE_LOG_LEN
      ? `${payload.slice(0, MAX_RESPONSE_LOG_LEN)}…[truncated]`
      : payload;
  }
  if (Buffer.isBuffer(payload)) return `[Buffer ${payload.length} bytes]`;
  return sanitize(payload);
}

/**
 * Registers onRequest / preHandler / onSend / onResponse / onError hooks.
 * @param {import('fastify').FastifyInstance} app
 */
function registerRequestLogger(app) {
  app.addHook("onRequest", (request, _reply, done) => {
    if (shouldSkip(request.url)) {
      done();
      return;
    }

    const requestId = newRequestId();
    const startedAt = Date.now();
    const ctx = {
      requestId,
      startedAt,
      method: request.method,
      url: request.url,
    };

    runWithRequestContext(ctx, () => {
      request.requestId = requestId;
      request.logContext = ctx;

      logRequestStart({
        method: request.method,
        url: request.url,
        ip: request.ip,
        storeHash:
          request.query?.shop ||
          (typeof request.query?.context === "string"
            ? request.query.context.replace("stores/", "")
            : undefined) ||
          undefined,
        query: Object.keys(request.query || {}).length
          ? sanitize(request.query)
          : undefined,
        headers: {
          "content-type": request.headers["content-type"],
          "user-agent": request.headers["user-agent"],
          origin: request.headers.origin,
        },
      });

      done();
    });
  });

  app.addHook("preHandler", async (request) => {
    if (shouldSkip(request.url) || request.body == null) return;
    logBlock(
      "[REQUEST BODY]",
      {
        method: request.method,
        url: request.url,
        body: pickBody(request.body),
        requestId: request.requestId,
      },
      { category: "api" }
    );
  });

  // Capture payload we send back to the client
  app.addHook("onSend", async (request, reply, payload) => {
    if (shouldSkip(request.url)) return payload;

    let parsed = payload;
    if (typeof payload === "string") {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
    }

    if (request.logContext) {
      request.logContext.responseData = summarizeResponsePayload(parsed);
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    if (shouldSkip(request.url)) return;
    const startedAt = request.logContext?.startedAt || Date.now();
    logRequestEnd({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Date.now() - startedAt,
      requestId: request.requestId,
      responseData: request.logContext?.responseData,
    });
  });

  app.addHook("onError", async (request, _reply, error) => {
    if (shouldSkip(request.url)) return;
    logRequestEnd({
      method: request.method,
      url: request.url,
      error: error?.message,
      requestId: request.requestId,
    });
  });
}

module.exports = { registerRequestLogger };
