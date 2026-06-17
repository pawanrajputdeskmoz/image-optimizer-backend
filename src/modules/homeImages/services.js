const axios = require("axios");
const { HomeBannerImage } = require("../../models");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const config = require("../../config");
const { getCapabilityBySource } = require("./v3Capabilities");
const { extractImagesFromHtml } = require("./utils/htmlImageExtractor");
const { extractImageUrlsFromObject } = require("./utils/widgetImagePathUtils");
const { scanHomepageHtml } = require("./utils/homepageHtmlScanner");

const BC_API_BASE = "https://api.bigcommerce.com/stores";

const SOURCE_NAME_BY_CONTEXT = {
  carousel: "Carousel Slide",
  marketing_banner: "Marketing Banner",
  storefront_html: "Storefront Homepage HTML",
};

// ─── BigCommerce client ───────────────────────────────────────────────────────

function createBigCommerceClient(storeHash, accessToken) {
  return axios.create({
    baseURL: `${BC_API_BASE}/${storeHash}`,
    timeout: 20000,
    headers: {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getErrorMessage(error) {
  return (
    error?.response?.data?.title ||
    error?.response?.data?.message ||
    error?.response?.data ||
    error?.message ||
    "Something went wrong"
  );
}

/**
 * Derive optimization status by comparing live URL against DB record.
 * Returns: "optimized" | "pending" | "failed" | "skipped"
 */
function getOptimizationStatus(liveUrl, dbRow) {
  if (!dbRow) return "pending";

  const live = String(liveUrl || "").split("?")[0].toLowerCase();
  const optimized = String(dbRow.optimized_url || "").split("?")[0].toLowerCase();

  if (
    dbRow.optimization_status === "optimized" &&
    (live === optimized || String(liveUrl).includes("/storage/optimized/bigcommerce/"))
  ) {
    return "optimized";
  }

  const original = String(dbRow.original_url || "").split("?")[0].toLowerCase();
  if (original && live !== original) return "pending";

  return dbRow.optimization_status || "pending";
}

/**
 * Merge a detected image item with its DB record and size info into a
 * single clean response object.
 */
function formatImage(item, dbRow, sizeInfo) {
  const optimizationStatus = getOptimizationStatus(item.original_url, dbRow);
  const isUpdateSupport = item.is_update_support;

  return {
    id: dbRow?._id || null,
    source_type: item.source_type,
    source_key: item.source_key,
    source_id: item.source_id,
    source_name: item.source_name,
    context: item.context,
    is_update_support: isUpdateSupport,
    is_update_supported: isUpdateSupport,
    update_mode: isUpdateSupport ? "auto_update" : "manual_detect_required",
    v3: item.v3,
    widget_uuid: item.widget_uuid,
    widget_name: item.widget_name,
    image_path: item.image_path,
    original_url: item.original_url,
    optimized_url: optimizationStatus === "optimized" ? (dbRow?.optimized_url || null) : null,

    // Step 1: optimization status from DB
    optimization_status: optimizationStatus,
    is_optimized: optimizationStatus === "optimized",

    // Step 2: image size info
    size: {
      bytes: sizeInfo?.bytes ?? null,
      kb: sizeInfo?.bytes ? Number((sizeInfo.bytes / 1024).toFixed(2)) : null,
      width: sizeInfo?.width ?? null,
      height: sizeInfo?.height ?? null,
      format: sizeInfo?.format ?? null,
    },
    original_size: dbRow?.original_size ?? sizeInfo?.bytes ?? null,
    optimized_size: dbRow?.optimized_size ?? null,
    saved_bytes: dbRow?.saved_bytes ?? 0,
    saved_percent: dbRow?.saved_percent ?? 0,
    last_optimized_at: dbRow?.last_optimized_at ?? null,
  };
}

/**
 * Deduplicate images by URL. Prefer update-supported sources over
 * storefront_html when the same URL appears in multiple sources.
 */
function removeDuplicateImages(images) {
  const map = new Map();

  for (const image of images) {
    if (!image?.original_url) continue;

    const key = image.original_url.split("?")[0].toLowerCase();
    const existing = map.get(key);

    if (!existing || (!existing.is_update_support && image.is_update_support)) {
      map.set(key, image);
    }
  }

  return Array.from(map.values());
}

function buildImageItem({
  sourceType,
  sourceId,
  sourceName,
  sourceKey,
  context,
  originalUrl,
  imagePath = null,
  widgetUuid = null,
  widgetName = null,
  placementUuid = null,
  region = null,
  templateFile = null,
}) {
  const isUpdateSupport =
    sourceType === "marketing_banner" ||
    sourceType === "widget" ||
    sourceType === "content_page";

  return {
    source_type: sourceType,
    source_key: sourceKey,
    source_id: sourceId,
    source_name: sourceName,
    context,
    original_url: originalUrl,
    is_update_support: isUpdateSupport,
    v3: getCapabilityBySource(sourceType, sourceId),
    widget_uuid: widgetUuid,
    widget_name: widgetName,
    image_path: imagePath,
    placement_uuid: placementUuid,
    region,
    template_file: templateFile,
  };
}

// ─── BigCommerce image fetchers ───────────────────────────────────────────────

async function fetchMarketingBannerImages(client, storeUrl) {
  const result = [];

  try {
    const response = await client.get("/v2/banners", {
      params: { page: "home_page", limit: 250 },
    });

    const banners = Array.isArray(response.data) ? response.data : [];

    for (const banner of banners) {
      const images = extractImagesFromHtml(banner.content || "", storeUrl);

      for (const image of images) {
        result.push(
          buildImageItem({
            sourceType: "marketing_banner",
            sourceId: String(banner.id),
            sourceName: banner.name || null,
            sourceKey: `marketing_banner::${banner.id}::${image.url}`,
            context: "marketing_banner",
            originalUrl: image.url,
            imagePath: image.image_path || "content",
          })
        );
      }
    }
  } catch (error) {
    result.push({ source_type: "marketing_banner", error: true, message: getErrorMessage(error) });
  }

  return result;
}

async function fetchWidgetImages(client, channelId) {
  const result = [];

  try {
    const params = { template_file: "pages/home", limit: 250 };
    if (channelId) params.channel_id = channelId;

    const placementsResponse = await client.get("/v3/content/placements", { params });
    const placements = placementsResponse.data?.data || [];

    for (const placement of placements) {
      const widgetUuid = placement.widget_uuid;
      if (!widgetUuid) continue;

      try {
        const widgetResponse = await client.get(`/v3/content/widgets/${widgetUuid}`);
        const widget = widgetResponse.data?.data || widgetResponse.data;
        const images = extractImageUrlsFromObject(widget?.widget_configuration || {});

        for (const image of images) {
          result.push(
            buildImageItem({
              sourceType: "widget",
              sourceId: widgetUuid,
              sourceName: widget?.name || placement.region || "Page Builder Widget",
              sourceKey: `widget::${widgetUuid}::${image.path}`,
              context: placement.region || "page_builder_home",
              originalUrl: image.url,
              imagePath: image.path || null,
              widgetUuid,
              widgetName: widget?.name || null,
              placementUuid: placement.uuid || null,
              region: placement.region || null,
              templateFile: placement.template_file || null,
            })
          );
        }
      } catch (widgetError) {
        result.push({ source_type: "widget", source_id: widgetUuid, error: true, message: getErrorMessage(widgetError) });
      }
    }
  } catch (error) {
    result.push({ source_type: "widget", error: true, message: getErrorMessage(error) });
  }

  return result;
}

async function fetchContentPageImages(client, channelId) {
  const result = [];

  try {
    const response = await client.get("/v3/content/pages", {
      params: { channel_id: channelId, limit: 50 },
    });

    const pages = response.data?.data || [];

    for (const page of pages) {
      if (page.is_homepage !== true) continue;

      const pageImages = [
        ...extractImagesFromHtml(page.body || "").map((img, index) => ({
          path: img.image_path || `body.image[${index}]`,
          url: img.url,
        })),
        ...extractImageUrlsFromObject(page),
      ];

      for (const image of pageImages) {
        result.push(
          buildImageItem({
            sourceType: "content_page",
            sourceId: String(page.id),
            sourceName: page.name || `Content Page #${page.id}`,
            sourceKey: `content_page::${page.id}::${image.path}`,
            context: "content_page",
            originalUrl: image.url,
            imagePath: image.path || null,
          })
        );
      }
    }
  } catch (error) {
    result.push({ source_type: "content_page", error: true, message: getErrorMessage(error) });
  }

  return result;
}

async function fetchStorefrontHtmlImages(storeUrl) {
  const result = [];

  try {
    const scan = await scanHomepageHtml(storeUrl);

    if (!scan.success) {
      result.push({ source_type: "storefront_html", error: true, message: scan.error || "Failed to scan homepage HTML." });
      return result;
    }

    for (const image of scan.images) {
      const htmlContext = image.context || "storefront_html";

      result.push(
        buildImageItem({
          sourceType: "storefront_html",
          sourceId: storeUrl,
          sourceName: SOURCE_NAME_BY_CONTEXT[htmlContext] || "Storefront Homepage HTML",
          sourceKey: `storefront_html::${storeUrl}::${image.url}`,
          context: htmlContext,
          originalUrl: image.url,
          imagePath: image.image_path || null,
        })
      );
    }
  } catch (error) {
    result.push({ source_type: "storefront_html", error: true, message: getErrorMessage(error) });
  }

  return result;
}

// ─── Main service ─────────────────────────────────────────────────────────────

async function getHomeImagesService({ storeHash, accessToken, storeUrl, channelId = null }) {
  if (!storeHash) throw new Error("storeHash is required");
  if (!accessToken) throw new Error("accessToken is required");
  if (!storeUrl) throw new Error("storeUrl is required");

  const client = createBigCommerceClient(storeHash, accessToken);

  // Step 1: Fetch all home images from BigCommerce
  const [marketingBanners, widgetImages, contentPageImages, storefrontImages] =
    await Promise.all([
      fetchMarketingBannerImages(client, storeUrl),
      fetchWidgetImages(client, channelId),
      channelId ? fetchContentPageImages(client, channelId) : Promise.resolve([]),
      fetchStorefrontHtmlImages(storeUrl),
    ]);


    console.log("marketingBanners", JSON.stringify(marketingBanners, null, 2));
    console.log("widgetImages", widgetImages.length);
    console.log("contentPageImages", contentPageImages.length);
    console.log("storefrontImages", storefrontImages.length);
  const allItems = [...marketingBanners, ...widgetImages, ...contentPageImages, ...storefrontImages];

  const errors = allItems.filter((item) => item.error);
  const images = removeDuplicateImages(allItems.filter((item) => !item.error));

  if (images.length === 0) {
    return {
      success: true,
      message: "No homepage images found.",
      count: 0,
      sources: { widget: 0, marketing_banner: 0, content_page: 0, storefront_html: 0 },
      errors,
      data: [],
    };
  }

  // Step 1: DB lookup — check optimization status for each image
  const dbRows = await HomeBannerImage.find({
    store_hash: storeHash,
    channel_id: channelId,
    source_key: { $in: images.map((img) => img.source_key) },
  }).lean();

  const dbByKey = Object.fromEntries(dbRows.map((row) => [row.source_key, row]));

  // Step 2: Fetch real file sizes for each image
  const sizeByKey = await getImageSizesFromUrls(
    images.map((img) => ({ imageId: img.source_key, url: img.original_url })),
    { concurrency: config.image.sizeFetchConcurrency }
  );

  // Merge: detected item + DB record + size info
  const data = images.map((item) =>
    formatImage(item, dbByKey[item.source_key] || null, sizeByKey[item.source_key])
  );

  return {
    success: true,
    message: "Homepage images fetched from BigCommerce.",
    count: data.length,
    sources: {
      widget: data.filter((item) => item.source_type === "widget").length,
      marketing_banner: data.filter((item) => item.source_type === "marketing_banner").length,
      content_page: data.filter((item) => item.source_type === "content_page").length,
      storefront_html: data.filter((item) => item.source_type === "storefront_html").length,
    },
    optimized_count: data.filter((item) => item.is_optimized).length,
    pending_count: data.filter((item) => !item.is_optimized).length,
    errors,
    data,
  };
}

module.exports = { getHomeImagesService };
