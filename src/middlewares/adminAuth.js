const config = require("../config");
const { verifyAdminToken } = require("../modules/admin/auth/service");

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) return null;

  const [scheme, token] = String(authHeader).split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

function extractApiKey(req) {
  return (
    req.headers["x-admin-key"] ||
    req.headers["X-Admin-Key"] ||
    req.headers["x-admin-api-key"] ||
    req.headers["X-Admin-Api-Key"] ||
    null
  );
}

/**
 * Protects admin routes.
 * Accepts: Authorization Bearer <admin-jwt> (preferred) or X-Admin-Key (legacy).
 */
async function authAdmin(req, reply) {
  const bearerToken = extractBearerToken(req);

  if (bearerToken) {
    const { error, payload } = verifyAdminToken(bearerToken);
    if (error) {
      return reply.status(401).send({
        success: false,
        message: error,
      });
    }

    req.adminId = payload.adminId;
    req.adminEmail = payload.email;
    req.adminName = payload.name;
    req.adminAuthType = "jwt";
    return;
  }

  const configuredKey = config.admin?.apiKey;
  const headerKey = extractApiKey(req);

  if (configuredKey && headerKey && String(headerKey) === String(configuredKey)) {
    req.adminAuthType = "api_key";
    return;
  }

  if (!configuredKey && !getJwtSecretConfigured()) {
    return reply.status(503).send({
      success: false,
      message:
        "Admin auth is not configured. Set JWT_SECRET + ADMIN_EMAIL/ADMIN_PASSWORD or ADMIN_API_KEY.",
    });
  }

  return reply.status(401).send({
    success: false,
    message: "Unauthorized. Login with admin credentials or provide a valid token.",
  });
}

function getJwtSecretConfigured() {
  return Boolean(process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
}

module.exports = { authAdmin };
