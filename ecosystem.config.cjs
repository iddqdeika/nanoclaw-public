module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: 'start-nanoclaw.cjs',
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
