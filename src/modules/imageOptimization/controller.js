const { User } = require("../../models");
const { get } = require("../../utils/axiosUtils");
const { normalizePagination, buildBigCommerceError } = require("./services");

exports.optimizeImage = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = body.store_hash || req.query?.store_hash;

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }

    const { page, limit } = normalizePagination(req.query);
    const user = await User.findOne({ store_hash: storeHash });

    if (!user) {
      return reply.status(404).send({
        success: false,
        message: "Store is not installed. User not found for this store_hash",
      });
    }

    const accessToken = user.access_token;
    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const params = new URLSearchParams({
      include: "images",
      include_fields: "id,name,page_title,price,images",
      page: String(page),
      limit: String(limit),
    });

    const response = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${params.toString()}`,
      {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      }
    );

    return reply.status(200).send({
      success: true,
      message: "Products fetched successfully",
      data: response?.data || [],
      pagination: response?.meta?.pagination || null,
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};