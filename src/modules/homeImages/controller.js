const { User } = require("../../models");
const { performance } = require("perf_hooks");
const { parseChannelId, resolveChannelSiteUrl } = require("../../utils/channelContext");
const { buildBigCommerceError } = require("../imageOptimization/services");
const { getHomeImagesService } = require("./services");

exports.getHomeImagesController = async (req, reply) => {
  const apiStart = performance.now();

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

    const user = await User.findOne(
      { store_hash: storeHash },
      { storeUrl: 1, access_token: 1, _id: 0 }
    ).lean();

    if (!user) {
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
      user.storeUrl || null
    );

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl could not be resolved for this channel",
      });
    }

    const bcStart = performance.now();
    const result = await getHomeImagesService({
      storeHash,
      accessToken,
      storeUrl,
      channelId,
    });
    
    const bcEnd = performance.now();

    console.log(
      `[BigCommerce API] home images ${(bcEnd - bcStart).toFixed(2)} ms`
    );

    const apiEnd = performance.now();
    console.log(
      `[getHomeImagesController] Total API Time: ${(apiEnd - apiStart).toFixed(2)} ms`
    );

    return reply.status(200).send(result);
  } catch (error) {
    console.error("[getHomeImagesController ERROR]", error);

    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};
