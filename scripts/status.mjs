import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkReadiness(base = 'http://127.0.0.1:3000') {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('상태 확인에는 HTTP(S) 기본 주소가 필요합니다.');
  const response = await fetch(new URL('/api/v1/readiness', url), { signal: AbortSignal.timeout(3000), redirect: 'error' });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 'ready' || ![0, 1].includes(body.schema_version)) throw new Error('서비스가 준비되지 않았습니다.');
  return body;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await checkReadiness(process.argv[2]))); }
  catch { console.error('상태 확인 실패: 주소·프로세스·readiness를 확인해 주세요.'); process.exitCode = 1; }
}
