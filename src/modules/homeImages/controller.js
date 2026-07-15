const { parseChannelId, resolveChannelSiteUrl } = require("../../utils/channelContext");
const { buildBigCommerceError } = require("../imageOptimization/services");
const { getHomeImagesService } = require("./services");

exports.getHomeImagesController = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const channelId = parseChannelId(body);

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }

    if (!channelId) {
      return reply.status(400).send({
        success: false,
        message: "channel_id is required and must be a positive number",
      });
    }

    if (!req.currentUser) {
      return reply.status(404).send({
        success: false,
        message: "Store is not installed",
      });
    }

    const accessToken = req.accessToken || req.currentUser?.access_token || null;

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "Access token missing",
      });
    }

    const storeUrl = await resolveChannelSiteUrl(
      storeHash,
      channelId,
      accessToken,
      req.currentUser.storeUrl || null
    );

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl could not be resolved for this channel",
      });
    }

    const result = await getHomeImagesService({
      storeHash,
      accessToken,
      storeUrl,
      channelId,
    });

    return reply.status(200).send(result);
  } catch (error) {
    console.error("[getHomeImagesController ERROR]", error);

    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};
