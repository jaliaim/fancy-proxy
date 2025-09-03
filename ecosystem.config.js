module.exports = {
  apps: [
    {
      name: 'simple-proxy',
      script: './.output/server/index.mjs',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        DISABLE_CACHE: 'true',
      },
    },
  ],
};