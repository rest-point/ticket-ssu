import { createServer, request } from 'node:https';
import { request as backendRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';

export async function createTestCertificate(dir) {
  const gitSsl = 'C:/Program Files/Git/usr/bin/openssl.exe';
  const bin = process.env.OPENSSL_BIN || (process.platform === 'win32' && existsSync(gitSsl) ? gitSsl : 'openssl');
  await promisify(execFile)(bin, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'test.key'), '-out', join(dir, 'test.pem')], { windowsHide: true });
  const [key, cert] = await Promise.all([readFile(join(dir, 'test.key')), readFile(join(dir, 'test.pem'))]);
  return { key, cert };
}
export async function tlsProxy(dir, token) {
  const { key, cert } = await createTestCertificate(dir);
  let backend;
  const server = createServer({ key, cert }, (req, res) => {
    const headers = { ...req.headers };
    // Emulate the documented single-edge policy: strip caller metadata, set
    // authenticated identity from the TLS socket, preserve Origin and cookies.
    for (const name of Object.keys(headers)) if (/^(forwarded|x-forwarded-|x-ticket-ssu-)/.test(name)) delete headers[name];
    headers.host = `localhost:${server.address().port}`;
    headers['x-ticket-ssu-proxy-token'] = token;
    headers['x-ticket-ssu-client-ip'] = req.socket.remoteAddress;
    const upstream = backendRequest({ host: '127.0.0.1', port: backend, method: req.method, path: req.url, headers, agent: false }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `https://localhost:${server.address().port}`;
  const send = (method, path, { body, headers = {}, localAddress } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(new URL(path, origin), { method, ca: cert, rejectUnauthorized: true, family: 4, localAddress, agent: false,
      headers: { ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', part => { data += part; });
      res.on('end', () => { let body; try { body = JSON.parse(data); } catch { body = data; } resolve({ status: res.statusCode, body, headers: res.headers }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('TLS test request timeout'))); req.on('error', reject); req.end(encoded);
  });
  return { server, origin, cert, send, setBackend: port => { backend = port; }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
