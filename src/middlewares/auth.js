const jwt = require("jsonwebtoken");
const { User } = require("../models");
const { parseChannelId } = require("../utils/channelContext");

async function authStore(req, reply) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader) {
      return reply.status(401).send({
        success: false,
        message: "Token not found",
      });
    }

    const [scheme, token] = String(authHeader).split(" ");
    if (scheme !== "Bearer" || !token) {
      return reply.status(401).send({
        success: false,
        message: "Token not found",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    const storeHash = decoded?.storeHash;
    const accessToken = decoded?.access_token;
    if (!storeHash || !accessToken) {
      return reply.status(401).send({
        success: false,
        message: "Token is not valid",
      });
    } 

    console.log("storeHash", storeHash);

    const user = await User.findOne({ store_hash: storeHash });
    if (!user) {
      return reply.status(401).send({
        success: false,
        message: "Not valid user",
      });
    }

    req.storeHash = storeHash;
    // Prefer DB token — JWT may embed a stale token from an older session.
    req.accessToken = user.access_token || accessToken;
    req.currentUser = user;
    req.channelId = parseChannelId({
      channel_id: req.query?.channel_id ?? req.body?.channel_id,
    });
  } catch (error) {
    return reply.status(401).send({
      success: false,
      message: "Token is not valid",
    });
  }
}

module.exports = { authStore };
