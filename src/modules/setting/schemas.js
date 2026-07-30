const getChannelsSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              type: { type: "string" },
              platform: { type: "string" },
              status: { type: "string" },
              site_id: { type: "integer" },
              url: { type: "string" },
            },
          },
        },
        default: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                channel_id: { type: "integer" },
                site_id: { type: "integer" },
                platform: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
};

const getStoreOptimizationSettingsSchema = {
  querystring: {
    type: "object",
    properties: {
      channel_id: { type: ["integer", "string"] },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          anyOf: [{ type: "null" }, { type: "object", additionalProperties: true }],
        },
      },
    },
  },
};

const upsertStoreOptimizationSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: true,
    properties: {
      channel_id: {
        type: ["integer", "string"],
      },
      optimization_mode: {
        type: "string",
        enum: ["optimize_and_alt", "optimize_only", "alt_only"],
      },
      optimize_image_enabled: { type: "boolean" },
      is_filename_template_enabled: { type: "boolean" },
      filename_template: {
        type: "string",
        minLength: 1,
        maxLength: 500,
      },
      is_alt_text_template_enabled: { type: "boolean" },
      alt_text_template: {
        type: "string",
        minLength: 1,
        maxLength: 500,
      },
      image_quality: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
      output_format: {
        type: "string",
        enum: ["jpeg", "png", "webp", "avif", "original"],
      },
      product_sort_direction: {
        type: "string",
        enum: ["asc", "desc"],
      },
      shop: { type: "string" },
      store_id: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: { type: "object", additionalProperties: true },
      },
    },
  },
};

const registerProductCreatedWebhookSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            scopes: {
              type: "array",
              items: { type: "string" },
            },
            destination: { type: "string" },
            alreadyExists: { type: "boolean" },
            hooks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  },
};

const disableProductCreatedWebhookSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            destination: { type: "string" },
            notFound: { type: "boolean" },
            deleted: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  scope: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

const registerCategoryCreatedWebhookSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            scopes: {
              type: "array",
              items: { type: "string" },
            },
            destination: { type: "string" },
            alreadyExists: { type: "boolean" },
            hooks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  },
};

const disableCategoryCreatedWebhookSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            destination: { type: "string" },
            notFound: { type: "boolean" },
            deleted: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  scope: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

const dashboardStatCardSchema = {
  type: "object",
  properties: {
    value: { type: "number" },
    display: { type: "string" },
    subtitle: { type: "string" },
  },
};

const getClientDashboardStatsSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          properties: {
            pending_images: dashboardStatCardSchema,
            pending_restore_images: dashboardStatCardSchema,
            pending_mode: { type: "string" },
            optimized_images: dashboardStatCardSchema,
            total_data_saved: dashboardStatCardSchema,
            image_quota: {
              type: "object",
              properties: {
                percent: { type: "number" },
                display: { type: "string" },
                used: { type: "number" },
                limit: { anyOf: [{ type: "null" }, { type: "number" }] },
                plan: { type: "string" },
                plan_name: { type: "string" },
                plan_price: { type: "number" },
                subtitle: { type: "string" },
              },
            },
            failed_images: { type: "number" },
            average_saving_percent: { type: "number" },
            last_optimized_at: {
              anyOf: [{ type: "null" }, { type: "string" }],
            },
            active_job: { type: "boolean" },
            paused_plan_limit: { type: "boolean" },
            paused_plan_jobs: { type: "number" },
            active_bulk_jobs: {
              type: "object",
              properties: {
                product: { type: "boolean" },
                category: { type: "boolean" },
                brand: { type: "boolean" },
              },
            },
            active_bulk_restores: {
              type: "object",
              properties: {
                product: { type: "boolean" },
                category: { type: "boolean" },
                brand: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
};

const planSchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    description: { anyOf: [{ type: "null" }, { type: "string" }] },
    price: { type: "number" },
    currency: { type: "string" },
    monthly_image_limit: { anyOf: [{ type: "null" }, { type: "number" }] },
    is_active: { type: "boolean" },
    display_order: { type: "number" },
  },
};

const listPlansSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
};

const monthlyUsageHistorySchema = {
  querystring: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 60 },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};

const selectPlanSchema = {
  body: {
    type: "object",
    properties: {
      plan_slug: { type: "string", minLength: 1 },
      plan: { type: "string", minLength: 1 },
    },
    anyOf: [{ required: ["plan_slug"] }, { required: ["plan"] }],
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
};

const upgradePlanSchema = {
  body: {
    type: "object",
    properties: {
      plan_slug: { type: "string", minLength: 1 },
      plan: { type: "string", minLength: 1 },
    },
    anyOf: [{ required: ["plan_slug"] }, { required: ["plan"] }],
  },
  response: {
    200: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        code: { type: "string" },
        data: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
};

module.exports = {
  getChannelsSchema,
  getStoreOptimizationSettingsSchema,
  upsertStoreOptimizationSettingsSchema,
  registerProductCreatedWebhookSchema,
  disableProductCreatedWebhookSchema,
  registerCategoryCreatedWebhookSchema,
  disableCategoryCreatedWebhookSchema,
  getClientDashboardStatsSchema,
  listPlansSchema,
  selectPlanSchema,
  upgradePlanSchema,
  monthlyUsageHistorySchema,
};
