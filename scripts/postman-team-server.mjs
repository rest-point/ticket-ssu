import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

export async function startPostmanTeamServer({ dbPath = fileURLToPath(new URL('../data/postman-team.sqlite', import.meta.url)), port = 3100, log = console.log } = {}) {
  if (process.env.NODE_ENV === 'production' || process.env.PUBLIC_ORIGIN || process.env.PROXY_TOKEN) throw new Error('팀 Postman 서버는 로컬 개발 전용입니다.');
  return startServer({ runtimeEnv: { HOST: '127.0.0.1', PORT: String(port), SHUTDOWN_TIMEOUT_MS: '10000' }, log,
    appOptions: { dbPath, schema: 'model', demo: true, secureCookies: false, boundaryOptions: {}, queueOptions: {}, limitOptions: {},
      adminEmail: 'admin@ticket-ssu.local', adminPassword: 'TicketSsuAdmin123!' } });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startPostmanTeamServer();
