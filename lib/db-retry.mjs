import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { AppError } from './store.mjs';

export const API_BUSY_TIMEOUT_MS = 25;
export const isDatabaseBusy = error => error?.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode) && (error.errcode & 255) === 5;
export class DatabaseBusyError extends AppError {
  constructor() {
    super(503, '데이터베이스가 사용 중입니다. 잠시 후 같은 요청으로 다시 시도해 주세요.');
    this.retryAfter = '1';
  }
}

// The callback is synchronous and must finish/roll back before yielding.
// Four attempts, at most 25ms native wait each, and 20/40/80ms (+0..9ms) backoff.
export async function retryDatabase(action, { signal } = {}) {
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    if (attempt > 0 && performance.now() - started >= 350) throw new DatabaseBusyError();
    try {
      const result = action();
      if (result?.then) throw new TypeError('DB retry callback must be synchronous');
      return result;
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
      if (attempt === 3 || performance.now() - started >= 350) throw new DatabaseBusyError();
      await delay(20 * 2 ** attempt + Math.floor(Math.random() * 10), undefined, { signal });
    }
  }
}
