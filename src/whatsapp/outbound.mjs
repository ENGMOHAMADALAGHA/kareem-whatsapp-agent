// ──────────────────────────────────────────────
// سياسة الإرسال الصادر: إعادة مع backoff أسّي + DLQ + تنبيهات
// - قابلة لإعادة الاستخدام من sender.mjs (لا تستورد sender لتجنب الدوائر).
// ──────────────────────────────────────────────
import { OUTBOUND_MAX_RETRIES, OUTBOUND_BASE_DELAY_MS } from "../config/env.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// هل الخطأ يستحق إعادة المحاولة؟ 429 + 5xx + أخطاء الشبكة/المهلة فقط.
export function isRetryableError(err) {
  const status = err?.status ?? err?.statusCode;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  const msg = String(err?.message || "").toLowerCase();
  if (/timeout|تجاوز المهلة|econn|enotfound|eai_again|socket|abort|fetch failed|network/i.test(msg)) return true;
  if (err?.code === "RATE_LIMITED") return true; // حدنا الداخلي — لحظي
  return false;
}

export function backoffDelay(attempt, baseMs = OUTBOUND_BASE_DELAY_MS) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(exp + jitter, 30000);
}

// نفّذ sendFn مع إعادة ذكية. عند الاستنفاد: سجّل DLQ ثم ارمِ الخطأ
// (المتصلون الحاليون يتوقعون throw — السلوك محفوظ).
export async function sendWithRetry(sendFn, opts = {}) {
  const max = opts.maxRetries ?? OUTBOUND_MAX_RETRIES;
  const label = opts.label || "outbound";
  let lastErr;
  for (let attempt = 1; attempt <= max + 1; attempt++) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableError(err);
      if (!retryable || attempt > max) break;
      const delay = backoffDelay(attempt, opts.baseMs);
      console.warn(`  ⚠️ [${label}] فشل قابل لإعادة المحاولة (محاولة ${attempt}/${max + 1}): ${err.message} — إعادة بعد ${delay}ms`);
      await sleep(delay);
    }
  }
  // DLQ: حدث نظامي + تنبيه في السجل (يستهلكه /admin/crm)
  try {
    const { logEvent } = await import("../../crm.mjs");
    await logEvent("outbound_dead_letter", {
      label,
      error: lastErr?.message,
      status: lastErr?.status ?? lastErr?.statusCode ?? null,
    }).catch(() => {});
  } catch { /* لا تكسر مسار الإرسال */ }
  console.error(`  ☠️ [${label}] DLQ بعد الاستنفاد: ${lastErr?.message}`);
  throw lastErr;
}

// تغليف اختيار الإرسال عبر طابور outbound (fire-and-forget مع DLQ موثق)
export async function enqueueOutbound(label, fn) {
  const { outboundQueue } = await import("../jobs/queue.mjs");
  return outboundQueue.enqueue(label, () => sendWithRetry(fn, { label }));
}
