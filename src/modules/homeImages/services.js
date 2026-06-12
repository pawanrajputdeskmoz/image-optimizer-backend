const crypto = require("crypto");
const axiosUtils = require("../../utils/axiosUtils");
const config = require("../../config");
const { HomeBannerImage } = require("../../models");
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
  HOME_NON_V3_SOURCES,
  buildV3MetaForImage,
} = require("./v3Capabilities");

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

function sourceKey(sourceType, ...parts) {
  return `${sourceType}::${parts.filter(Boolean).join("::")}`;
}

function replaceUrlInHtml(html, originalUrl, optimizedUrl) {
  const content = String(html || "");
  if (content.includes(originalUrl)) {
    return content.split(originalUrl).join(optimizedUrl);
  }
  const base = originalUrl.split("?")[0];
  return content.split(base).join(optimizedUrl);
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
  if (["widget", "content_page"].includes(sourceType)) {
    return "auto_update";
  }
  return "unsupported";
}

function parseIdFromSourceKey(sourceType, sourceKey) {
  const parts = String(sourceKey || "").split("::");
  if (parts[0] !== sourceType || !parts[1]) return null;
  return parts[1];
}

function validateFrontendKeys(sourceType, sourceKey) {
  if (!sourceType || !sourceKey) {
    return "source_type and source_key are required.";
  }

  if (!sourceKey.startsWith(`${sourceType}::`)) {
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

async function detectHomepageImages(storeHash, accessToken, channelId, storeUrl) {
  const images = [];
  const errors = [];
  const headers = bcHeaders(accessToken);
  const timeout = { timeout: config.api.bigCommerceTimeoutMs };

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
          source_key: sourceKey("widget", widget.uuid || placement.widget_uuid, image.path),
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
          source_key: sourceKey("content_page", page.id, image.path),
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
            source_key: sourceKey(
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

async function updateBigCommerceSource(storeHash, accessToken, channelId, item, optimizedUrl) {
  const headers = bcHeaders(accessToken);
  const timeout = { headers, timeout: config.api.bigCommerceTimeoutMs };

  if (item.source_type === "widget") {
    const widgetRes = await axiosUtils.get(
      bcUrl(storeHash, `/v3/content/widgets/${item.widget_uuid}`),
      headers,
      { timeout: config.api.bigCommerceTimeoutMs }
    );
    const widget = widgetRes?.data;
    if (!widget) throw new Error("Widget not found.");

    const updatedConfig = replaceNestedValueByPath(
      widget.widget_configuration || {},
      item.image_path,
      optimizedUrl
    );

    await axiosUtils.put(
      bcUrl(storeHash, `/v3/content/widgets/${item.widget_uuid}`),
      {
        name: widget.name,
        widget_template_uuid: widget.widget_template_uuid,
        widget_configuration: updatedConfig,
      },
      timeout
    );
    return;
  }

  if (item.source_type === "content_page") {
    const pageRes = await axiosUtils.get(
      bcUrl(storeHash, `/v3/content/pages/${item.source_id}`),
      headers,
      { params: { channel_id: channelId }, timeout: config.api.bigCommerceTimeoutMs }
    );
    const page = pageRes?.data;
    if (!page) throw new Error("Content page not found.");

    if (String(item.image_path || "").startsWith("body.")) {
      await axiosUtils.put(
        bcUrl(storeHash, `/v3/content/pages/${item.source_id}`),
        {
          ...page,
          body: replaceUrlInHtml(page.body, item.original_url, optimizedUrl),
        },
        timeout
      );
      return;
    }

    await axiosUtils.put(
      bcUrl(storeHash, `/v3/content/pages/${item.source_id}`),
      replaceNestedValueByPath(page, item.image_path, optimizedUrl),
      timeout
    );
  }
}

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
    dbRows.map((row) => [`${row.source_type}::${row.source_key}`, row])
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
    formatImage(item, dbByKey[`${item.source_type}::${item.source_key}`] || null, sizeByKey[item.source_key])
  );

  const v3UpdatableCount = data.filter((row) => row.is_update_supported).length;

  return {
    count: data.length,
    data,
    sources: {
      widget: data.filter((row) => row.source_type === "widget").length,
      content_page: data.filter((row) => row.source_type === "content_page").length,
      storefront_html: data.filter((row) => row.source_type === "storefront_html").length,
    },
    v3_capabilities: HOME_V3_UPDATABLE_SOURCES,
    non_v3_sources: HOME_NON_V3_SOURCES,
    summary: {
      v3_updatable_count: v3UpdatableCount,
      preview_only_count: data.length - v3UpdatableCount,
    },
    errors,
  };
};

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

  const { images } = await detectHomepageImages(storeHash, accessToken, channelId, storeUrl);
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
  const shouldOptimizeOnly =
    updateMode === "optimize_only" || optimizeOnly === true;

  const targetUrl = item.original_url;
  const status = getOptimizationStatus(targetUrl, dbRow);
  const publicBase = resolvePublicBaseUrl();

  if (!item.is_update_supported && !shouldOptimizeOnly) {
    return {
      success: false,
      status: 400,
      message:
        "This homepage image cannot be auto-updated on BigCommerce. Backend will use optimize_only mode for this source.",
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
    await updateBigCommerceSource(
      storeHash,
      accessToken,
      channelId,
      item,
      upload.optimizedUrl
    );
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
