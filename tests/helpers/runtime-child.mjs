import { startServer } from '../../server.mjs';
const app = await startServer({ log: () => {} });
// The test harness emits signals through IPC because Windows kill() terminates
// a child directly rather than delivering POSIX SIGTERM handlers.
process.on('message', signal => { if (['SIGINT', 'SIGTERM'].includes(signal)) process.emit(signal); });
app.server.once('close', () => { if (process.connected) process.disconnect(); });
process.send({ port: app.server.address().port });
