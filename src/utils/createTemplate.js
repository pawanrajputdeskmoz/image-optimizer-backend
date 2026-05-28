/**
 * Build string from template placeholders.
 *
 * Example:
 * template: "[brand]-[name]-[sku]"
 * data: {
 *   brand: "Nike",
 *   name: "Air Max",
 *   sku: "NK-101"
 * }
 *
 * Output:
 * "Nike-Air Max-NK-101"
 */

function buildTemplateString(template, data = {}) {
 if (!template || typeof template !== "string") {
  return "";
 }

 return template
  .replace(/\[([^\]]+)\]/g, (_, key) => {
   const value = data[key];

   // If value is null/undefined return empty string
   if (value === null || value === undefined) {
    return "";
   }

   return String(value).trim();
  })

  // Remove duplicate separators
  .replace(/-{2,}/g, "-")

  // Remove starting/ending separators
  .replace(/^-+|-+$/g, "")

  // Remove extra spaces
  .replace(/\s+/g, " ")
  .trim();
}