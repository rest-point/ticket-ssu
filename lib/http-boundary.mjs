import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './store.mjs';

const ip = value => typeof value === 'string' && value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
export function boundaryOptionsFromEnv(env = process.env) {
  return { publicOrigin: env.PUBLIC_ORIGIN || '', proxyToken: env.PROXY_TOKEN || '', proxyIp: env.PROXY_IP || '127.0.0.1' };
}
export class HttpBoundary {
  #origin; #host; #token; #peer;
  constructor({ publicOrigin = '', proxyToken = '', proxyIp = '127.0.0.1' } = {}) {
    if (typeof publicOrigin !== 'string' || typeof proxyToken !== 'string') throw new Error('공개 주소/프록시 설정을 확인해 주세요.');
    if (publicOrigin || proxyToken) {
      let url;
      try { url = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN은 HTTPS 출처여야 합니다.'); }
      if (url.protocol !== 'https:' || url.origin !== publicOrigin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN은 경로 없는 정규 HTTPS 출처여야 합니다.');
      if (!/^[a-f0-9]{64}$/.test(proxyToken)) throw new Error('PROXY_TOKEN은 무작위 32바이트의 소문자 hex 값이어야 합니다.');
      if (!['127.0.0.1', '::1'].includes(proxyIp)) throw new Error('PROXY_IP는 같은 호스트의 정확한 loopback IP여야 합니다.');
      this.#origin = publicOrigin; this.#host = url.host; this.#token = Buffer.from(proxyToken); this.#peer = proxyIp;
    }
  }
  get deployed() { return Boolean(this.#origin); }
  clientIp(req) {
    const peer = ip(req.socket.remoteAddress ?? 'unknown');
    if (!this.deployed) return peer;
    const token = req.headers['x-ticket-ssu-proxy-token'];
    const client = ip(req.headers['x-ticket-ssu-client-ip']);
    if (peer !== this.#peer || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), this.#token) || typeof client !== 'string' || !isIP(client) ||
      typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== this.#host) {
      throw new AppError(403, '허용되지 않은 프록시 요청입니다.');
    }
    return client;
  }
  allowsOrigin(origin, host) {
    return !origin || (this.deployed ? origin === this.#origin : origin === `http://${host}` || origin === `https://${host}`);
  }
}
