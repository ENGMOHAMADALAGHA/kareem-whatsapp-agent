// PM2 — تشغيل الإنتاج على RDP/VPS (بدل التشغيل اليدوي)
// الاستخدام:
//   npm i -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 startup   (انسخ الأمر الناتج ونفذه مرة واحدة)
//   pm2 save
// التحديث لاحقاً: git pull + pm2 restart wasl
module.exports = {
  apps: [
    {
      name: "wasl",
      script: "server.mjs",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      error_file: "./logs/wasl-error.log",
      out_file: "./logs/wasl-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
