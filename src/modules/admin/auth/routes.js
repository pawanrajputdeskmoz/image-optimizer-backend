const { login, me } = require("./controller");
const { loginSchema, meSchema } = require("./schemas");
const { authAdmin } = require("../../../middlewares/adminAuth");

async function authRoutes(app) {
  app.post("/login", { schema: loginSchema }, login);
  app.get("/me", { preHandler: authAdmin, schema: meSchema }, me);
}

module.exports = { authRoutes };
