import { performance } from 'node:perf_hooks';
import { AppError } from './store.mjs';

export const LIMIT_DEFAULTS = Object.freeze({ ipBurst: 120, ipPerSecond: 30, userBurst: 60, userPerSecond: 15,
  authAttempts: 30, authWindowMs: 600000, maxIps: 10000, maxUsers: 10000, maxAuthIps: 10000, idleMs: 600000 });
const envNames = { ipBurst: 'LIMIT_IP_BURST', ipPerSecond: 'LIMIT_IP_PER_SECOND', userBurst: 'LIMIT_USER_BURST',
  userPerSecond: 'LIMIT_USER_PER_SECOND', authAttempts: 'LIMIT_AUTH_ATTEMPTS', authWindowMs: 'LIMIT_AUTH_WINDOW_MS',
  maxIps: 'LIMIT_MAX_IPS', maxUsers: 'LIMIT_MAX_USERS', maxAuthIps: 'LIMIT_MAX_AUTH_IPS', idleMs: 'LIMIT_IDLE_MS' };
export function limitOptionsFromEnv(env = process.env) {
  const result = {};
  for (const [key, name] of Object.entries(envNames)) if (env[name] !== undefined) {
    if (!/^[1-9]\d*$/.test(env[name])) throw new Error(`${name}는 양의 정수여야 합니다.`);
    result[key] = Number(env[name]);
  }
  return result;
}
export class RequestLimitError extends AppError {
  constructor(waitMs, capacity = false) {
    super(429, capacity ? '요청 제한 저장 공간이 가득 찼습니다. 잠시 후 다시 이용해 주세요.' : '요청이 너무 많습니다. 잠시 후 다시 이용해 주세요.');
    this.code = capacity ? 'LIMITER_CAPACITY' : 'RATE_LIMITED';
    this.retryAfter = String(Math.max(1, Math.ceil(waitMs / 1000)));
  }
}
export class RequestLimiter {
  #ip = new Map(); #user = new Map(); #auth = new Map();
  #clock; #last = -Infinity; #nextSweep = 0;
  #config;
  constructor({ monotonic = () => performance.now(), ...options } = {}) {
    for (const key of Object.keys(options)) if (!Object.hasOwn(LIMIT_DEFAULTS, key)) throw new Error(`알 수 없는 요청 제한 설정: ${key}`);
    this.#config = Object.freeze({ ...LIMIT_DEFAULTS, ...options });
    for (const [key, value] of Object.entries(this.config)) {
      const max = key.endsWith('Ms') ? 3600000 : key.startsWith('max') ? 100000 : 1000000;
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key}는 1~${max}의 정수여야 합니다.`);
    }
    if (typeof monotonic !== 'function') throw new Error('제한 시계는 함수여야 합니다.');
    this.#clock = monotonic; this.#time();
  }
  get config() { return this.#config; }
  #time() {
    const now = this.#clock();
    if (!Number.isFinite(now)) throw new Error('유효하지 않은 제한 시각입니다.');
    return this.#last = Math.max(this.#last, now);
  }
  #sweep(now) {
    if (now < this.#nextSweep) return;
    this.#nextSweep = now + 1000;
    for (const [map, burst, rate] of [[this.#ip, this.config.ipBurst, this.config.ipPerSecond], [this.#user, this.config.userBurst, this.config.userPerSecond]]) {
      for (const [key, entry] of map) if (now - entry.at >= this.config.idleMs && entry.tokens + (now - entry.at) * rate / 1000 >= burst) map.delete(key);
    }
    for (const [key, entry] of this.#auth) if (entry.until <= now) this.#auth.delete(key);
  }
  #key(key) { if (typeof key !== 'string' || !key.length || key.length > 256) throw new Error('유효하지 않은 제한 키입니다.'); }
  #take(map, key, burst, rate, maxKeys) {
    this.#key(key);
    const now = this.#time(); this.#sweep(now);
    let entry = map.get(key);
    if (!entry) {
      if (map.size >= maxKeys) throw new RequestLimitError(1000, true);
      entry = { tokens: burst, at: now }; map.set(key, entry);
    }
    const tokens = Math.min(burst, entry.tokens + (now - entry.at) * rate / 1000);
    // Rejected calls don't move at: they neither extend retention nor reset credit.
    if (tokens + 1e-9 < 1) throw new RequestLimitError((1 - tokens) * 1000 / rate);
    entry.tokens = Math.max(0, tokens - 1); entry.at = now;
  }
  ip(address) { this.#take(this.#ip, address, this.config.ipBurst, this.config.ipPerSecond, this.config.maxIps); }
  user(id) { this.#take(this.#user, id, this.config.userBurst, this.config.userPerSecond, this.config.maxUsers); }
  auth(address) {
    this.#key(address);
    const now = this.#time(); this.#sweep(now);
    let entry = this.#auth.get(address);
    if (entry?.until <= now) { this.#auth.delete(address); entry = undefined; }
    if (!entry) {
      if (this.#auth.size >= this.config.maxAuthIps) throw new RequestLimitError(1000, true);
      entry = { count: 0, until: now + this.config.authWindowMs }; this.#auth.set(address, entry);
    }
    if (entry.count >= this.config.authAttempts) throw new RequestLimitError(entry.until - now);
    entry.count++;
  }
  sweep() { this.#sweep(this.#time()); }
  stats() { return { ips: this.#ip.size, users: this.#user.size, authIps: this.#auth.size }; }
  close() { this.#ip.clear(); this.#user.clear(); this.#auth.clear(); }
}
