module.exports = {
  apps: [
    {
      name: "image-optimizer-api",
      cwd: __dirname,
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },

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

    {
      name: "catalog-fetch",
      cwd: __dirname,
      script: "npm",
      args: "run worker:catalog-fetch",
      instances: 1,
      exec_mode: "fork",
    },

    // Brand workers — uncomment when brand optimization/restore is needed
    // {
    //   name: "brand-image",
    //   cwd: __dirname,
    //   script: "npm",
    //   args: "run worker:brand-image",
    //   instances: 1,
    //   exec_mode: "fork",
    // },
    // {
    //   name: "brand-image-restore",
    //   cwd: __dirname,
    //   script: "npm",
    //   args: "run worker:brand-image-restore",
    //   instances: 1,
    //   exec_mode: "fork",
    // },
  ],
};
