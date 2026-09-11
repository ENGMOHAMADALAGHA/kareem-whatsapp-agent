// اختبارات وحدات حرجة — node:test + assert أصيل (بلا مكتبات خارجية)
// التشغيل: node --test test/  (أو npm test)
import assert from "node:assert/strict";
import { test } from "node:test";

// مفتاح تشفير تجريبي قبل تحميل secrets/env (dotenv لا يتجاوز ما هو مضبوط)
process.env.TOKEN_ENC_KEY = "unit-test-key-123";

const { ammanDateStr } = await import("../src/utils/time.mjs");
const { detectTotal, detectItem } = await import("../orders.mjs");
const { encryptSecret, decryptSecret } = await import("../src/security/secrets.mjs");
const { createQueue } = await import("../src/jobs/queue.mjs");
const { csrfGuard } = await import("../src/web/middleware.mjs");

const KAREEM = {
  deliveryFee: 5,
  products: [
    { name: "حذاء ركض", price: 50 },
    { name: "حذاء شتوي", price: 40 },
    { name: "حزام ظهر", price: 20 },
  ],
  bundleOffer: { enabled: true, price: 70 },
};

function ammanRef(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// ── توقيت عمّان ──
test("ammanDateStr: اليوم والغد في منطقة عمّان", () => {
  assert.equal(ammanDateStr(0), ammanRef(0));
  assert.equal(ammanDateStr(1), ammanRef(1));
  assert.equal(ammanDateStr(-1), ammanRef(-1));
});

// ── detectItem: تطابق الاسم الكامل أولاً ──
test("detectItem: يفضّل التطابق الكامل على الكلمة الأولى المشتركة", () => {
  assert.equal(detectItem(KAREEM, "أريد حذاء ركض", ""), "حذاء ركض");
  assert.equal(detectItem(KAREEM, "حزام ظهر", ""), "حزام ظهر");
});
test("detectItem: سلعتان متنازعتان على كلمة أولى → يُدمج الكاملتان", () => {
  const r = detectItem(KAREEM, "بين حذاء ركض و حذاء شتوي", "");
  assert.ok(r.includes("حذاء ركض") && r.includes("حذاء شتوي"));
});
test("detectItem: بلا ذكر سلعة → جميع المنتجات", () => {
  const r = detectItem(KAREEM, "مرحبا", "");
  assert.ok(r.includes("حذاء ركض") && r.includes("حزام ظهر"));
});

// ── detectTotal: مرتكز الكتالوج ──
test("detectTotal: إجمالي صريح مطابق للسلعة المختارة", () => {
  assert.equal(detectTotal(KAREEM, "منتجاتك", "حذاء ركض الإجمالي 55 د.أ"), 55);
});
test("detectTotal: مبلغ أجنبي من عرض جنبي يُصحَّح لسلعة المختارة", () => {
  assert.equal(detectTotal(KAREEM, "أريد حزام ظهر", "الإجمالي 100 د.أ"), 25);
});
test("detectTotal: bundle صريح مع التفعيل", () => {
  assert.equal(detectTotal(KAREEM, "الحذاء والحزام", "الإجمالي 70 د.أ"), 70);
});
test("detectTotal: أرقام النص اللصيقة بالكتالوج", () => {
  assert.equal(detectTotal(KAREEM, "بكم الحزام؟ 20 د.أ", ""), 25);
  assert.equal(detectTotal(KAREEM, "بكم الحذاء؟ 50", ""), 55);
});
test("detectTotal: بلا أرقام → القيمة الأقصى المعروفة", () => {
  assert.equal(detectTotal(KAREEM, "مرحبا", ""), 55);
});

// ── تشفير الأسرار ──
test("encrypt/decrypt: جولة ذهاب وإياب بصيغة enc:v1", () => {
  const enc = encryptSecret("TOKEN-XYZ");
  assert.ok(enc.startsWith("enc:v1:"));
  assert.notEqual(enc, "TOKEN-XYZ");
  assert.equal(decryptSecret(enc), "TOKEN-XYZ");
});
test("encrypt: القيم الفارغة تُرجع null", () => {
  assert.equal(encryptSecret(null), null);
  assert.equal(encryptSecret(""), null);
});
test("decrypt: سجلات قديمة plaintext تُقرأ شفافاً (ممر هجرة)", () => {
  assert.equal(decryptSecret("old-plain-token"), "old-plain-token");
});

// ── الطابور: FIFO/إعادة محاولة/مهلة ──
test("queue: enqueueOrdered يحافظ على الترتيب لكل مفتاح", async () => {
  const q = createQueue({ concurrency: 1 });
  const order = [];
  await Promise.all([
    q.enqueueOrdered("a", "t1", async () => { order.push(1); }),
    q.enqueueOrdered("a", "t2", async () => { order.push(2); }),
    q.enqueueOrdered("a", "t3", async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});
test("queue: إعادة محاولة حتى النجاح", async () => {
  const q = createQueue({ retries: 1 });
  let n = 0;
  const ok = await q.run("retry", async () => {
    n++;
    if (n < 2) throw new Error("عابر");
    return "تم";
  });
  assert.equal(ok, "تم");
  assert.ok(n >= 2);
});
test("queue: تجاوز المهلة يرفض ولن يعلّق العامل", async () => {
  const q = createQueue({ timeoutMs: 40, retries: 0 });
  const v = q.run("hang", () => new Promise(() => {}));
  await assert.rejects(v, /المهلة/);
  // بعجلة المعالجة ما زالت حية تجيب وظيفة لاحقة
  const after = await q.run("after", async () => "حيا");
  assert.equal(after, "حيا");
});

// ── CSRF guard ──
function fake() {
  const res = {
    code: null,
    status(c) { this.code = c; return { json: () => {} }; },
  };
  return res;
}
test("csrfGuard: cross-site مرفوض", () => {
  const res = fake();
  csrfGuard(
    { method: "POST", path: "/x", headers: { "sec-fetch-site": "cross-site", host: "k.com" } },
    res,
    () => assert.fail("لا يجب أن يمر")
  );
  assert.equal(res.code, 403);
});
test("csrfGuard: Origin متطابق يمر، Meta بلا Origin يمر", () => {
  let called = 0;
  csrfGuard({ method: "POST", path: "/x", headers: { origin: "https://k.com", host: "k.com" } }, fake(), () => called++);
  csrfGuard({ method: "POST", path: "/webhook", headers: {} }, fake(), () => called++);
  assert.equal(called, 2);
});
test("csrfGuard: Origin مخالف يرفض", () => {
  const res = fake();
  csrfGuard(
    { method: "PATCH", path: "/x", headers: { origin: "https://evil.com", host: "k.com" } },
    res,
    () => assert.fail("لا يجب أن يمر")
  );
  assert.equal(res.code, 403);
});