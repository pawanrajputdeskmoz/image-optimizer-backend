const config = require("../../../config");

function parsePage(value, fallback = 1) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLimit(value, fallback = 20) {
  const n = Number.parseInt(value, 10);
  const max = config.pagination?.adminMaxLimit ?? 100;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function buildPagination(page, limit, total) {
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_prev: page > 1,
  };
}

function resolvePagination(query = {}, defaults = {}) {
  const page = parsePage(query.page, defaults.page ?? 1);
  const limit = parseLimit(query.limit, defaults.limit ?? 20);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

module.exports = {
  parsePage,
  parseLimit,
  buildPagination,
  resolvePagination,
};
