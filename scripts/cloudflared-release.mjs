import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cloudflaredRelease = Object.freeze({
  version: '2026.10.7', size: 55390512,
  sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
  url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe'
});
export const cloudflaredPath = resolve(fileURLToPath(new URL('../', import.meta.url)), '.tools/cloudflared', cloudflaredRelease.version, 'cloudflared.exe');
