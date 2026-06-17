/**
 * BigCommerce homepage image update capabilities.
 *
 * v3 Content API (auto-update supported):
 *   - Widgets placed on pages/home
 *   - Homepage content pages
 *
 * v2 API (auto-update supported):
 *   - Marketing banners (GET/PUT /v2/banners)
 *
 * NOT auto-updatable via any API:
 *   - Classic theme carousel slides (Stencil config / Control Panel only)
 *   - Static theme assets under /assets/img/
 */

const HOME_V3_UPDATABLE_SOURCES = [
  {
    source_type: "widget",
    api_version: "v3",
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
    api_version: "v3",
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

const HOME_V2_UPDATABLE_SOURCES = [
  {
    source_type: "marketing_banner",
    api_version: "v2",
    label: "Marketing Banner",
    description:
      "Marketing banners on the home page managed via BigCommerce v2 Banners API.",
    detect: "GET /v2/banners?page=1&limit=250 (filtered by page=home_page)",
    read: "GET /v2/banners/{id}",
    update: "PUT /v2/banners/{id}",
    update_payload_field: "content (HTML)",
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
      "Stencil theme carousel slides are configured in Control Panel > Storefront > Home Page Carousel. BigCommerce provides no REST API for these slides.",
    is_update_supported: false,
    update_mode: "optimize_only",
    manual_update_hint:
      "Replace the slide image manually in Storefront > Home Page Carousel, or migrate to a Page Builder image-slider widget.",
  },
  {
    context: "storefront_html",
    label: "Other Theme HTML",
    source_type: "storefront_html",
    reason:
      "Image is rendered by the Stencil theme without a matching REST API record.",
    is_update_supported: false,
    update_mode: "optimize_only",
    manual_update_hint: "Update the image in the theme or control panel section that owns it.",
  },
];

function getV3SourceCapability(sourceType) {
  return (
    HOME_V3_UPDATABLE_SOURCES.find((row) => row.source_type === sourceType) ||
    HOME_V2_UPDATABLE_SOURCES.find((row) => row.source_type === sourceType) ||
    null
  );
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
      api_version: capability?.api_version || "v3",
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
    detect: "GET storefront homepage HTML (no REST update endpoint)",
    read: null,
    update: null,
    update_payload_field: null,
    non_v3_reason: nonV3?.reason || "No REST API endpoint for this image source.",
    manual_update_hint: nonV3?.manual_update_hint || null,
  };
}

module.exports = {
  HOME_V3_UPDATABLE_SOURCES,
  HOME_V2_UPDATABLE_SOURCES,
  HOME_NON_V3_SOURCES,
  getV3SourceCapability,
  getNonV3SourceInfo,
  buildV3MetaForImage,
};
