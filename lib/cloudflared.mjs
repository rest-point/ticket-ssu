import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { cloudflaredRelease as release, cloudflaredPath } from '../scripts/cloudflared-release.mjs';

export function quickTunnelOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(value)) {
    throw new Error('TUNNEL_INVALID_ORIGIN');
  }
  return value;
}

export async function verifyCloudflared() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('TUNNEL_UNSUPPORTED_PLATFORM');
  let bytes;
  try { bytes = await readFile(cloudflaredPath); } catch { throw new Error('TUNNEL_TOOL_MISSING'); }
  if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('TUNNEL_BINARY_MISMATCH');
  let stdout;
  try { ({ stdout } = await promisify(execFile)(cloudflaredPath, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 })); }
  catch { throw new Error('TUNNEL_TOOL_FAILED'); }
  if (!stdout.startsWith(`cloudflared version ${release.version} `)) throw new Error('TUNNEL_VERSION_MISMATCH');
}

// Only the executable and loopback port reach the child. Never inherit app secrets,
// TUNNEL_*, proxy settings, or the user's default cloudflared configuration.
export async function launchCloudflared({ port, timeoutMs = 30000, protocol = 'auto', onFailure = () => {}, spawnProcess = spawn }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['auto', 'quic', 'http2'].includes(protocol) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('TUNNEL_INVALID_PROCESS_OPTIONS');
  const directory = await mkdtemp(join(tmpdir(), 'ticket-ssu-quick-'));
  const removeDirectory = async () => {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-quick-')) throw new Error('TUNNEL_CLEANUP_PATH');
    await rm(directory, { recursive: true, force: true });
  };
  let child;
  try {
    const config = join(directory, 'config.yml');
    await writeFile(config, '{}\n', { flag: 'wx' });
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory });
    child = spawnProcess(cloudflaredPath, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`,
      '--protocol', protocol, '--output', 'json', '--metrics', '127.0.0.1:0', '--grace-period', '1s', '--ha-connections', '1'],
    { cwd: directory, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    await removeDirectory(); throw new Error('TUNNEL_SPAWN_FAILED');
  }
  let origin, registered = false, settled = false, stopping = false, failed = false, total = 0, stopPromise;
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((resolveReadyValue, rejectReadyValue) => { resolveReady = resolveReadyValue; rejectReady = rejectReadyValue; });
  ready.catch(() => {});
  const closed = new Promise(resolveClosedValue => { resolveClosed = resolveClosedValue; });
  const fail = code => {
    if (stopping || failed) return;
    failed = true; clearTimeout(timer);
    if (!settled) { settled = true; rejectReady(new Error(code)); }
    onFailure(code);
    // Also terminate when this helper is used without a lifecycle controller.
    void stop().catch(() => {});
  };
  const timer = setTimeout(() => fail('TUNNEL_START_TIMEOUT'), timeoutMs);
  const line = value => {
    if (stopping || failed) return;
    let message = value;
    try { message = JSON.parse(value).message ?? ''; } catch { /* Plain startup box is also supported. */ }
    if (typeof message !== 'string') return;
    // An aborted visitor request can log an error too; only connection lifecycle
    // failures close the tunnel. Otherwise a visitor could stop the whole demo.
    if (settled && /Unregistered tunnel connection|Connection terminated|failed to serve tunnel connection/i.test(message)) { fail('TUNNEL_CONNECTION_FAILED'); return; }
    const urls = message.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com(?=[\s|"']|$)/g) ?? [];
    for (const url of urls) {
      let next;
      try { next = quickTunnelOrigin(url); } catch { fail('TUNNEL_INVALID_ORIGIN'); return; }
      if (origin && origin !== next) { fail('TUNNEL_ORIGIN_CHANGED'); return; }
      origin = next;
    }
    if (/Registered tunnel connection\b/.test(message)) registered = true;
    if (registered && origin && !settled) { settled = true; clearTimeout(timer); resolveReady(origin); }
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8'); let pending = '';
    stream.on('data', chunk => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) { fail('TUNNEL_LOG_LIMIT'); return; }
      pending += decoder.write(chunk);
      if (pending.length > 65536) { fail('TUNNEL_LOG_LIMIT'); return; }
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const value of lines) line(value);
    });
    stream.on('end', () => { line(pending + decoder.end()); });
    stream.on('error', () => fail('TUNNEL_LOG_FAILED'));
  }
  child.on('error', () => fail('TUNNEL_SPAWN_FAILED'));
  child.once('close', () => { resolveClosed(); fail('TUNNEL_PROCESS_EXITED'); });
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true; clearTimeout(timer);
    if (!settled) { settled = true; rejectReady(new Error('TUNNEL_STOPPED')); }
    stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let killTimer;
      await Promise.race([closed, new Promise(resolveTimeout => { killTimer = setTimeout(resolveTimeout, 2000); })]);
      clearTimeout(killTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      let finalTimer;
      try {
        await Promise.race([closed, new Promise((_, reject) => { finalTimer = setTimeout(() => reject(new Error('TUNNEL_STOP_TIMEOUT')), 2000); })]);
        await removeDirectory();
      } finally { clearTimeout(finalTimer); }
    })();
    return stopPromise;
  }
  return { ready, stop, closed };
}
