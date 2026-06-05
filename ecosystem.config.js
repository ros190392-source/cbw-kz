// PM2 process manager config for CBW KZ (EPIC 011).
// Usage:
//   npm run start    → pm2 start ecosystem.config.js
//   npm run status   → pm2 status
//   npm run logs     → pm2 logs cbw-kz-bot
//   npm run restart  → pm2 restart cbw-kz-bot
//   npm run stop     → pm2 stop cbw-kz-bot
//
// Runs the long-running Telegram bot (the only persistent process). The bot
// itself is human-gated: no auto-publishing or auto-approval is introduced here.
module.exports = {
  apps: [
    {
      name: 'cbw-kz-bot',
      // Run via tsx (TypeScript) without a build step.
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'apps/telegram-bot/index.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
