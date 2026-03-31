
exports.buildBigCommerceError = (error) => {
 const status = error?.response?.status || 500;
 const bcPayload = error?.response?.data;
 const message =
   bcPayload?.title ||
   bcPayload?.message ||
   error?.message ||
   "Failed to fetch products from BigCommerce";

 return {
   status,
   body: {
     success: false,
     message,
     error: {
       source: "bigcommerce",
       status,
       title: bcPayload?.title || null,
       type: bcPayload?.type || null,
       detail: bcPayload?.detail || bcPayload?.errors || null,
     },
   },
 };
}

exports.normalizePagination = (query = {}) => {
 const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
 const limit = Math.min(5, Math.max(1, Number.parseInt(query.limit, 5) || 5));
 return { page, limit };
}

