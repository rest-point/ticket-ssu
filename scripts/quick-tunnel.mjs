import { createQuickTunnel } from '../lib/quick-tunnel.mjs';

try {
  const tunnel = createQuickTunnel({ log: value => console.log(JSON.stringify(value)) });
  await tunnel.ready;
  const report = await tunnel.closed;
  if (!report.cleanupPassed || report.reason === 'tunnel-failed') process.exitCode = 1;
} catch {
  // Never echo raw child logs, environment values, credentials, or DB errors.
  console.error('Quick Tunnel 시작/정리에 실패했습니다. 환경·도구 설치·포트·학교망 연결을 확인해 주세요.');
  process.exitCode = 1;
}
