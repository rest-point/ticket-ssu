import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from './store.mjs';

export const QUEUE_DEFAULTS = Object.freeze({
  activeLimit: 50,
  admitPerSecond: 5,
  maxWaiting: 1000,
  maxTotal: 10000,
  maxPerformances: 100,
  waitIdleMs: 30000,
  admissionMs: 120000
});
const bounds = {
  activeLimit: [1, 10000], admitPerSecond: [1, 10000], maxWaiting: [1, 100000],
  maxTotal: [1, 100000], maxPerformances: [1, 10000],
  waitIdleMs: [1, 3600000], admissionMs: [1, 3600000]
};
const envNames = {
  activeLimit: 'QUEUE_ACTIVE_LIMIT', admitPerSecond: 'QUEUE_ADMIT_PER_SECOND',
  maxWaiting: 'QUEUE_MAX_WAITING', maxTotal: 'QUEUE_MAX_TOTAL',
  maxPerformances: 'QUEUE_MAX_PERFORMANCES', waitIdleMs: 'QUEUE_WAIT_IDLE_MS',
  admissionMs: 'QUEUE_ADMISSION_MS'
};

export function queueOptionsFromEnv(env = process.env) {
  const options = {};
  for (const [key, name] of Object.entries(envNames)) {
    if (env[name] === undefined) continue;
    if (!/^[1-9]\d*$/.test(env[name])) throw new Error(`${name}는 양의 정수여야 합니다.`);
    options[key] = Number(env[name]);
  }
  return options;
}
export class QueueError extends AppError {
  constructor(status, message) {
    super(status, message);
    if (status === 429) this.retryAfter = '1';
    this.code = ({ 400: 'INVALID_INPUT', 403: 'ADMISSION_REQUIRED', 404: 'QUEUE_NOT_FOUND', 429: 'QUEUE_CAPACITY', 503: 'QUEUE_UNAVAILABLE' })[status];
  }
}
const identifier = value => {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value.trim() !== value) throw new QueueError(400, '회차와 회원 식별자를 확인해 주세요.');
};

// Every state transition is synchronous: never await between allocation steps.
export class PerformanceQueue {
  #groups = new Map();
  #entries = 0;
  #sequence = 0;
  #lastTime = -Infinity;
  #closed = false;
  #now;
  #monotonic;
  #config;
  #restartEpoch = randomUUID();

