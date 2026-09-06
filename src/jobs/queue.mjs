// ──────────────────────────────────────────────
// طابور معالجة (واجهة موحدة: BullMQ+Redis عند توفرهما، وإلا ذاكرة العملية)
// - نفس الـ API في الحالتين: enqueue(label, fn) + run(label, fn) + stats()
// - BullMQ: jobId = label يمنع تكرار نفس الرسالة (wamid) حتى بعد restart.
// ──────────────────────────────────────────────
import { VOICE_QUEUE_CONCURRENCY } from "../config/env.mjs";

export function createQueue({ concurrency = 5, retries = 2, timeoutMs = 60000, onDead = null } = {}) {
  const pending = [];
  let running = 0;
  let done = 0;
  let dead = 0;

  async function pump() {
    if (running >= concurrency) return;
    const job = pending.shift();
    if (!job) return;
    running++;
    try {
      const out = await runWithTimeout(job.fn, timeoutMs);
      done++;
      job.done?.(out);
    } catch (err) {
      job.attempts++;
      if (job.attempts <= retries) {
        const delay = 1000 * job.attempts * job.attempts;
        console.warn(`  ⚠️ إعادة [${job.label}] محاولة ${job.attempts} بعد ${delay}ms: ${err.message}`);
        setTimeout(() => {
          pending.unshift(job);
          pump();
        }, delay);
      } else {
        dead++;
        console.error(`  ☠️ رسالة ميتة [${job.label}] بعد ${job.attempts} محاولات: ${err.message}`);
        try {
          await onDead?.(job, err);
        } catch (e) {
          console.error(`  ⚠️ خطأ onDead: ${e.message}`);
        }
        job.fail?.(err);
      }
    } finally {
      running--;
      if (pending.length) setImmediate(pump);
    }
  }

  function runWithTimeout(fn, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`تجاوز المهلة ${ms}ms`)), ms);
    });
    return Promise.resolve().then(() => Promise.race([fn(), timeout])).finally(() => clearTimeout(timer));
  }

  return {
    enqueue(label, fn) {
      pending.push({ label, fn, attempts: 0, at: Date.now() });
      setImmediate(pump);
      return pending.length;
    },
    // شغّل مهمة وانتظر نتيجتها (للاستخدام داخل معالج آخر، مثل طابور الفويس)
    run(label, fn) {
      return new Promise((resolve, reject) => {
        pending.push({
          label, fn, attempts: 0, at: Date.now(),
          done: resolve, fail: reject,
        });
        setImmediate(pump);
      });
    },
    stats() {
      return { queued: pending.length, running, done, dead, concurrency, retries, backend: "memory" };
    },
  };
}

// ── طابور دائم: BullMQ+Redis عند توفرهما، وإلا نفس طابور الذاكرة ──
// ملاحظة: دوال BullMQ لا يمكن تسلسلها (closures) عبر Redis، لذلك يعمل
// مسار BullMQ كقفل توزيعي + dedup عبر jobId، بينما التنفيذ يبقى محلياً.
// عند غياب bullmq/ioredis/REDIS_URL → رجوع صامت لطابور الذاكرة.
export function createDurableQueue(name, opts = {}) {
  const mem = createQueue(opts);
  let bridge = null; // { queue, events } عند توفر BullMQ
  let warned = false;

  async function bullmq() {
    if (bridge !== undefined && bridge !== null) return bridge;
    if (bridge === undefined) return null;
    try {
      const { getRedis } = await import("./redisClient.mjs");
      const redis = await getRedis();
      if (!redis) { bridge = undefined; return null; }
      const { Queue } = await import("bullmq");
      const queue = new Queue(name, { connection: redis.duplicate?.() || redis });
      bridge = { queue };
      console.log(`  📦 طابور دائم [${name}] عبر BullMQ`);
      return bridge;
    } catch (e) {
      if (!warned) {
        console.warn(`  ⚠️ BullMQ غير متاح لطابور [${name}] (${e.message?.slice(0, 80)}) — وضع الذاكرة`);
        warned = true;
      }
      bridge = undefined;
      return null;
    }
  }
  // محاولة اتصال كسولة غير حاجبة
  bullmq().catch(() => {});

  return {
    // fire-and-forget (نفس سلوك createQueue) + حجز jobId دائم عند توفر BullMQ
    enqueue(label, fn) {
      bullmq().then(async (b) => {
        if (!b) return;
        try {
          await b.queue.add(name, { label, at: Date.now() }, {
            jobId: `${name}:${label}`,
            removeOnComplete: 100,
            removeOnFail: 200,
          });
        } catch {
          // تكرار jobId = رسالة مكررة — تجاهل بصمت (حماية من إعادة Meta)
        }
      }).catch(() => {});
      return mem.enqueue(label, fn);
    },
    run(label, fn) {
      return mem.run(label, fn);
    },
    stats() {
      const s = mem.stats();
      s.durable = bridge ? true : false;
      s.name = name;
      return s;
    },
  };
}

// طابور الـ Webhook العام (دائم عند توفر Redis)
import { logEvent } from "../../crm.mjs";

const deadToCrm = (where) => async (job, err) => {
  await logEvent("dead_letter", { where, label: job.label, error: err.message }).catch(() => {});
  console.error(`  ☠️ [${where}] DLQ: ${job.label} — ${err.message}`);
};

export const webhookQueue = createDurableQueue("webhooks", {
  concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
  retries: Number(process.env.QUEUE_RETRIES || 2),
  timeoutMs: Number(process.env.QUEUE_TIMEOUT_MS || 60000),
  onDead: deadToCrm("webhooks"),
});

// طابور الفويس المخصص (تزامن منخفض = 2)
export const voiceQueue = createDurableQueue("voice", {
  concurrency: VOICE_QUEUE_CONCURRENCY,
  retries: 1,
  timeoutMs: Number(process.env.QUEUE_TIMEOUT_MS || 60000),
  onDead: deadToCrm("voice"),
});

// طابور الإرسال الصادر (إعادة إرسال رسائل واتساب الفاشلة)
export const outboundQueue = createDurableQueue("outbound", {
  concurrency: 3,
  retries: 0, // إعادة المحاولة يديرها outbound.mjs نفسه ( backoff مخصص لـ 429/5xx )
  timeoutMs: Number(process.env.OUTBOUND_TIMEOUT_MS || 15000) + 5000,
  onDead: deadToCrm("outbound"),
});
