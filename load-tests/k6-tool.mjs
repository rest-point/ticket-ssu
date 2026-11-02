import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const k6Release = JSON.parse(await readFile(new URL('../scripts/k6-release.json', import.meta.url), 'utf8'));
export const k6Path = resolve(fileURLToPath(new URL('../', import.meta.url)), '.tools/k6', k6Release.version, 'k6.exe');
export function validK6(bytes) { return bytes.length === k6Release.executableBytes && createHash('sha256').update(bytes).digest('hex') === k6Release.executableSha256; }
export async function verifyK6() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('K6_UNSUPPORTED_PLATFORM');
  if (!validK6(await readFile(k6Path))) throw new Error('K6_BINARY_MISMATCH');
  const { stdout } = await promisify(execFile)(k6Path, ['version'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  if (!stdout.includes(`v${k6Release.version} `)) throw new Error('K6_VERSION_MISMATCH');
}
