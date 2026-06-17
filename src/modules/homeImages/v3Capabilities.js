function getCapabilityBySource(sourceType, sourceId) {
  if (sourceType === "marketing_banner") {
    return {
      api_version: "v2",
      can_update_via_api: true,
      update_mode: "auto_update",
      detect: "GET /v2/banners?page=home_page&limit=250",
      read: `GET /v2/banners/${sourceId}`,
      update: `PUT /v2/banners/${sourceId}`,
      update_payload_field: "content",
      non_v3_reason: null,
      manual_update_hint: null,
    };
  }

  if (sourceType === "widget") {
    return {
      api_version: "v3",
      can_update_via_api: true,
      update_mode: "auto_update",
      detect: "GET /v3/content/placements?template_file=pages/home&limit=250",
      read: `GET /v3/content/widgets/${sourceId}`,
      update: `PUT /v3/content/widgets/${sourceId}`,
      update_payload_field: "widget_configuration",
      non_v3_reason: null,
      manual_update_hint: null,
    };
  }

  if (sourceType === "storefront_html") {
    return {
      api_version: "storefront_html",
      can_update_via_api: false,
      update_mode: "manual_detect_required",
      detect: "GET storefront homepage HTML",
      read: null,
      update: null,
      update_payload_field: null,
      non_v3_reason:
        "Image detected from rendered storefront HTML. Actual source may be theme, widget, carousel, banner, or custom HTML.",
      manual_update_hint:
        "Direct update is not safe. First identify actual source. If same image is found in widget or marketing banner then update via API.",
    };
  }

  return {
    api_version: null,
    can_update_via_api: false,
    update_mode: "not_supported",
    detect: null,
    read: null,
    update: null,
    update_payload_field: null,
    non_v3_reason: "Unknown source type.",
    manual_update_hint: "Manual check required.",
  };
}

module.exports = {
  getCapabilityBySource,
};