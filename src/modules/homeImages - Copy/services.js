const crypto = require("crypto");
const axiosUtils = require("../../utils/axiosUtils");
const config = require("../../config");
const { HomeBannerImage } = require("../../models");
const HomeImageJob = require("../../models/HomeImageJob");
const { resolveChannelSiteUrl } = require("../../utils/channelContext");
const {
  extractImageUrlsFromObject,
  replaceNestedValueByPath,
  isValidImageUrl,
} = require("./utils/widgetImagePathUtils");
const { extractImagesFromHtml } = require("./utils/htmlImageExtractor");
const { scanHomepageHtml } = require("./utils/homepageHtmlScanner");
const {
  downloadImageBuffer,
  optimizeImageBuffer,
  uploadOptimizedBuffer,
  resolvePublicBaseUrl,
} = require("./utils/uploadPublicImage");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const {
  HOME_V3_UPDATABLE_SOURCES,
  HOME_V2_UPDATABLE_SOURCES,
  HOME_NON_V3_SOURCES,
  buildV3MetaForImage,
} = require("./v3Capabilities");
const { normalizeJobType } = require("../../models/constants");

// ─── BC API helpers ───────────────────────────────────────────────────────────

function bcHeaders(accessToken) {
  return {
    "X-Auth-Token": accessToken,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function bcUrl(storeHash, path) {
  return `https://api.bigcommerce.com/stores/${storeHash}${path}`;
}

// ─── Key & status helpers ─────────────────────────────────────────────────────

function buildSourceKey(sourceType, ...parts) {
  return `${sourceType}::${parts.filter(Boolean).join("::")}`;
}

function getOptimizationStatus(liveUrl, dbRow) {
  if (!dbRow) return "pending";

  const live = String(liveUrl || "").split("?")[0].toLowerCase();
  const original = String(dbRow.original_url || "").split("?")[0].toLowerCase();
  const optimized = String(dbRow.optimized_url || "").split("?")[0].toLowerCase();

  if (
    dbRow.optimization_status === "optimized" &&
    (live === optimized || String(liveUrl).includes("/storage/optimized/bigcommerce/"))
  ) {
    return "optimized";
  }

  if (original && live !== original) return "pending";
  return dbRow.optimization_status || "pending";
}

function getUpdateMode(sourceType) {
  if (sourceType === "storefront_html") return "optimize_only";
  if (["widget", "content_page", "marketing_banner"].includes(sourceType)) {
    return "auto_update";
  }
  return "unsupported";
}

function parseIdFromSourceKey(sourceType, key) {
  const parts = String(key || "").split("::");
  if (parts[0] !== sourceType || !parts[1]) return null;
  return parts[1];
}

function validateFrontendKeys(sourceType, key) {
  if (!sourceType || !key) {
    return "source_type and source_key are required.";
  }
  if (!key.startsWith(`${sourceType}::`)) {
    return `source_key must start with "${sourceType}::".`;
  }
  return null;
}

function mergeWithFrontendItem(liveItem, frontend = {}) {
  const sourceId =
    liveItem.source_id ||
    frontend.source_id ||
    parseIdFromSourceKey(liveItem.source_type, liveItem.source_key);

  return {
    ...liveItem,
    source_id: sourceId,
    source_name: liveItem.source_name || frontend.source_name || null,
    image_path: liveItem.image_path || frontend.image_path || null,
    widget_uuid: liveItem.widget_uuid || frontend.widget_uuid || null,
    widget_name: liveItem.widget_name || frontend.widget_name || null,
    is_update_supported:
      frontend.is_update_supported ?? liveItem.is_update_supported,
    metadata: {
      ...(liveItem.metadata || {}),
      ...(frontend.metadata || {}),
    },
  };
}

function formatImage(item, dbRow, sizeInfo) {
  const status = getOptimizationStatus(item.original_url, dbRow);
  const updateMode = getUpdateMode(item.source_type);
  const v3 = buildV3MetaForImage(item);

  return {
    id: dbRow?._id || null,
    source_type: item.source_type,
    source_key: item.source_key,
    source_id: item.source_id,
    source_name: item.source_name,
    context: item.context,
    is_update_supported: item.is_update_supported,
    update_mode: updateMode,
    v3,
    widget_uuid: item.widget_uuid,
    widget_name: item.widget_name,
    image_path: item.image_path,
    original_url: item.original_url,
    current_url: item.original_url,
    optimized_url: status === "optimized" ? dbRow?.optimized_url || null : null,
    size: {
      bytes: sizeInfo?.bytes ?? null,
      width: sizeInfo?.width ?? null,
      height: sizeInfo?.height ?? null,
      format: sizeInfo?.format ?? null,
    },
    original_size: dbRow?.original_size ?? sizeInfo?.bytes ?? null,
    optimized_size: dbRow?.optimized_size ?? null,
    saved_bytes: dbRow?.saved_bytes ?? 0,
    saved_percent: dbRow?.saved_percent ?? 0,
    output_format: dbRow?.output_format ?? sizeInfo?.format ?? null,
    optimization_status: status,
    error_message: dbRow?.error_message ?? null,
    metadata: item.metadata || dbRow?.metadata || null,
    last_optimized_at: dbRow?.last_optimized_at ?? null,
  };
}

function replaceUrlInHtml(html, originalUrl, newUrl) {
  const content = String(html || "");
  if (content.includes(originalUrl)) {
    return content.split(originalUrl).join(newUrl);
  }
  const base = originalUrl.split("?")[0];
  return content.split(base).join(newUrl);
}

// ─── BC v2 Banner helpers ─────────────────────────────────────────────────────

/**
 * Fetch all marketing banners from BigCommerce v2 API.
 * Filters to home_page banners by default.
 */
async function fetchV2Banners(storeHash, accessToken, { page: pageFilter = null } = {}) {
  const headers = bcHeaders(accessToken);
  const params = { limit: 250, page: 1 };

  const banners = await axiosUtils.get(
    bcUrl(storeHash, "/v2/banners"),
    headers,
    { params, timeout: config.api.bigCommerceTimeoutMs }
  );

  const list = Array.isArray(banners) ? banners : [];

  if (!pageFilter) return list;
  return list.filter((b) => b.page === pageFilter);
}

/**
 * Fetch a single v2 banner by ID.
 */
async function fetchV2BannerById(storeHash, accessToken, bannerId) {
  const headers = bcHeaders(accessToken);
  const banner = await axiosUtils.get(
    bcUrl(storeHash, `/v2/banners/${bannerId}`),
    headers,
    { timeout: config.api.bigCommerceTimeoutMs }
  );
  return banner || null;
}

/**
 * Update a v2 marketing banner's content HTML.
 */
async function updateV2Banner(storeHash, accessToken, bannerId, { name, content, location, page, status }) {
  const headers = bcHeaders(accessToken);
  const payload = {};
  if (name != null) payload.name = name;
  if (content != null) payload.content = content;
  if (location != null) payload.location = location;
  if (page != null) payload.page = page;
  if (status != null) payload.status = status;

  return axiosUtils.put(
    bcUrl(storeHash, `/v2/banners/${bannerId}`),
    payload,
    { headers, timeout: config.api.bigCommerceTimeoutMs }
  );
}

// ─── Image detection ──────────────────────────────────────────────────────────

async function detectHomepageImages(storeHash, accessToken, channelId, storeUrl, { skipHtmlScan = false } = {}) {
  const images = [];
  const errors = [];
  const headers = bcHeaders(accessToken);
  const timeout = { timeout: config.api.bigCommerceTimeoutMs };

  // v3 widgets on pages/home
  try {
    const placementsRes = await axiosUtils.get(
      bcUrl(storeHash, "/v3/content/placements"),
      headers,
      { params: { channel_id: channelId, template_file: "pages/home" }, ...timeout }
    );

    for (const placement of placementsRes?.data || []) {
      if (!placement.widget_uuid) continue;

      const widgetRes = await axiosUtils.get(
        bcUrl(storeHash, `/v3/content/widgets/${placement.widget_uuid}`),
        headers,
        timeout
      );
      const widget = widgetRes?.data;
      if (!widget) continue;

      for (const image of extractImageUrlsFromObject(widget.widget_configuration || {})) {
        images.push({
          source_type: "widget",
          source_key: buildSourceKey("widget", widget.uuid || placement.widget_uuid, image.path),
          source_id: String(widget.uuid || placement.widget_uuid),
          source_name: widget.name || placement.region || "Page Builder Widget",
          widget_uuid: widget.uuid || placement.widget_uuid,
          widget_name: widget.name || null,
          image_path: image.path,
          original_url: image.url,
          context: placement.region || "page_builder",
          is_update_supported: true,
          metadata: { region: placement.region || null },
        });
      }
    }
  } catch (error) {
    errors.push({ source: "widget", message: error.message });
  }

  // v3 homepage content pages
  try {
    const pagesRes = await axiosUtils.get(
      bcUrl(storeHash, "/v3/content/pages"),
      headers,
      { params: { channel_id: channelId, limit: 50 }, ...timeout }
    );

    for (const page of pagesRes?.data || []) {
      if (page.is_homepage !== true) continue;

      const pageImages = [
        ...extractImagesFromHtml(page.body || "").map((img, index) => ({
          path: img.image_path || `body.image[${index}]`,
          url: img.url,
        })),
        ...extractImageUrlsFromObject(page),
      ];

      for (const image of pageImages) {
        images.push({
          source_type: "content_page",
          source_key: buildSourceKey("content_page", page.id, image.path),
          source_id: String(page.id),
          source_name: page.name || `Content Page #${page.id}`,
          widget_uuid: null,
          widget_name: null,
          image_path: image.path,
          original_url: image.url,
          context: "content_page",
          is_update_supported: true,
          metadata: { page_id: page.id },
        });
      }
    }
  } catch (error) {
    errors.push({ source: "content_page", message: error.message });
  }

  // v2 marketing banners (home_page)
  try {
    const banners = await fetchV2Banners(storeHash, accessToken, { page: "home_page" });

    for (const banner of banners) {
      const bannerImages = extractImagesFromHtml(banner.content || "");

      for (const img of bannerImages) {
        images.push({
          source_type: "marketing_banner",
          source_key: buildSourceKey(
            "marketing_banner",
            String(banner.id),
            crypto.createHash("sha1").update(img.url).digest("hex").slice(0, 10)
          ),
          source_id: String(banner.id),
          source_name: banner.name || `Banner #${banner.id}`,
          widget_uuid: null,
          widget_name: null,
          image_path: img.image_path || "content",
          original_url: img.url,
          context: "marketing_banner",
          is_update_supported: true,
          metadata: {
            banner_id: banner.id,
            banner_name: banner.name,
            location: banner.location,
            page: banner.page,
          },
        });
      }
    }
  } catch (error) {
    errors.push({ source: "marketing_banner", message: error.message });
  }

  // Storefront HTML scan (optional — skip in worker context)
  if (!skipHtmlScan) {
    try {
      const homepageUrl = await resolveChannelSiteUrl(
        storeHash,
        channelId,
        accessToken,
        storeUrl
      );

      if (homepageUrl) {
        const scan = await scanHomepageHtml(homepageUrl);
        if (scan.success) {
          for (const image of scan.images) {
            const htmlContext = image.context || "storefront_html";
            const sourceNameByContext = {
              carousel: "Carousel Slide",
              marketing_banner: "Marketing Banner",
              storefront_html: "Storefront Homepage HTML",
            };

            images.push({
              source_type: "storefront_html",
              source_key: buildSourceKey(
                "storefront_html",
                crypto.createHash("sha1").update(image.url).digest("hex").slice(0, 12),
                image.image_path
              ),
              source_id: homepageUrl,
              source_name: sourceNameByContext[htmlContext] || "Storefront Homepage HTML",
              widget_uuid: null,
              widget_name: null,
              image_path: image.image_path,
              original_url: image.url,
              context: htmlContext,
              is_update_supported: false,
              metadata: { homepage_url: homepageUrl, html_context: htmlContext },
            });
          }
        }
      }
    } catch (error) {
      errors.push({ source: "storefront_html", message: error.message });
    }
  }

  // Deduplicate by URL — prefer update-supported source
  const uniqueByUrl = new Map();
  for (const item of images) {
    const urlKey = String(item.original_url || "").split("?")[0].toLowerCase();
    if (!urlKey) continue;

    const existing = uniqueByUrl.get(urlKey);
    if (!existing || (!existing.is_update_supported && item.is_update_supported)) {
      uniqueByUrl.set(urlKey, item);
    }
  }

  return { images: Array.from(uniqueByUrl.values()), errors };
}

// ─── DB persistence ───────────────────────────────────────────────────────────

async function saveHomeImage(fields) {
  const savedPercent =
    fields.originalSize > 0 && fields.savedBytes > 0
      ? Number(((fields.savedBytes / fields.originalSize) * 100).toFixed(2))
      : 0;

  return HomeBannerImage.findOneAndUpdate(
    {
      store_hash: fields.storeHash,
      channel_id: fields.channelId,
      source_type: fields.sourceType,
      source_key: fields.sourceKey,
    },
    {
      $set: {
        source_id: fields.sourceId,
        source_name: fields.sourceName,
        context: fields.context,
        is_update_supported: fields.isUpdateSupported,
        widget_uuid: fields.widgetUuid || null,
        widget_name: fields.widgetName || null,
        image_path_in_config: fields.imagePath,
        original_url: fields.originalUrl,
        current_url: fields.optimizedUrl || fields.originalUrl,
        optimized_url: fields.optimizedUrl || null,
        original_size: fields.originalSize ?? null,
        optimized_size: fields.optimizedSize ?? null,
        saved_bytes: fields.savedBytes ?? 0,
        saved_percent: savedPercent,
        output_format: fields.outputFormat ?? null,
        optimization_status: fields.optimizationStatus,
        error_message: fields.errorMessage ?? null,
        metadata: fields.metadata ?? null,
        last_optimized_at: fields.optimizationStatus === "optimized" ? new Date() : null,
      },
    },
    { upsert: true, new: true }
  );
}

// ─── BigCommerce source update ────────────────────────────────────────────────

async function updateBigCommerceSource(storeHash, accessToken, channelId, item, newUrl) {
  const headers = bcHeaders(accessToken);
  const apiTimeout = config.api.bigCommerceTimeoutMs;

  // v3 Page Builder widget
  if (item.source_type === "widget") {
    const widgetRes = await axiosUtils.get(
      bcUrl(storeHash, `/v3/content/widgets/${item.widget_uuid}`),
      headers,
      { timeout: apiTimeout }
    );
    const widget = widgetRes?.data;
    if (!widget) throw new Error("Widget not found.");

    const updatedConfig = replaceNestedValueByPath(
      widget.widget_configuration || {},
      item.image_path,
      newUrl
    );

    await axiosUtils.put(
      bcUrl(storeHash, `/v3/content/widgets/${item.widget_uuid}`),
      {
        name: widget.name,
        widget_template_uuid: widget.widget_template_uuid,
        widget_configuration: updatedConfig,
      },
      { headers, timeout: apiTimeout }
    );
    return;
  }

  // v3 content page
  if (item.source_type === "content_page") {
    const pageRes = await axiosUtils.get(
      bcUrl(storeHash, `/v3/content/pages/${item.source_id}`),
      headers,
      { params: { channel_id: channelId }, timeout: apiTimeout }
    );
    const page = pageRes?.data;
    if (!page) throw new Error("Content page not found.");

    if (String(item.image_path || "").startsWith("body.")) {
      await axiosUtils.put(
        bcUrl(storeHash, `/v3/content/pages/${item.source_id}`),
        {
          ...page,
          body: replaceUrlInHtml(page.body, item.original_url, newUrl),
        },
        { headers, timeout: apiTimeout }
      );
      return;
    }

    await axiosUtils.put(
      bcUrl(storeHash, `/v3/content/pages/${item.source_id}`),
      replaceNestedValueByPath(page, item.image_path, newUrl),
      { headers, timeout: apiTimeout }
    );
    return;
  }

  // v2 marketing banner
  if (item.source_type === "marketing_banner") {
    const bannerId = item.source_id || parseIdFromSourceKey("marketing_banner", item.source_key);
    if (!bannerId) throw new Error("Banner ID could not be resolved from source_key.");

    const banner = await fetchV2BannerById(storeHash, accessToken, bannerId);
    if (!banner) throw new Error(`Marketing banner #${bannerId} not found.`);

    const updatedContent = replaceUrlInHtml(banner.content || "", item.original_url, newUrl);

    await updateV2Banner(storeHash, accessToken, bannerId, {
      name: banner.name,
      content: updatedContent,
      location: banner.location,
      page: banner.page,
      status: banner.status,
    });
    return;
  }
}

// ─── Public service: fetch home images ───────────────────────────────────────

exports.fetchHomeImages = async (
  storeHash,
  accessToken,
  channelId = 1,
  storeUrl = null
) => {
  const { images, errors } = await detectHomepageImages(
    storeHash,
    accessToken,
    channelId,
    storeUrl
  );

  const dbRows = await HomeBannerImage.find({
    store_hash: storeHash,
    channel_id: channelId,
  }).lean();

  const dbByKey = Object.fromEntries(
    dbRows.map((row) => [row.source_key, row])
  );

  const sizeByKey = images.length
    ? await getImageSizesFromUrls(
        images.map((item) => ({
          imageId: item.source_key,
          url: item.original_url,
        })),
        { concurrency: config.image.sizeFetchConcurrency }
      )
    : {};

  const data = images.map((item) =>
    formatImage(item, dbByKey[item.source_key] || null, sizeByKey[item.source_key])
  );

  const allCapabilities = [...HOME_V3_UPDATABLE_SOURCES, ...HOME_V2_UPDATABLE_SOURCES];
  const v3UpdatableCount = data.filter((row) => row.is_update_supported).length;

  return {
    count: data.length,
    data,
    sources: {
      widget: data.filter((row) => row.source_type === "widget").length,
      content_page: data.filter((row) => row.source_type === "content_page").length,
      marketing_banner: data.filter((row) => row.source_type === "marketing_banner").length,
      storefront_html: data.filter((row) => row.source_type === "storefront_html").length,
    },
    v3_capabilities: allCapabilities,
    non_v3_sources: HOME_NON_V3_SOURCES,
    summary: {
      v3_updatable_count: v3UpdatableCount,
      preview_only_count: data.length - v3UpdatableCount,
    },
    errors,
  };
};

// ─── Public service: optimize single ─────────────────────────────────────────

exports.optimizeHomeBannerImageSingle = async ({
  storeHash,
  accessToken,
  channelId = 1,
  recordId = null,
  sourceType = null,
  sourceKey = null,
  originalUrl = null,
  sourceId = null,
  imagePath = null,
  widgetUuid = null,
  isUpdateSupported = null,
  metadata = null,
  quality = config.storeDefaults.image_quality,
  maxWidth = config.image.optimizeMaxDimension,
  outputFormat = config.storeDefaults.output_format,
  force = false,
  optimizeOnly = false,
  storeUrl = null,
  skipHtmlScan = false,
}) => {
  let dbRow = null;
  let item = null;

  if (recordId) {
    dbRow = await HomeBannerImage.findOne({ _id: recordId, store_hash: storeHash }).lean();
    if (!dbRow) {
      return { success: false, status: 404, message: "Home image record not found." };
    }
    sourceType = dbRow.source_type;
    sourceKey = dbRow.source_key;
    originalUrl = originalUrl || dbRow.original_url;
  }

  const keyError = validateFrontendKeys(sourceType, sourceKey);
  if (keyError) {
    return { success: false, status: 400, message: keyError };
  }

  const { images } = await detectHomepageImages(storeHash, accessToken, channelId, storeUrl, { skipHtmlScan });
  const liveItem = images.find(
    (row) =>
      row.source_type === sourceType &&
      row.source_key === sourceKey &&
      (!originalUrl || row.original_url === originalUrl)
  );

  if (!liveItem) {
    return {
      success: false,
      status: 404,
      message: "Homepage image not found on BigCommerce.",
      data: { source_type: sourceType, source_key: sourceKey, original_url: originalUrl },
    };
  }

  item = mergeWithFrontendItem(liveItem, {
    source_id: sourceId,
    image_path: imagePath,
    widget_uuid: widgetUuid,
    is_update_supported: isUpdateSupported,
    metadata,
  });

  if (!dbRow) {
    dbRow = await HomeBannerImage.findOne({
      store_hash: storeHash,
      channel_id: channelId,
      source_type: sourceType,
      source_key: sourceKey,
    }).lean();
  }

  const updateMode = getUpdateMode(item.source_type);
  const shouldOptimizeOnly = updateMode === "optimize_only" || optimizeOnly === true;
  const targetUrl = item.original_url;
  const status = getOptimizationStatus(targetUrl, dbRow);
  const publicBase = resolvePublicBaseUrl();

  if (!item.is_update_supported && !shouldOptimizeOnly) {
    return {
      success: false,
      status: 400,
      message:
        "This homepage image cannot be auto-updated on BigCommerce. Use optimize_only mode.",
      data: { ...formatImage(item, dbRow), update_mode: "optimize_only" },
    };
  }

  if (
    !force &&
    (status === "optimized" ||
      targetUrl.startsWith(publicBase) ||
      targetUrl.includes("/storage/optimized/bigcommerce/"))
  ) {
    return {
      success: true,
      skipped: true,
      message: "Homepage image is already optimized.",
      data: formatImage(item, dbRow),
    };
  }

  if (!isValidImageUrl(targetUrl)) {
    return { success: false, status: 400, message: "Invalid image URL." };
  }

  await saveHomeImage({
    storeHash,
    channelId,
    sourceType: item.source_type,
    sourceKey: item.source_key,
    sourceId: item.source_id,
    sourceName: item.source_name,
    context: item.context,
    isUpdateSupported: item.is_update_supported,
    widgetUuid: item.widget_uuid,
    widgetName: item.widget_name,
    imagePath: item.image_path,
    originalUrl: item.original_url,
    optimizationStatus: "optimizing",
    metadata: item.metadata,
  });

  const buffer = await downloadImageBuffer(targetUrl);
  const optimized = await optimizeImageBuffer({
    buffer,
    quality,
    maxWidth,
    outputFormatInput: outputFormat,
    originalUrl: targetUrl,
  });

  if (!optimized.success) {
    await saveHomeImage({
      storeHash,
      channelId,
      sourceType: item.source_type,
      sourceKey: item.source_key,
      sourceId: item.source_id,
      sourceName: item.source_name,
      context: item.context,
      isUpdateSupported: item.is_update_supported,
      widgetUuid: item.widget_uuid,
      widgetName: item.widget_name,
      imagePath: item.image_path,
      originalUrl: item.original_url,
      originalSize: optimized.originalSize,
      optimizationStatus: "failed",
      errorMessage: optimized.error,
      metadata: item.metadata,
    });

    return { success: false, status: 400, message: optimized.error };
  }

  if (optimized.optimizedSize >= optimized.originalSize) {
    await saveHomeImage({
      storeHash,
      channelId,
      sourceType: item.source_type,
      sourceKey: item.source_key,
      sourceId: item.source_id,
      sourceName: item.source_name,
      context: item.context,
      isUpdateSupported: item.is_update_supported,
      widgetUuid: item.widget_uuid,
      widgetName: item.widget_name,
      imagePath: item.image_path,
      originalUrl: item.original_url,
      originalSize: optimized.originalSize,
      optimizedSize: optimized.optimizedSize,
      optimizationStatus: "skipped",
      errorMessage: "Optimized image is not smaller than original.",
      metadata: item.metadata,
    });

    return {
      success: false,
      status: 400,
      message: "Optimized image is not smaller than original.",
    };
  }

  const upload = await uploadOptimizedBuffer({
    buffer: optimized.optimizedBuffer,
    storeHash,
    outputFormat: optimized.outputFormat,
    subfolder: "home",
  });

  if (!shouldOptimizeOnly) {
    await updateBigCommerceSource(storeHash, accessToken, channelId, item, upload.optimizedUrl);
  }

  const savedBytes = optimized.originalSize - optimized.optimizedSize;
  const savedRecord = await saveHomeImage({
    storeHash,
    channelId,
    sourceType: item.source_type,
    sourceKey: item.source_key,
    sourceId: item.source_id,
    sourceName: item.source_name,
    context: item.context,
    isUpdateSupported: item.is_update_supported,
    widgetUuid: item.widget_uuid,
    widgetName: item.widget_name,
    imagePath: item.image_path,
    originalUrl: item.original_url,
    optimizedUrl: upload.optimizedUrl,
    originalSize: optimized.originalSize,
    optimizedSize: optimized.optimizedSize,
    savedBytes,
    outputFormat: optimized.outputFormat,
    optimizationStatus: "optimized",
    metadata: item.metadata,
  });

  const successMessageBySource = {
    widget: "Page Builder widget image optimized and updated.",
    content_page: "Homepage content page image optimized and updated.",
    marketing_banner: "Marketing banner image optimized and updated via v2 API.",
    storefront_html: "Homepage image optimized. Copy optimized_url to update manually.",
  };

  return {
    success: true,
    message: shouldOptimizeOnly
      ? successMessageBySource.storefront_html
      : successMessageBySource[item.source_type] ||
        "Homepage image optimized and updated successfully.",
    data: {
      ...formatImage(item, savedRecord.toObject(), {
        bytes: optimized.originalSize,
        width: optimized.width,
        height: optimized.height,
        format: optimized.inputFormat || optimized.outputFormat,
      }),
      update_mode: shouldOptimizeOnly ? "optimize_only" : "auto_update",
      optimize_only: shouldOptimizeOnly,
      optimized_url: upload.optimizedUrl,
      saved_bytes: savedBytes,
      saved_percent: Number(((savedBytes / optimized.originalSize) * 100).toFixed(2)),
    },
  };
};

// ─── Worker-friendly direct optimization (no live detection re-fetch) ─────────

/**
 * Optimize a home image from a pre-loaded job payload.
 * Used by the BullMQ worker to avoid fetching all home images again.
 */
exports.optimizeHomeImageDirect = async ({
  storeHash,
  accessToken,
  channelId = 1,
  sourceType,
  sourceKey,
  sourceId,
  sourceName,
  context,
  isUpdateSupported,
  originalUrl,
  widgetUuid = null,
  widgetName = null,
  imagePath = null,
  metadata = null,
  quality = config.storeDefaults.image_quality,
  maxWidth = config.image.optimizeMaxDimension,
  outputFormat = config.storeDefaults.output_format,
  force = false,
  optimizeOnly = false,
}) => {
  const dbRow = await HomeBannerImage.findOne({
    store_hash: storeHash,
    channel_id: channelId,
    source_type: sourceType,
    source_key: sourceKey,
  }).lean();

  const updateMode = getUpdateMode(sourceType);
  const shouldOptimizeOnly = updateMode === "optimize_only" || optimizeOnly === true;
  const publicBase = resolvePublicBaseUrl();
  const status = getOptimizationStatus(originalUrl, dbRow);

  if (
    !force &&
    (status === "optimized" ||
      originalUrl.startsWith(publicBase) ||
      originalUrl.includes("/storage/optimized/bigcommerce/"))
  ) {
    return { success: true, skipped: true, message: "Already optimized." };
  }

  if (!isValidImageUrl(originalUrl)) {
    return { success: false, error: "Invalid image URL." };
  }

  const item = {
    source_type: sourceType,
    source_key: sourceKey,
    source_id: sourceId,
    source_name: sourceName,
    context,
    is_update_supported: isUpdateSupported,
    widget_uuid: widgetUuid,
    widget_name: widgetName,
    image_path: imagePath,
    original_url: originalUrl,
    metadata,
  };

  await saveHomeImage({
    storeHash,
    channelId,
    sourceType,
    sourceKey,
    sourceId,
    sourceName,
    context,
    isUpdateSupported,
    widgetUuid,
    widgetName,
    imagePath,
    originalUrl,
    optimizationStatus: "optimizing",
    metadata,
  });

  let buffer;
  try {
    buffer = await downloadImageBuffer(originalUrl);
  } catch (err) {
    await saveHomeImage({
      storeHash, channelId, sourceType, sourceKey, sourceId, sourceName, context,
      isUpdateSupported, widgetUuid, widgetName, imagePath, originalUrl,
      optimizationStatus: "failed", errorMessage: `Download failed: ${err.message}`, metadata,
    });
    return { success: false, error: `Download failed: ${err.message}` };
  }

  const optimized = await optimizeImageBuffer({
    buffer, quality, maxWidth, outputFormatInput: outputFormat, originalUrl,
  });

  if (!optimized.success) {
    await saveHomeImage({
      storeHash, channelId, sourceType, sourceKey, sourceId, sourceName, context,
      isUpdateSupported, widgetUuid, widgetName, imagePath, originalUrl,
      originalSize: optimized.originalSize, optimizationStatus: "failed",
      errorMessage: optimized.error, metadata,
    });
    return { success: false, error: optimized.error };
  }

  if (optimized.optimizedSize >= optimized.originalSize) {
    await saveHomeImage({
      storeHash, channelId, sourceType, sourceKey, sourceId, sourceName, context,
      isUpdateSupported, widgetUuid, widgetName, imagePath, originalUrl,
      originalSize: optimized.originalSize, optimizedSize: optimized.optimizedSize,
      optimizationStatus: "skipped", errorMessage: "Optimized image is not smaller than original.", metadata,
    });
    return { success: false, skipped: true, error: "Optimized image is not smaller than original." };
  }

  const upload = await uploadOptimizedBuffer({
    buffer: optimized.optimizedBuffer, storeHash, outputFormat: optimized.outputFormat, subfolder: "home",
  });

  if (!shouldOptimizeOnly) {
    try {
      await updateBigCommerceSource(storeHash, accessToken, channelId, item, upload.optimizedUrl);
    } catch (err) {
      await saveHomeImage({
        storeHash, channelId, sourceType, sourceKey, sourceId, sourceName, context,
        isUpdateSupported, widgetUuid, widgetName, imagePath, originalUrl,
        originalSize: optimized.originalSize, optimizedSize: optimized.optimizedSize,
        optimizationStatus: "failed", errorMessage: `BC update failed: ${err.message}`, metadata,
      });
      return { success: false, error: `BC update failed: ${err.message}` };
    }
  }

  const savedBytes = optimized.originalSize - optimized.optimizedSize;

  const savedRecord = await saveHomeImage({
    storeHash, channelId, sourceType, sourceKey, sourceId, sourceName, context,
    isUpdateSupported, widgetUuid, widgetName, imagePath, originalUrl,
    optimizedUrl: upload.optimizedUrl, originalSize: optimized.originalSize,
    optimizedSize: optimized.optimizedSize, savedBytes,
    outputFormat: optimized.outputFormat, optimizationStatus: "optimized", metadata,
  });

  return {
    success: true,
    data: {
      source_key: sourceKey,
      source_type: sourceType,
      optimized_url: upload.optimizedUrl,
      original_size: optimized.originalSize,
      optimized_size: optimized.optimizedSize,
      saved_bytes: savedBytes,
      saved_percent: Number(((savedBytes / optimized.originalSize) * 100).toFixed(2)),
      output_format: optimized.outputFormat,
      record_id: savedRecord._id,
    },
  };
};

// ─── Restore ──────────────────────────────────────────────────────────────────

/**
 * Restore a single home image to its original URL on BigCommerce.
 */
exports.restoreHomeImageSingle = async ({
  storeHash,
  accessToken,
  channelId = 1,
  recordId = null,
  sourceType = null,
  sourceKey = null,
}) => {
  let dbRow = null;

  if (recordId) {
    dbRow = await HomeBannerImage.findOne({ _id: recordId, store_hash: storeHash }).lean();
  } else if (sourceType && sourceKey) {
    dbRow = await HomeBannerImage.findOne({
      store_hash: storeHash,
      channel_id: channelId,
      source_type: sourceType,
      source_key: sourceKey,
    }).lean();
  }

  if (!dbRow) {
    return { success: false, status: 404, message: "Home image record not found." };
  }

  const { original_url, optimized_url, optimization_status } = dbRow;

  if (!optimized_url || optimization_status !== "optimized") {
    return {
      success: false,
      skipped: true,
      status: 400,
      message: "Image is not optimized — nothing to restore.",
      data: { source_key: dbRow.source_key, optimization_status },
    };
  }

  if (!original_url) {
    return { success: false, status: 400, message: "Original URL not available for restore." };
  }

  const item = {
    source_type: dbRow.source_type,
    source_key: dbRow.source_key,
    source_id: dbRow.source_id,
    image_path: dbRow.image_path_in_config,
    widget_uuid: dbRow.widget_uuid,
    original_url: optimized_url,
  };

  try {
    await updateBigCommerceSource(storeHash, accessToken, channelId, item, original_url);
  } catch (err) {
    return {
      success: false,
      status: 500,
      message: `Failed to restore on BigCommerce: ${err.message}`,
    };
  }

  const restoredRecord = await HomeBannerImage.findOneAndUpdate(
    { _id: dbRow._id },
    {
      $set: {
        current_url: original_url,
        optimized_url: null,
        optimization_status: "pending",
        error_message: null,
        last_optimized_at: null,
        saved_bytes: 0,
        saved_percent: 0,
        optimized_size: null,
        output_format: null,
      },
    },
    { new: true }
  ).lean();

  return {
    success: true,
    message: "Home image restored to original successfully.",
    data: {
      source_key: dbRow.source_key,
      source_type: dbRow.source_type,
      original_url,
      optimization_status: "pending",
      record_id: dbRow._id,
    },
  };
};

// ─── Bulk job helpers ─────────────────────────────────────────────────────────

exports.createHomeImageBulkJob = async ({
  jobUuid = crypto.randomUUID(),
  storeHash,
  channelId = 1,
  jobType,
  totalImages,
  queuedImages = totalImages,
  skippedImages = 0,
}) => {
  const validJobType = normalizeJobType(jobType);
  if (!validJobType) {
    return { error: `Invalid job_type "${jobType}"`, jobUuid: null, doc: null };
  }

  try {
    const doc = await HomeImageJob.create({
      job_uuid: jobUuid,
      store_hash: storeHash,
      channel_id: channelId,
      job_type: validJobType,
      total_images: totalImages,
      queued_images: queuedImages,
      skipped_images: skippedImages,
      processed_images: 0,
      success_images: 0,
      failed_images: 0,
      status: queuedImages > 0 ? "processing" : "completed",
      started_at: new Date(),
    });

    return { error: null, jobUuid, doc };
  } catch (err) {
    console.error("[createHomeImageBulkJob]", err.message);
    return { error: err.message, jobUuid: null, doc: null };
  }
};

exports.recordHomeJobItemResult = async ({
  jobUuid,
  success,
  skipped = false,
  errorMessage = null,
  savedBytes = null,
}) => {
  if (!jobUuid) return { error: "jobUuid is required" };

  try {
    const increment = { processed_images: 1 };
    if (skipped) {
      // skipped doesn't count as success or failure in counters
    } else if (success) {
      increment.success_images = 1;
    } else {
      increment.failed_images = 1;
    }

    const updatedJob = await HomeImageJob.findOneAndUpdate(
      { job_uuid: jobUuid },
      { $inc: increment },
      { new: true }
    );

    if (updatedJob) {
      const queued = updatedJob.queued_images || 0;
      const processed = updatedJob.processed_images || 0;

      if (processed >= queued) {
        await HomeImageJob.updateOne(
          { job_uuid: jobUuid, status: { $ne: "completed" } },
          { $set: { status: "completed", completed_at: new Date() } }
        );
      }
    }

    return { error: null };
  } catch (err) {
    console.error("[recordHomeJobItemResult]", err.message);
    return { error: err.message };
  }
};

exports.getHomeJobStatus = async (jobUuid, storeHash) => {
  const query = { job_uuid: jobUuid };
  if (storeHash) query.store_hash = storeHash;

  try {
    const job = await HomeImageJob.findOne(query).lean();

    if (!job) {
      return { error: null, job: null };
    }

    const queued = job.queued_images || 0;
    const processed = job.processed_images || 0;

    return {
      error: null,
      job: {
        ...job,
        pending_images: Math.max(0, queued - processed),
      },
    };
  } catch (err) {
    console.error("[getHomeJobStatus]", err.message);
    return { error: err.message, job: null };
  }
};

/**
 * Fetch all home images that can be restored (have optimized_url + status optimized).
 */
exports.fetchRestorableHomeImages = async (storeHash, channelId = 1) => {
  const rows = await HomeBannerImage.find({
    store_hash: storeHash,
    channel_id: channelId,
    optimization_status: "optimized",
    optimized_url: { $ne: null, $exists: true },
    original_url: { $ne: null, $exists: true },
  })
    .select({
      _id: 1,
      source_type: 1,
      source_key: 1,
      source_id: 1,
      source_name: 1,
      original_url: 1,
      optimized_url: 1,
      widget_uuid: 1,
      image_path_in_config: 1,
    })
    .lean();

  return rows;
};

/**
 * Fetch all home images eligible for bulk optimization.
 * Skips already-optimized images unless force=true.
 */
exports.fetchAllHomeImagesForBulk = async (
  storeHash,
  accessToken,
  channelId = 1,
  storeUrl = null,
  { skipOptimized = true } = {}
) => {
  const { images, errors } = await detectHomepageImages(
    storeHash,
    accessToken,
    channelId,
    storeUrl,
    { skipHtmlScan: false }
  );

  const optimizableImages = images.filter((img) => img.is_update_supported || true);

  if (!skipOptimized || optimizableImages.length === 0) {
    return { items: optimizableImages, errors };
  }

  const sourceKeys = optimizableImages.map((img) => img.source_key);
  const optimizedRows = await HomeBannerImage.find({
    store_hash: storeHash,
    channel_id: channelId,
    source_key: { $in: sourceKeys },
    optimization_status: { $in: ["optimized", "optimizing"] },
  })
    .select({ source_key: 1 })
    .lean();

  const skipSet = new Set(optimizedRows.map((row) => row.source_key));

  return {
    items: optimizableImages.filter((img) => !skipSet.has(img.source_key)),
    errors,
  };
};
