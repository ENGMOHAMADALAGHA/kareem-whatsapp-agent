// ──────────────────────────────────────────────
// حد المعدل (ذاكرة محلية — تُستبدل بـ Redis عند التوسع)
// ──────────────────────────────────────────────
const buckets = new Map(); // key -> [timestamps]

function prune(key, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  buckets.set(key, arr);
  if (buckets.size > 5000) {
    // تنظيف عام عند التضخم
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
      if (buckets.size < 4000) break;
    }
  }
  return arr;
}

export function checkLimit(key, max, windowMs) {
  const arr = prune(key, windowMs);
  if (arr.length >= max) {
    const retryAfter = Math.ceil((arr[0] + windowMs - Date.now()) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }
  arr.push(Date.now());
  return { allowed: true, retryAfter: 0 };
}

export function loginKey(tenantId, phone, ip) {
  return `login:${tenantId}:${phone}:${ip}`;
}

export function senderKey(phone) {
  return `sender:${phone}`;
}

export function tenantSendKey(tenantId) {
  return `tSend:${tenantId}`;
}
