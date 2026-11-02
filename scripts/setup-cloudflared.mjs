import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { cloudflaredRelease as release, cloudflaredPath } from './cloudflared-release.mjs';

function valid(bytes) { return bytes.length === release.size && createHash('sha256').update(bytes).digest('hex') === release.sha256; }
let temporary;
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('지원 환경을 확인해 주세요(Windows x64).');
  if (existsSync(cloudflaredPath)) {
    if (!valid(await readFile(cloudflaredPath))) throw new Error('기존 도구가 고정 체크섬과 다릅니다. 파일을 보존했습니다.');
  } else {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('공식 도구 다운로드 실패');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > release.size) { await response.body.cancel().catch(() => {}); throw new Error('도구 크기 불일치'); }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!valid(bytes)) throw new Error('공식 릴리스 체크섬 불일치');
    await mkdir(dirname(cloudflaredPath), { recursive: true });
    temporary = `${cloudflaredPath}.part-${randomBytes(8).toString('hex')}`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    // Exclusive destination: never replace a user's binary in a concurrent setup.
    const { copyFile, constants } = await import('node:fs/promises');
    await copyFile(temporary, cloudflaredPath, constants.COPYFILE_EXCL);
    await rm(temporary); temporary = undefined;
  }
  console.log(JSON.stringify({ version: release.version, bytes: release.size, sha256Verified: true, publicTunnelStarted: false }));
} catch (error) {
  if (temporary) await rm(temporary, { force: true }); // single exclusively-created file
  console.error(error.message); process.exitCode = 1;
}
