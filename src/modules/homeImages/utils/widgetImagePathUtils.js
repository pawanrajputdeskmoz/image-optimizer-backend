const IMAGE_URL_PATTERN = /^https?:\/\//i;

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"];

const BC_CDN_HINTS = [
  "bigcommerce.com",
  "cdn.bcapp.dev",
  "mybigcommerce.com",
];

function normalizeImageUrl(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!IMAGE_URL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function isValidImageUrl(value) {
  const normalized = normalizeImageUrl(value);
  if (!normalized) return false;

  const clean = normalized.split("?")[0].toLowerCase();

  if (IMAGE_EXTENSIONS.some((ext) => clean.endsWith(ext))) {
    return true;
  }

  if (BC_CDN_HINTS.some((hint) => normalized.toLowerCase().includes(hint))) {
    if (
      /(image|images|product_images|stencil|content|banner|carousel|slide)/i.test(
        normalized
      )
    ) {
      return true;
    }
  }

  return false;
}

function parseObjectPath(objectPath) {
  const tokens = [];
  const parts = String(objectPath || "").split(".");

  for (const part of parts) {
    const regex = /([^\[\]]+)|\[(\d+)\]/g;
    let match;

    while ((match = regex.exec(part)) !== null) {
      if (match[1]) tokens.push(match[1]);
      if (match[2]) tokens.push(Number(match[2]));
    }
  }

  return tokens;
}

function extractImageUrlsFromObject(input) {
  const results = [];

  const walk = (value, currentPath) => {
    if (typeof value === "string") {
      if (isValidImageUrl(value)) {
        results.push({ path: currentPath, url: value });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const nextPath = currentPath ? `${currentPath}[${index}]` : `[${index}]`;
        walk(item, nextPath);
      });
      return;
    }

    if (value && typeof value === "object") {
      Object.keys(value).forEach((key) => {
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        walk(value[key], nextPath);
      });
    }
  };

  walk(input, "");
  return results;
}

function getValueByPath(obj, objectPath) {
  const tokens = parseObjectPath(objectPath);
  let current = obj;

  for (const token of tokens) {
    if (current == null || current[token] === undefined) {
      return undefined;
    }
    current = current[token];
  }

  return current;
}

function replaceNestedValueByPath(obj, objectPath, newValue) {
  const cloned = JSON.parse(JSON.stringify(obj || {}));
  const tokens = parseObjectPath(objectPath);

  if (!tokens.length) {
    throw new Error("Invalid image path.");
  }

  let current = cloned;

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];

    if (current[token] === undefined || current[token] === null) {
      throw new Error(`Invalid image path. Missing key: ${String(token)}`);
    }

    current = current[token];
  }

  const lastToken = tokens[tokens.length - 1];

  if (current[lastToken] === undefined) {
    throw new Error(`Invalid image path. Missing final key: ${String(lastToken)}`);
  }

  current[lastToken] = newValue;
  return cloned;
}

module.exports = {
  isValidImageUrl,
  normalizeImageUrl,
  extractImageUrlsFromObject,
  getValueByPath,
  replaceNestedValueByPath,
  parseObjectPath,
};