  constructor({ now = Date.now, monotonic = () => performance.now(), ...options } = {}) {
    for (const key of Object.keys(options)) if (!Object.hasOwn(bounds, key)) throw new Error(`알 수 없는 큐 설정: ${key}`);
    this.#config = Object.freeze({ ...QUEUE_DEFAULTS, ...options });
    for (const [key, [min, max]] of Object.entries(bounds)) {
      const value = this.config[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key}는 ${min}~${max}의 정수여야 합니다.`);
    }
    if (typeof now !== 'function' || typeof monotonic !== 'function') throw new Error('큐 시계는 함수여야 합니다.');
    this.#now = now;
    this.#monotonic = monotonic;
    this.#time();
  }
  get config() { return this.#config; }
  get restartEpoch() { return this.#restartEpoch; }

  #time() {
    if (this.#closed) throw new QueueError(503, '대기열이 종료되었습니다.');
    const value = this.#monotonic(), wall = this.#now();
    if (!Number.isFinite(value) || !Number.isSafeInteger(wall) || wall < 0) throw new Error('유효하지 않은 큐 시각입니다.');
    // Monotonic time governs expiry/rate; wall-clock adjustments only affect DTOs.
    this.#lastTime = Math.max(this.#lastTime, value);
    return { time: this.#lastTime, wall };
  }
  #remove(group, entry) {
    group.members.delete(entry.userId);
    group.waiting.delete(entry.userId);
    group.active.delete(entry.userId);
    this.#entries--;
  }
  #expire(group, time, wall) {
    for (const entry of group.members.values()) if (entry.closesAt <= wall || entry.deadline <= time && !(entry.pin?.expires_at > wall)) this.#remove(group, entry);
    group.admissions = group.admissions.filter(at => at > time - 1000);
  }
  #promote(group, time) {
    while (group.waiting.size && group.active.size < this.config.activeLimit && group.admissions.length < this.config.admitPerSecond) {
      const entry = group.waiting.values().next().value;
      group.waiting.delete(entry.userId);
      entry.state = 'admitted';
      entry.deadline = time + this.config.admissionMs;
      entry.token = entry.sessionKey ? randomBytes(32).toString('hex') : null;
      group.active.set(entry.userId, entry);
      group.admissions.push(time);
    }
  }
  #reclaim(id, group) {
    // Retain the last second of rate history even when all members leave.
    if (!group.members.size && !group.admissions.length) this.#groups.delete(id);
  }
  #status(id, group, entry, { time, wall }) {
    let position = 0;
    if (entry.state === 'waiting') for (const member of group.waiting.values()) {
      position++;
      if (member === entry) break;
    }
    return {
      performance_id: id, entry_id: entry.id, sequence: entry.sequence,
      state: entry.state, position, ahead: Math.max(0, position - 1),
      estimated_wait_ms: entry.state === 'admitted' ? 0 : null,
      entry_expires_at: Math.min(Math.max(wall + Math.max(0, Math.ceil(entry.deadline - time)), entry.pin?.expires_at ?? 0), entry.closesAt ?? Infinity),
      server_now: wall, restart_epoch: this.restartEpoch,
      admission_token: entry.state === 'admitted' ? entry.token ?? null : null,
      admission_expires_at: entry.state === 'admitted' ? Math.min(entry.recovery || time >= entry.deadline ? entry.pin?.expires_at ?? wall : wall + Math.ceil(entry.deadline - time), entry.closesAt ?? Infinity) : null,
      mode: entry.recovery || time >= entry.deadline && entry.pin ? 'hold-recovery' : 'general'
    };
  }
  #bind(entry, sessionKey) {
    if (sessionKey !== undefined && entry.sessionKey !== sessionKey) {
      entry.sessionKey = sessionKey;
      entry.token = entry.state === 'admitted' ? randomBytes(32).toString('hex') : null;
    }
  }

  enter(performanceId, userId, { sessionKey, closesAt } = {}) {
    identifier(performanceId); identifier(userId);
    const clock = this.#time();
    let group = this.#groups.get(performanceId);
    if (group) {
      this.#expire(group, clock.time, clock.wall);
      const existing = group.members.get(userId);
      if (existing) {
        if (closesAt !== undefined) existing.closesAt = closesAt;
        this.#bind(existing, sessionKey);
        if (existing.state === 'waiting') existing.deadline = clock.time + this.config.waitIdleMs;
        this.#promote(group, clock.time);
        return this.#status(performanceId, group, existing, clock);
      }
      this.#promote(group, clock.time); // Older waiters always consume slots first.
    }
    // Bound all queues, including buckets retained briefly for rate history.
    if (this.#entries >= this.config.maxTotal || (!group && this.#groups.size >= this.config.maxPerformances)) {
      this.#sweep(clock.time, clock.wall);
      group = this.#groups.get(performanceId);
    }
    if (this.#entries >= this.config.maxTotal || (!group && this.#groups.size >= this.config.maxPerformances) || (group && group.waiting.size >= this.config.maxWaiting)) throw new QueueError(429, '대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.');
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) throw new QueueError(503, '대기 순번을 발급할 수 없습니다.');
    if (!group) {
      group = { members: new Map(), waiting: new Map(), active: new Map(), admissions: [] };
      this.#groups.set(performanceId, group);
    }
    const entry = { id: randomUUID(), userId, sequence: ++this.#sequence, state: 'waiting', deadline: clock.time + this.config.waitIdleMs, sessionKey, token: null, closesAt };
    group.members.set(userId, entry);
    group.waiting.set(userId, entry);
    this.#entries++;
    this.#promote(group, clock.time);
    return this.#status(performanceId, group, entry, clock);
  }

  status(performanceId, userId, { sessionKey } = {}) {
    identifier(performanceId); identifier(userId);
    const clock = this.#time(), group = this.#groups.get(performanceId);
    if (!group) throw new QueueError(404, '현재 대기 항목을 찾을 수 없습니다.');
    this.#expire(group, clock.time, clock.wall);
    const entry = group.members.get(userId);
    if (entry && sessionKey !== undefined && entry.sessionKey !== sessionKey) throw new QueueError(403, '현재 로그인 세션으로 대기열에 다시 접속해 주세요.');
    if (entry?.state === 'waiting') entry.deadline = clock.time + this.config.waitIdleMs;
    this.#promote(group, clock.time);
    this.#reclaim(performanceId, group);
    if (!entry) throw new QueueError(404, '현재 대기 항목을 찾을 수 없습니다.');
    return this.#status(performanceId, group, entry, clock);
  }

  leave(performanceId, userId) {
    identifier(performanceId); identifier(userId);
    const { time, wall } = this.#time(), group = this.#groups.get(performanceId);
    if (group) {
      this.#expire(group, time, wall);
      const entry = group.members.get(userId);
      if (entry?.pin?.expires_at > wall) {
        entry.recovery = true;
        entry.deadline = time;
        entry.sessionKey = null;
        entry.token = null;
      } else if (entry) this.#remove(group, entry);
      this.#promote(group, time);
      this.#reclaim(performanceId, group);
    }
    return { ok: true };
  }

  tick() {
    const { time, wall } = this.#time();
    this.#sweep(time, wall);
  }
  #sweep(time, wall) {
    for (const [id, group] of this.#groups) {
      this.#expire(group, time, wall);
      this.#promote(group, time);
      this.#reclaim(id, group);
    }
  }
  // Only the server may reserve an already verified, occupied DB hold. Restored
  // holds can exceed activeLimit, but never the total/bucket memory limits.
  recoverHold(performanceId, userId, hold) {
    const clock = this.#time();
    let group = this.#groups.get(performanceId), entry = group?.members.get(userId);
    if (!entry) {
      if (this.#entries >= this.config.maxTotal || (!group && this.#groups.size >= this.config.maxPerformances)) throw new QueueError(503, '유효 선점을 복구할 대기열 상한이 부족합니다. 큐 설정을 확인해 주세요.');
      if (!group) {
        group = { members: new Map(), waiting: new Map(), active: new Map(), admissions: [] };
        this.#groups.set(performanceId, group);
      }
      entry = { id: randomUUID(), userId, sequence: ++this.#sequence, state: 'admitted', deadline: clock.time, recovery: true, sessionKey: null, token: null };
      group.members.set(userId, entry);
      group.active.set(userId, entry);
      this.#entries++;
    } else if (entry.state === 'waiting') {
      group.waiting.delete(userId);
      entry.state = 'admitted'; entry.recovery = true; entry.deadline = clock.time;
      entry.token = entry.sessionKey ? randomBytes(32).toString('hex') : null;
      group.active.set(userId, entry);
    }
    entry.pin = { id: hold.id, expires_at: hold.expires_at };
  }
  pinHold(performanceId, userId, hold) {
    // Called immediately after the DB commit, without yielding or expiring the
    // authorized entry: a clock boundary after COMMIT must not turn success into an error.
    const entry = this.#groups.get(performanceId)?.members.get(userId);
    if (!entry || entry.state !== 'admitted') throw new Error('선점 정원 연결이 없습니다.');
    entry.pin = { id: hold.id, expires_at: hold.expires_at };
  }
  unpin(performanceId, userId) {
    const clock = this.#time(), group = this.#groups.get(performanceId), entry = group?.members.get(userId);
    if (!entry) return;
    entry.pin = null;
    if (entry.recovery || entry.deadline <= clock.time) this.#remove(group, entry);
    this.#promote(group, clock.time);
    this.#reclaim(performanceId, group);
  }
  completeHold(performanceId, userId, holdId) {
    const entry = this.#groups.get(performanceId)?.members.get(userId);
    if (entry?.pin?.id !== holdId) return;
    this.unpin(performanceId, userId);
    this.leave(performanceId, userId);
  }
  authorize(performanceId, userId, sessionKey, token, { action, holdId } = {}) {
    const clock = this.#time(), group = this.#groups.get(performanceId);
    if (group) this.#expire(group, clock.time, clock.wall);
    const entry = group?.members.get(userId);
    if (!entry || entry.state !== 'admitted' || entry.sessionKey !== sessionKey || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !entry.token || !timingSafeEqual(Buffer.from(token), Buffer.from(entry.token))) throw new QueueError(403, '유효한 입장권이 필요합니다. 대기열 상태를 확인해 주세요.');
    if ((entry.recovery || clock.time >= entry.deadline) && !(action === 'checkout' && entry.pin?.id === holdId && entry.pin.expires_at > clock.wall)) throw new QueueError(403, '입장 시간이 끝났습니다. 현재 선점의 확정 또는 전체 해제만 가능합니다.');
  }
  revokeSession(sessionKey) {
    for (const [id, group] of this.#groups) for (const entry of group.members.values()) {
      if (entry.sessionKey === sessionKey) this.leave(id, entry.userId);
    }
  }
  removeUser(userId) {
    const { time } = this.#time();
    for (const [id, group] of this.#groups) {
      const entry = group.members.get(userId);
      if (entry) this.#remove(group, entry);
      this.#promote(group, time);
      this.#reclaim(id, group);
    }
  }
  removePerformance(performanceId) {
    const group = this.#groups.get(performanceId);
    if (!group) return;
    this.#entries -= group.members.size;
    this.#groups.delete(performanceId);
  }
  stats() {
    let waiting = 0, admitted = 0;
    for (const group of this.#groups.values()) { waiting += group.waiting.size; admitted += group.active.size; }
    return { performances: this.#groups.size, entries: this.#entries, waiting, admitted };
  }
  close() {
    this.#closed = true;
    this.#groups.clear();
    this.#entries = 0;
  }
}
