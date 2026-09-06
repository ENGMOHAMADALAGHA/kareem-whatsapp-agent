// ──────────────────────────────────────────────
// طابور معالجة داخل العملية (واجهة جاهزة لـ BullMQ+Redis لاحقاً)
// - تزامن محدود: لا إغراق للـ AI/API
// - إعادة محاولة مع تأخير تصاعدي
// - رسائل ميتة موثقة (لا ضياع بصمت)
// ──────────────────────────────────────────────

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
      await runWithTimeout(job.fn, timeoutMs);
      done++;
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
      }
    } finally {
      running--;
      if (pending.length) setImmediate(pump);
    }
  }

  function runWithTimeout(fn, ms) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`تجاوز المهلة ${ms}ms`)), ms)),
    ]);
  }

  return {
    enqueue(label, fn) {
      pending.push({ label, fn, attempts: 0, at: Date.now() });
      setImmediate(pump);
      return pending.length;
    },
    stats() {
      return { queued: pending.length, running, done, dead, concurrency, retries };
    },
  };
}

// طابور الـ Webhook العام
import { logEvent } from "../../crm.mjs";

export const webhookQueue = createQueue({
  concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
  retries: Number(process.env.QUEUE_RETRIES || 2),
  timeoutMs: Number(process.env.QUEUE_TIMEOUT_MS || 60000),
  onDead: async (job, err) => {
    await logEvent("dead_letter", { label: job.label, error: err.message }).catch(() => {});
  },
});
