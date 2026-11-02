// Shared by queue/seat polling. Retry-After can exceed the local 30s backoff cap.
export function pollDelay(failures = 0, retryAfter = 0, random = Math.random) {
  const base = Math.min(30000, 3000 * 2 ** Math.min(Math.max(0, failures), 4));
  const jitter = Math.min(30000, Math.floor(base * (0.9 + random() * 0.2)));
  const serverWait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : 0;
  return Math.max(jitter, serverWait);
}
