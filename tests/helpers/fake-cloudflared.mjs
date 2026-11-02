// A local child-process fixture only. It never connects to Cloudflare.
const mode = process.argv[2] ?? 'ready';
const emit = message => process.stderr.write(JSON.stringify({ level: 'info', message }) + '\n');
if (mode === 'exit') process.exit(3);
if (mode === 'large') process.stderr.write('x'.repeat(70000));
if (mode === 'ready' || mode === 'changed' || mode === 'disconnect') {
  const text = JSON.stringify({ level: 'info', message: '| https://unit-test-ticket.trycloudflare.com |' }) + '\n';
  process.stderr.write(text.slice(0, 23));
  setTimeout(() => { process.stderr.write(text.slice(23)); emit('Registered tunnel connection connIndex=0'); }, 20);
  if (mode === 'changed') setTimeout(() => emit('https://changed-test-ticket.trycloudflare.com'), 150);
  if (mode === 'disconnect') setTimeout(() => process.stderr.write(JSON.stringify({ level: 'error', message: 'failed to serve tunnel connection', error: 'private error detail' }) + '\n'), 150);
} else if (mode === 'url-only') emit('https://unit-test-ticket.trycloudflare.com');
setInterval(() => {}, 1000);
