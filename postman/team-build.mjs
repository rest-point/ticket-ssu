import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = JSON.parse(await readFile(resolve(root, 'docs/openapi.yaml'), 'utf8'));
const routes = new Map(Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods)
  .filter(([, op]) => op.operationId).map(([method, op]) => [op.operationId, { path, method: method.toUpperCase(), op }])));
// Keep the uploaded collection's flat layout, request names, and order.
const requests = [
  ['server ready', 'readiness'], ['signup', 'signup'], ['login', 'login'], ['login state', 'getSession'],
  ['logout', 'logout'], ['concert list', 'listConcerts'], ['seat search', 'getSeats'],
  ['queue enter', 'enterQueue'], ['queue state', 'getQueue'], ['queue out', 'leaveQueue'],
  ['seat preempt', 'replaceHold'], ['booking confirm', 'createBooking'], ['booking list', 'listBookings'],
  ['booking cancel', 'cancelBooking'], ['process alive', 'health'], ['admin search', 'adminSummary'],
  ['concert add', 'createConcert'], ['seat block', 'blockSeats'], ['account delete', 'withdrawAccount']
];
const bodies = {
  signup: { email: '{{email}}', name: '검증회원', phone: '01000000000', password: '{{password}}', terms: true, ageConfirmed: true },
  login: { email: '{{email}}', password: '{{password}}' },
  enterQueue: {}, replaceHold: { seatIds: ['{{seatId}}'] },
  createBooking: { holdId: '{{holdId}}', buyerName: '검증회원', buyerPhone: '01000000000', delivery: 'mobile', paymentMethod: 'demo', agreed: true },
  createConcert: { title: 'Postman 검증 공연', artist: '가상 밴드', venue: '가상 공연장', description: '로컬 API 검증용 공연입니다.', basePrice: 50000, dates: ['{{futureDate}}'] },
  blockSeats: { seatIds: ['A-03'], blocked: true },
  withdrawAccount: { password: '{{password}}', confirmed: true }
};
const before = String.raw`(function () {
const base=pm.environment.get('baseUrl')||'';
if(!/^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{0,4}$/.test(base) || Number(base.split(':').pop())>65535){
 pm.test('local target',()=>pm.expect.fail('baseUrl: http://127.0.0.1:3000')); pm.execution.setNextRequest(null); pm.execution.skipRequest(); return;
}
if(!pm.environment.get('futureDate') || Date.parse(pm.environment.get('futureDate'))<=Date.now()) pm.environment.set('futureDate',new Date(Date.now()+30*86400000).toISOString());
if(pm.request.body?.mode==='raw'){
 const replace=v=>typeof v==='string'?pm.variables.replaceIn(v):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
 pm.request.body.update(JSON.stringify(replace(JSON.parse(pm.request.body.raw))));
}
})();`;

