/**
 * BigCommerce homepage image update capabilities (v3 Content API).
 * @see https://developer.bigcommerce.com/docs/rest-content/widgets
 * @see https://developer.bigcommerce.com/docs/rest-content/pages
 *
 * NOT updatable via v3:
 * - Classic theme Home Page Carousel (Stencil config / control panel only)
 * - Marketing banners (v2/banners only — excluded from this app)
 * - Static theme assets under /assets/img/
 */

const HOME_V3_UPDATABLE_SOURCES = [
  {
    source_type: "widget",
    label: "Page Builder Widget",
    description:
      "Widgets placed on the homepage (image sliders, header images, custom blocks).",
    detect: "GET /v3/content/placements?template_file=pages/home&channel_id={channel_id}",
    read: "GET /v3/content/widgets/{uuid}",
    update: "PUT /v3/content/widgets/{uuid}",
    update_payload_field: "widget_configuration",
    is_update_supported: true,
    update_mode: "auto_update",
  },
  {
    source_type: "content_page",
    label: "Homepage Content Page",
    description:
      "Images inside the channel homepage content page (HTML body or page fields).",
    detect: "GET /v3/content/pages?channel_id={channel_id} (is_homepage=true)",
    read: "GET /v3/content/pages/{id}",
    update: "PUT /v3/content/pages/{id}",
    update_payload_field: "body or nested page fields",
    is_update_supported: true,
    update_mode: "auto_update",
  },
];

const HOME_NON_V3_SOURCES = [
  {
    context: "carousel",
    label: "Classic Home Page Carousel",
    source_type: "storefront_html",
    reason:
      "Stencil theme carousel slides are configured in Control Panel > Storefront > Home Page Carousel. BigCommerce provides no v3 REST API for these slides.",
    is_update_supported: false,
    update_mode: "optimize_only",
    manual_update_hint:
      "Replace the slide image manually in Storefront > Home Page Carousel, or migrate to a Page Builder image-slider widget.",
  },
  {
    context: "marketing_banner",
    label: "Marketing Banner (rendered HTML)",
    source_type: "storefront_html",
    reason:
      "Legacy marketing banners are managed via v2/banners (not v3). This app uses v3 Content API only.",
    is_update_supported: false,
    update_mode: "optimize_only",
    manual_update_hint:
      "Update the banner image in Marketing > Banners, or use a Page Builder widget instead.",
  },
  {
    context: "storefront_html",
    label: "Other Theme HTML",
    source_type: "storefront_html",
    reason:
      "Image is rendered by the Stencil theme without a matching v3 Content API record.",
    is_update_supported: false,
    update_mode: "optimize_only",
    manual_update_hint: "Update the image in the theme or control panel section that owns it.",
  },
];

function getV3SourceCapability(sourceType) {
  return HOME_V3_UPDATABLE_SOURCES.find((row) => row.source_type === sourceType) || null;
}

function getNonV3SourceInfo(context) {
  return (
    HOME_NON_V3_SOURCES.find((row) => row.context === context) ||
    HOME_NON_V3_SOURCES.find((row) => row.context === "storefront_html")
  );
}

function buildV3MetaForImage(item) {
  if (item.is_update_supported) {
    const capability = getV3SourceCapability(item.source_type);
    return {
      api_version: "v3",
      can_update_via_api: true,
      update_mode: capability?.update_mode || "auto_update",
      detect: capability?.detect || null,
      read: capability?.read || null,
      update: capability?.update || null,
      update_payload_field: capability?.update_payload_field || null,
      non_v3_reason: null,
      manual_update_hint: null,
    };
  }

  const nonV3 = getNonV3SourceInfo(item.context);
  return {
    api_version: null,
    can_update_via_api: false,
    update_mode: nonV3?.update_mode || "optimize_only",
    detect: "GET storefront homepage HTML (no v3 update endpoint)",
    read: null,
    update: null,
    update_payload_field: null,
    non_v3_reason: nonV3?.reason || "No v3 Content API endpoint for this image source.",
    manual_update_hint: nonV3?.manual_update_hint || null,
  };
}

module.exports = {
  HOME_V3_UPDATABLE_SOURCES,
  HOME_NON_V3_SOURCES,
  getV3SourceCapability,
  getNonV3SourceInfo,
  buildV3MetaForImage,
};
