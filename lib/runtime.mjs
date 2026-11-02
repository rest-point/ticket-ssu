export function runtimeOptionsFromEnv(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
      throw new Error(`${key}는 ${min}~${max}의 정수여야 합니다.`);
    }
    return Number(raw);
  };
  const host = env.HOST ?? '127.0.0.1';
  if (typeof host !== 'string' || !host.length || host.trim() !== host || /[\s/\\]/.test(host)) throw new Error('HOST를 확인해 주세요.');
  return { host, port: integer('PORT', 3000, 0, 65535), shutdownMs: integer('SHUTDOWN_TIMEOUT_MS', 10000, 1, 60000) };
}
