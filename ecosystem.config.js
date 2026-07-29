/** PM2 workers only — API/backend runs separately. Product + category workers. */
module.exports = {
  apps: [
    // --- Product optimization ---
    {
      name: "optimization-heavy-supervisor",
      cwd: __dirname,
      script: "npm",
      args: "run worker:optimization-heavy-supervisor",
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "image-optimization-2",
      cwd: __dirname,
      script: "npm",
      args: "run worker:image-optimization-2",
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "image-optimization-3",
      cwd: __dirname,
      script: "npm",
      args: "run worker:image-optimization-3",
      instances: 1,
      exec_mode: "fork",
    },

    // --- Product restore ---
    {
      name: "restore-heavy-supervisor",
      cwd: __dirname,
      script: "npm",
      args: "run worker:restore-heavy-supervisor",
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "image-restore-2",
      cwd: __dirname,
      script: "npm",
      args: "run worker:image-restore-2",
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "image-restore-3",
      cwd: __dirname,
      script: "npm",
      args: "run worker:image-restore-3",
      instances: 1,
      exec_mode: "fork",
    },

    // --- Category workers ---
    {
      name: "category-image",
      cwd: __dirname,
      script: "npm",
      args: "run worker:category-image",
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "category-image-restore",
      cwd: __dirname,
      script: "npm",
      args: "run worker:category-image-restore",
      instances: 1,
      exec_mode: "fork",
    },

    // --- Bulk catalog fetch (product optimize-all) ---
    {
      name: "catalog-fetch",
      cwd: __dirname,
      script: "npm",
      args: "run worker:catalog-fetch",
      instances: 1,
      exec_mode: "fork",
    },
  ],
};
