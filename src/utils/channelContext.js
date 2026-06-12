const { get } = require("./axiosUtils");
const config = require("../config");

function parseChannelId(source) {
  if (source == null || typeof source !== "object") {
    return null;
  }

  const raw = source.channel_id ?? source.channelId;
  const channelId = Number(raw);
  return Number.isFinite(channelId) && channelId > 0 ? channelId : null;
}

function normalizeImageFile(value) {
  if (value == null || value === "") return value;

  const str = String(value).trim();
  if (!/^https?:\/\//i.test(str)) return str;

  const match = str.match(/\/product_images\/(.+)$/i);
  return match ? match[1] : str;
}

async function resolveChannelSiteUrl(storeHash, channelId, accessToken, fallbackUrl = null) {
  if (!storeHash || !channelId || !accessToken) return fallbackUrl;

  try {
    const response = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/channels/${channelId}/site`,
      {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
      },
      { timeout: config.api.bigCommerceTimeoutMs }
    );

    return response?.data?.url || fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

module.exports = {
  parseChannelId,
  normalizeImageFile,
  resolveChannelSiteUrl,
};
