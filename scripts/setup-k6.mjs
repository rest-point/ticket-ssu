import { mkdir, writeFile, readFile, copyFile, rm, constants, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { k6Release as release, k6Path, validK6, verifyK6 } from '../load-tests/k6-tool.mjs';

let temporary;
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('K6_UNSUPPORTED_PLATFORM');
  if (existsSync(k6Path)) {
    if (!validK6(await readFile(k6Path))) throw new Error('K6_EXISTING_BINARY_PRESERVED');
  } else {
    const base = dirname(dirname(k6Path)); await mkdir(base, { recursive: true });
    temporary = await mkdtemp(resolve(base, '.install-'));
    const response = await fetch(release.archiveUrl, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('K6_DOWNLOAD_FAILED');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > release.archiveBytes) throw new Error('K6_ARCHIVE_SIZE'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== release.archiveBytes || createHash('sha256').update(bytes).digest('hex') !== release.archiveSha256) throw new Error('K6_ARCHIVE_MISMATCH');
    const zip = resolve(temporary, 'release.zip'), output = resolve(temporary, 'unpacked');
    await writeFile(zip, bytes, { flag: 'wx' });
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:TICKET_SSU_K6_ZIP -DestinationPath $env:TICKET_SSU_K6_OUT'],
      { env: { ...process.env, TICKET_SSU_K6_ZIP: zip, TICKET_SSU_K6_OUT: output }, windowsHide: true, timeout: 60000, maxBuffer: 4096 });
    const executable = resolve(output, release.archiveExecutable);
    if (!executable.startsWith(output + sep) || !validK6(await readFile(executable))) throw new Error('K6_EXECUTABLE_MISMATCH');
    await mkdir(dirname(k6Path), { recursive: true });
    await copyFile(executable, k6Path, constants.COPYFILE_EXCL);
  }
  await verifyK6();
  console.log(JSON.stringify({ version: release.version, archiveSha256Pinned: true, executableSha256Verified: true, loadStarted: false }));
} catch { console.error('k6 설치/검증 실패: 공식 다운로드·Windows x64·기존 도구 파일을 확인해 주세요.'); process.exitCode = 1; }
finally {
  if (temporary) {
    const base = dirname(dirname(k6Path));
    if (!resolve(temporary).startsWith(resolve(base) + sep + '.install-')) throw new Error('K6_INSTALL_CLEANUP_PATH');
    await rm(temporary, { recursive: true, force: true });
  }
}
