const { listImageStats } = require("./service");
const { sendSuccess } = require("../utils/response");

exports.listImageStats = async (req, reply) => {
  const {
    page,
    limit,
    store_hash: storeHash,
    source_type: sourceType,
    status,
    date_from: dateFrom,
    date_to: dateTo,
  } = req.query || {};

  const data = await listImageStats({
    storeHash,
    sourceType,
    status,
    dateFrom,
    dateTo,
    page,
    limit,
  });

  return sendSuccess(reply, {
    message: "Image optimization stats",
    data,
  });
};
