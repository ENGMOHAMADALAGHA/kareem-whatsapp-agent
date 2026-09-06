import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma = null;

export function isDbEnabled() {
  return !!process.env.DATABASE_URL;
}

function normalizedUrl() {
  let url = process.env.DATABASE_URL || "";
  // وضع pgbouncer لاتصالات الـ pooler (منفذ 6543)
  if (url.includes(":6543/") && !url.includes("pgbouncer=")) {
    url += (url.includes("?") ? "&" : "?") + "pgbouncer=true&connection_limit=1";
  }
  return url;
}

export function db() {
  if (!prisma) {
    if (!isDbEnabled()) return null;
    const adapter = new PrismaPg({ connectionString: normalizedUrl() });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

// تنظيف الرسائل الأقدم من N يوم (تُستدعى من المجدول)
export async function pruneOldMessages(days = 30) {
  if (!isDbEnabled()) return 0;
  const r = await db().message.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
  });
  return r.count || 0;
}