function requestItem([name, id]) {
  const { path, method, op } = routes.get(id);
  const body = bodies[id], header = [{ key: 'Accept', value: 'application/json' }];
  if (!['GET', 'HEAD'].includes(method)) header.push({ key: 'Origin', value: '{{baseUrl}}' }, { key: 'X-CSRF-Token', value: '{{csrf}}' });
  if (body !== undefined) header.push({ key: 'Content-Type', value: 'application/json' });
  if (['replaceHold', 'createBooking'].includes(id)) header.push({ key: 'X-Admission-Token', value: '{{admissionToken}}' });
  const url = '{{baseUrl}}' + path.replace(/\{(\w+)\}/g, '{{$1}}');
  const request = { method, header, ...(body === undefined ? {} : { body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } }),
    url: { raw: url, host: ['{{baseUrl}}'], path: url.slice('{{baseUrl}}/'.length).split('/') } };
  const [code, response] = Object.entries(op.responses).find(([code]) => Number(code) < 300);
  const after = `(function () {
const id=${JSON.stringify(id)};
pm.test('status',()=>pm.expect(pm.response.code).eql(${code}));
pm.test('json',()=>pm.expect(pm.response.headers.get('Content-Type')).match(/^application\\/json/));
if(pm.response.code>=400)return;
const data=pm.response.json();
if(['signup','login','getSession'].includes(id)){if(data.csrf)pm.environment.set('csrf',data.csrf);else pm.environment.unset('csrf');}
if(['logout','withdrawAccount'].includes(id)){pm.environment.unset('csrf');pm.environment.unset('admissionToken');}
if(id==='leaveQueue')pm.environment.unset('admissionToken');
if(['enterQueue','getQueue'].includes(id)){if(data.admission_token)pm.environment.set('admissionToken',data.admission_token);else pm.environment.unset('admissionToken');}
if(id==='listConcerts'){
 const created=data.concerts.find(c=>c.id===pm.environment.get('createdConcertId'));
 const current=pm.environment.get('performanceId');
 const options=created?created.performances:data.concerts.flatMap(c=>c.performances);
 const p=(!created&&options.find(p=>p.id===current))||options.find(p=>p.starts_at>Date.now()&&p.available>0);
 if(p)pm.environment.set('performanceId',p.id);
}
if(id==='getSeats'){
 if(!pm.environment.get('seatId')){const seat=data.seats.find(s=>s.state==='available');if(seat)pm.environment.set('seatId',seat.id);}
 if(data.hold)pm.environment.set('holdId',data.hold.id);else pm.environment.unset('holdId');
}
if(id==='replaceHold'){if(data.hold)pm.environment.set('holdId',data.hold.id);else pm.environment.unset('holdId');}
if(id==='createBooking')pm.environment.set('bookingId',data.booking.id);
if(id==='createConcert')pm.environment.set('createdConcertId',data.id);
})();`;
  return { name, request, response: [{ name: `${code}`, originalRequest: request, status: Number(code) === 201 ? 'Created' : 'OK', code: Number(code),
    header: [{ key: 'Content-Type', value: 'application/json' }], body: JSON.stringify(response.content['application/json'].example, null, 2) }],
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: after.split('\n') } }] };
}
export function buildTeamCollection() {
  return { info: { name: 'ticket-ssu', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: before.split('\n') } }], item: requests.map(requestItem) };
}
export function buildTeamEnvironment() {
  const values = { baseUrl: 'http://127.0.0.1:3000', csrf: '', performanceId: '', seatId: '', admissionToken: '', holdId: '', bookingId: '', email: '', password: '', futureDate: '', createdConcertId: '' };
  return { name: 'ticket-ssu local', values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true, type: /password|csrf|Token/i.test(key) ? 'secret' : 'default' })), _postman_variable_scope: 'environment' };
}
export async function checkTeamCollection() {
  const collection = buildTeamCollection();
  for (const script of [...collection.event, ...collection.item.flatMap(item => item.event)]) new Function(script.script.exec.join('\n'));
  for (const [path, expected] of [['postman/ticket-ssu.team.postman_collection.json', collection], ['postman/environments/team.local.postman_environment.json', buildTeamEnvironment()]]) {
    if (await readFile(resolve(root, path), 'utf8') !== JSON.stringify(expected, null, 2) + '\n') throw new Error('POSTMAN_TEAM_DRIFT');
  }
  const covered = new Set(collection.item.map(item => `${item.request.method} ${item.request.url.raw}`));
  const expected = new Set([...routes.values()].map(route => `${route.method} {{baseUrl}}${route.path.replace(/\{(\w+)\}/g, '{{$1}}')}`));
  if (covered.size !== routes.size || [...expected].some(route => !covered.has(route)) || collection.item.some(item => item.item)) throw new Error('POSTMAN_TEAM_OPERATION_COVERAGE');
  return { currentOperations: routes.size, requests: collection.item.length, folders: 0, status: 'passed' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) console.log(JSON.stringify(await checkTeamCollection()));
  else {
    await writeFile(resolve(root, 'postman/ticket-ssu.team.postman_collection.json'), JSON.stringify(buildTeamCollection(), null, 2) + '\n');
    await writeFile(resolve(root, 'postman/environments/team.local.postman_environment.json'), JSON.stringify(buildTeamEnvironment(), null, 2) + '\n');
    console.log('Postman collection and environment generated');
  }
}
