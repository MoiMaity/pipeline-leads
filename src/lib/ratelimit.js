/**
 * Fixed-window rate limiter kept in process memory.
 * Fine for a single free-tier instance; swap for Redis if the app is ever scaled out.
 */
const buckets = new Map();

export function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: max - bucket.count, retryAfter: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}

// Periodic cleanup so the map cannot grow unbounded.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref();
