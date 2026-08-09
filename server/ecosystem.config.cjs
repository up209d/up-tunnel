module.exports = {
  apps: [
    {
      name: "uptunnel",
      script: "dist/index.js",
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
      },
      // Optional: Restart the app if it uses more than 500MB of memory
      max_memory_restart: "500M",
      // Optional: Delay between automatic restarts
      restart_delay: 2000,
    }
  ]
};
