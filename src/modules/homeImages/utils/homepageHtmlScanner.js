const axios = require("axios");
const config = require("../../../config");
const { extractImagesFromHtml } = require("./htmlImageExtractor");

function isThemeCarouselUrl(url) {
  const value = String(url || "").toLowerCase();
  return (
    /\/images\/stencil\//i.test(value) ||
    /\/carousel\//i.test(value) ||
    /stencil-hero/i.test(value) ||
    /(carousel|hero|slideshow|slider|slide)[-_]/i.test(value)
  );
}

function isMarketingBannerUpload(url) {
  const value = String(url || "").toLowerCase();
  return /\/product_images\/uploaded_images\//i.test(value) && !isThemeCarouselUrl(url);
}

function classifySectionContext(sectionHtml) {
  const section = String(sectionHtml || "").toLowerCase();
  if (/carousel|hero-carousel|slideshow|slider|slick-slide|hero-slide/i.test(section)) {
    return "carousel";
  }
  if (/\bbanner\b|marketing-banner|data-banner/i.test(section)) {
    return "marketing_banner";
  }
  return "storefront_html";
}

function classifyHomepageContext(url, htmlSnippet = "") {
  if (isThemeCarouselUrl(url)) return "carousel";
  if (isMarketingBannerUpload(url)) return "marketing_banner";

  const sectionContext = classifySectionContext(htmlSnippet);
  if (sectionContext !== "storefront_html") return sectionContext;

  const haystack = `${url} ${htmlSnippet}`.toLowerCase();
  if (/carousel|hero-carousel|slideshow|slider|slick-slide/i.test(haystack)) {
    return "carousel";
  }
  if (/\bbanner\b|marketing-banner/i.test(haystack)) {
    return "marketing_banner";
  }
  return "storefront_html";
}

async function fetchHomepageHtml(homepageUrl) {
  const response = await axios.get(homepageUrl, {
    timeout: config.image.fetchTimeoutMs,
    maxRedirects: 5,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 BigCommerceImageOptimizer/1.0",
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return String(response.data || "");
}

function extractHomepageSections(html) {
  const sections = [];
  const sectionRegex =
    /<(section|div)[^>]*(carousel|hero|slideshow|slider|banner)[^>]*>[\s\S]*?<\/\1>/gi;

  let match;
  while ((match = sectionRegex.exec(html)) !== null) {
    sections.push({
      html: match[0],
      context: classifySectionContext(match[0]),
    });
  }

  return sections;
}

async function scanHomepageHtml(homepageUrl) {
  if (!homepageUrl) {
    return { success: false, images: [], error: "Homepage URL is missing." };
  }

  try {
    const html = await fetchHomepageHtml(homepageUrl);
    const homepageSections = extractHomepageSections(html);

    const images = [];
    const seen = new Set();

    const isLikelyProductThumb = (url) =>
      /\/products\/\d+\//i.test(String(url || ""));

    const addImages = (items, defaultContext) => {
      for (const item of items) {
        if (/ProductDefault\.gif/i.test(item.url)) continue;
        if (defaultContext === "carousel" && isLikelyProductThumb(item.url)) {
          continue;
        }

        const key = item.url.split("?")[0].toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        images.push({
          ...item,
          context: classifyHomepageContext(item.url, item.htmlSnippet || "") ||
            item.context ||
            defaultContext,
        });
      }
    };

    for (const section of homepageSections) {
      addImages(
        extractImagesFromHtml(section.html, homepageUrl, {
          sourceHint: `${section.context}_section`,
        }).map((img) => ({
          ...img,
          htmlSnippet: section.html,
          context: classifyHomepageContext(img.url, section.html),
        })),
        section.context
      );
    }

    addImages(
      extractImagesFromHtml(html, homepageUrl, {
        sourceHint: "homepage_html",
      })
        .filter((img) => {
          if (isLikelyProductThumb(img.url)) return false;
          if (/ProductDefault\.gif/i.test(img.url)) return false;
          return true;
        })
        .map((img) => ({
          ...img,
          context: classifyHomepageContext(img.url, html),
        })),
      "storefront_html"
    );

    return {
      success: true,
      homepageUrl,
      images,
    };
  } catch (error) {
    return {
      success: false,
      images: [],
      error: error?.message || "Failed to fetch homepage HTML.",
    };
  }
}

module.exports = {
  scanHomepageHtml,
  fetchHomepageHtml,
  classifyHomepageContext,
};
