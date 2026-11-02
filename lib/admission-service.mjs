import { AppError } from './store.mjs';

export class AdmissionService {
  constructor(store, queue) {
    this.store = store;
    this.queue = queue;
    // One startup read, before accepting requests. DB holds count even before
    // their owners reconnect; they never gain a fresh general admission lease.
    for (const hold of store.liveHolds()) queue.recoverHold(hold.performance_id, hold.user_id, hold);
  }
  enter(userId, performanceId, sessionKey, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'resumeHoldId') || (body.resumeHoldId !== undefined && (typeof body.resumeHoldId !== 'string' || !body.resumeHoldId.length))) throw new AppError(400, '대기열 요청 내용을 확인해 주세요.');
    const performance = this.store.openPerformance(performanceId);
    const hold = this.store.liveHolds(userId, performanceId)[0];
    if (body.resumeHoldId !== undefined && body.resumeHoldId !== hold?.id) throw new AppError(409, '복구할 유효한 본인 선점을 찾을 수 없습니다.');
    if (hold) this.queue.recoverHold(performanceId, userId, hold);
    else this.queue.unpin(performanceId, userId);
    return this.queue.enter(performanceId, userId, { sessionKey, closesAt: performance.starts_at });
  }
  status(userId, performanceId, sessionKey) {
    return this.queue.status(performanceId, userId, { sessionKey });
  }
  leave(userId, performanceId) {
    const hold = this.store.liveHolds(userId, performanceId)[0];
    if (hold) this.queue.recoverHold(performanceId, userId, hold);
    else this.queue.unpin(performanceId, userId);
    return this.queue.leave(performanceId, userId);
  }
  setHold(userId, performanceId, ids, sessionKey, token) {
    const performance = this.store.performance(performanceId);
    const result = this.store.setHold(userId, performanceId, ids, {
      authorize: () => this.queue.authorize(performanceId, userId, sessionKey, token, { action: 'hold' })
    });
    if (result.hold) this.queue.pinHold(performanceId, userId, { ...result.hold, expires_at: Math.min(result.hold.expires_at, performance.starts_at) });
    else this.queue.unpin(performanceId, userId);
    return result;
  }
  checkout(userId, data, sessionKey, token, idempotencyKey) {
    const booking = this.store.checkout(userId, data, { idempotencyKey,
      authorize: hold => this.queue.authorize(hold.performance_id, userId, sessionKey, token, { action: 'checkout', holdId: hold.id })
    });
    this.queue.completeHold(booking.performance_id, userId, booking.hold_id);
    return booking;
  }
}
