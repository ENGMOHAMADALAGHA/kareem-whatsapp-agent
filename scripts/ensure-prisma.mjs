// postinstall المتسامح: يولد Prisma Client عندما تتوفر DATABASE_URL،
// وإلا يمرّ بصمت (قواعد تطوير بلا متغيرات لا تكسر npm install)
import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.log("⚠️  DATABASE_URL غير موجود — نتخطى prisma generate (add .env لاحقاً وشغّل npm rebuild)");
  process.exit(0);
}

const r = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "generate"], { stdio: "inherit" });
process.exit(r.status ?? 1);