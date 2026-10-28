/**
 * In-memory sliding window. One process, small tenant count.
 * Restarts clear the counters.
 */

const WINDOW_MS = 60_000;

export const HTTP_LIMIT_PER_MINUTE = 180;
export const CHAT_LIMIT_PER_MINUTE = 30;

const buckets = new Map<string, number[]>();

export function consumeRateLimit(
  key: string,
  limit: number,
  now = Date.now(),
): { allowed: boolean; retryAfterSec: number } {
  const cutoff = now - WINDOW_MS;
  const stamps = (buckets.get(key) ?? []).filter((stamp) => stamp > cutoff);
  if (stamps.length >= limit) {
    buckets.set(key, stamps);
    const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimits(): void {
  buckets.clear();
}
