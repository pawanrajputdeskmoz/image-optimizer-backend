const { loginAdmin, getAdminById } = require("./service");
const { sendSuccess, sendError } = require("../utils/response");

exports.login = async (req, reply) => {
  const { email, password } = req.body || {};
  const result = await loginAdmin({ email, password });

  if (result.error) {
    return sendError(reply, {
      message: result.error,
      statusCode: 401,
    });
  }

  return sendSuccess(reply, {
    message: "Admin login successful",
    data: {
      token: result.token,
      expires_in: result.expiresIn,
      token_type: "Bearer",
      admin: result.admin,
    },
  });
};

exports.me = async (req, reply) => {
  const result = await getAdminById(req.adminId);

  if (result.error) {
    return sendError(reply, { message: result.error, statusCode: 404 });
  }

  return sendSuccess(reply, {
    message: "Admin profile",
    data: { admin: result.admin },
  });
};
