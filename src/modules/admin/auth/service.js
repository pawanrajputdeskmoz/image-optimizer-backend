const jwt = require("jsonwebtoken");
const Admin = require("../../../models/Admin");
const config = require("../../../config");
const { hashPassword, verifyPassword } = require("../../../utils/password");

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET;
}

function signAdminToken(admin) {
  const secret = getJwtSecret();
  if (!secret) {
    return { error: "JWT_SECRET is not configured", token: null };
  }

  const expiresIn = config.admin?.tokenExpiresIn || "24h";
  const token = jwt.sign(
    {
      type: "admin",
      adminId: String(admin._id),
      email: admin.email,
      name: admin.name || "Admin",
    },
    secret,
    { algorithm: "HS256", expiresIn }
  );

  return { error: null, token, expiresIn };
}

async function ensureBootstrapAdmin() {
  const count = await Admin.countDocuments({});
  if (count > 0) {
    return;
  }

  const email = config.admin?.email;
  const password = config.admin?.password;

  if (!email || !password) {
    return;
  }

  await Admin.create({
    email: String(email).trim().toLowerCase(),
    password_hash: hashPassword(password),
    name: config.admin?.name || "Admin",
    is_active: true,
  });
}

exports.loginAdmin = async ({ email, password }) => {
  if (!email || !password) {
    return { error: "Email and password are required", admin: null, token: null };
  }

  await ensureBootstrapAdmin();

  const normalizedEmail = String(email).trim().toLowerCase();
  const admin = await Admin.findOne({ email: normalizedEmail })
    .select("+password_hash")
    .lean();

  if (!admin || !admin.is_active) {
    return { error: "Invalid email or password", admin: null, token: null };
  }

  if (!verifyPassword(password, admin.password_hash)) {
    return { error: "Invalid email or password", admin: null, token: null };
  }

  await Admin.updateOne(
    { _id: admin._id },
    { $set: { last_login_at: new Date() } }
  );

  const { error, token, expiresIn } = signAdminToken(admin);
  if (error) {
    return { error, admin: null, token: null };
  }

  return {
    error: null,
    token,
    expiresIn,
    admin: {
      id: String(admin._id),
      email: admin.email,
      name: admin.name,
      last_login_at: new Date(),
    },
  };
};

exports.getAdminById = async (adminId) => {
  const admin = await Admin.findOne({ _id: adminId, is_active: true })
    .select({ email: 1, name: 1, is_active: 1, last_login_at: 1, created_at: 1 })
    .lean();

  if (!admin) {
    return { error: "Admin not found", admin: null };
  }

  return {
    error: null,
    admin: {
      id: String(admin._id),
      email: admin.email,
      name: admin.name,
      last_login_at: admin.last_login_at,
      created_at: admin.created_at,
    },
  };
};

exports.verifyAdminToken = (token) => {
  const secret = getJwtSecret();
  if (!secret) {
    return { error: "JWT_SECRET is not configured", payload: null };
  }

  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (payload?.type !== "admin" || !payload?.adminId) {
      return { error: "Invalid admin token", payload: null };
    }
    return { error: null, payload };
  } catch (err) {
    return {
      error: err?.name === "TokenExpiredError" ? "Token expired" : "Invalid token",
      payload: null,
    };
  }
};
