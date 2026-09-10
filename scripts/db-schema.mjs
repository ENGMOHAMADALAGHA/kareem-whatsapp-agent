// توليد prisma/schema.sql من schema.prisma — يحفظ بايتات خام دون تشويش ترميز الكونسل
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "prisma", "schema.sql");

// --from-empty لا يحتاج اتصالاً حقيقياً؛ نكتفي بكيان وهمي ليتخطى prisma.config.ts
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://wasl:wasl@localhost:5432/wasl";

const r = spawnSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
  { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
);

if (r.status !== 0) {
  console.error("فشل توليد المخطط:");
  process.stderr.write(r.stderr || Buffer.from(""));
  process.exit(1);
}

mkdirSync(join(root, "prisma"), { recursive: true });
writeFileSync(out, r.stdout);

// تحقق أن العربية سليمة (لا mojibake)
const s = r.stdout.toString("utf8");
if (s.includes("ودود ومهني")) {
  console.log(`تم توليد prisma/schema.sql (${r.stdout.length} bytes) — عربية سليمة ✅`);
} else {
  console.warn("تحذير: default سياسة النبرة لم يُعثر عليه بالناتج — راجع الملف يدوياً");
}