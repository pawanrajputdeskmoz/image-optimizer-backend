const { isValidImageUrl, normalizeImageUrl } = require("./widgetImagePathUtils");

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toAbsoluteUrl(url, baseUrl) {
  const raw = decodeHtmlEntities(String(url || "").trim());
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!baseUrl) return null;

  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

function pushUnique(results, seen, entry) {
  const absolute = toAbsoluteUrl(entry.url, entry.baseUrl);
  if (!absolute || !isValidImageUrl(absolute)) return;

  const key = absolute.split("?")[0].toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  results.push({
    url: absolute,
    context: entry.context || "html",
    image_path: entry.imagePath || entry.context || "html",
    source_hint: entry.sourceHint || null,
  });
}

function extractSrcsetUrls(value, baseUrl) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((url) => toAbsoluteUrl(url, baseUrl))
    .filter(Boolean);
}

function extractImagesFromHtml(html, baseUrl, options = {}) {
  const content = String(html || "");
  const results = [];
  const seen = new Set();

  const patterns = [
    {
      regex: /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
      context: "img_tag",
      imagePath: "img.src",
    },
    {
      regex: /<img\b[^>]*\bdata-src=["']([^"']+)["'][^>]*>/gi,
      context: "img_lazy",
      imagePath: "img.data-src",
    },
    {
      regex: /<source\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/gi,
      context: "picture_source",
      imagePath: "source.srcset",
      srcset: true,
    },
    {
      regex: /\bbackground-image\s*:\s*url\((['"]?)([^'")]+)\1\)/gi,
      context: "css_background",
      imagePath: "style.background-image",
      group: 2,
    },
    {
      regex: /\bbackground\s*:[^;]*url\((['"]?)([^'")]+)\1\)/gi,
      context: "css_background_shorthand",
      imagePath: "style.background",
      group: 2,
    },
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      if (pattern.srcset) {
        for (const url of extractSrcsetUrls(match[1], baseUrl)) {
          pushUnique(results, seen, {
            url,
            baseUrl,
            context: pattern.context,
            imagePath: pattern.imagePath,
            sourceHint: options.sourceHint,
          });
        }
        continue;
      }

      const captured = match[pattern.group || 1];
      pushUnique(results, seen, {
        url: captured,
        baseUrl,
        context: pattern.context,
        imagePath: pattern.imagePath,
        sourceHint: options.sourceHint,
      });
    }
  }

  return results;
}

module.exports = {
  decodeHtmlEntities,
  toAbsoluteUrl,
  extractImagesFromHtml,
  extractSrcsetUrls,
};
