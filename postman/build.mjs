import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = JSON.parse(await readFile(resolve(root, 'docs/openapi.yaml'), 'utf8'));
const routes = new Map(Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods)
  .filter(([, operation]) => operation.operationId).map(([method, operation]) => [operation.operationId, { path, method, operation }])));
const lines = value => value.trim().split('\n');
const get = key => `pm.variables.get('${key}')`;
const check = (name, assertion) => `verify('${name}', () => { ${assertion} });`;
const bookingPath = '/api/bookings/{bookingId}/cancel';
const items = [];
function step(name, id, status, { body, tests = '', ...metadata } = {}) {
  const route = routes.get(id);
  if (!route || !route.operation.responses[String(status)]) throw new Error(`Unknown contract: ${name}`);
  items.push({ name, id, status, body, tests, ...metadata });
}
const loginTests = check('user session and cookie contract', `pm.expect(data.user.role).eql('user'); pm.expect(data.csrf).to.be.a('string');
const cookie = pm.response.headers.get('Set-Cookie'); pm.expect(cookie).match(/HttpOnly/); pm.expect(cookie).match(/SameSite=Lax/);
if (pm.environment.get('mode') === 'staging') pm.expect(cookie).match(/; Secure(?:;|$)/);
pm.variables.set('csrf', data.csrf); pm.variables.set('userId', data.user.id);`);
step('01 health', 'health', 200);
step('02 readiness', 'readiness', 200, { tests: check('ready schema', `pm.expect(data.status).eql('ready'); pm.expect([0, 1]).include(data.schema_version);`) });
step('03 anonymous session', 'getSession', 200, { tests: check('dedicated non-demo target', `pm.expect(data.user).eql(null); pm.expect(data.demo).eql(false);`) });
step('04 anonymous booking denied', 'listBookings', 401);
step('05 incorrect password denied', 'login', 401, { body: { email: '{{memberEmail}}', password: 'intentionally-incorrect-password' } });
step('06 foreign origin denied', 'login', 403, { badOrigin: true, body: { email: '{{memberEmail}}', password: '{{memberPassword}}' } });
step('07 member login', 'login', 200, { body: { email: '{{memberEmail}}', password: '{{memberPassword}}' }, tests: loginTests });
step('08 authenticated session', 'getSession', 200, { tests: check('cookie jar persists the session', `pm.expect(data.user.id).eql(${get('userId')}); pm.expect(data.csrf).eql(${get('csrf')});`) });
step('09 member admin access denied', 'adminSummary', 403);
step('10 missing csrf denied', 'logout', 403, { noCsrf: true });
step('11 concerts', 'listConcerts', 200, { tests: check('explicit target performance exists', `pm.expect(data.concerts.some(c => c.performances.some(p => p.id === pm.environment.get('performanceId')))).eql(true);`) });
step('12 seat preflight', 'getSeats', 200, { tests: check('future available seat and no existing hold', `pm.expect(data.performance.starts_at).above(data.server_now); pm.expect(data.hold).eql(null);
const seat = data.seats.find(s => s.id === pm.environment.get('seatId')); pm.expect(seat.state).eql('available'); pm.expect(Number.isSafeInteger(seat.price)).eql(true); pm.variables.set('seatPrice', seat.price);`) });
step('13 booking preflight', 'listBookings', 200, { tests: check('no pre-existing confirmed booking in target', `pm.expect(data.bookings.some(b => b.performance_id === pm.environment.get('performanceId') && b.status === 'confirmed')).eql(false);`) });
step('14 queue preflight', 'getQueue', 404);
step('15 admission bypass denied', 'replaceHold', 403, { body: { seatIds: ['{{seatId}}'] } });
step('16 enter queue', 'enterQueue', 200, { body: {}, tests: check('general admission required', `pm.expect(data.state).eql('admitted'); pm.expect(data.mode).eql('general'); pm.expect(data.admission_token).to.be.a('string'); pm.variables.set('admission', data.admission_token);`) });
step('17 queue status', 'getQueue', 200, { tests: check('session-bound admission', `pm.expect(data.state).eql('admitted'); pm.expect(data.admission_token).eql(${get('admission')});`) });
step('18 reserve one seat', 'replaceHold', 200, { admission: true, body: { seatIds: ['{{seatId}}'] }, tests: check('single owned hold', `pm.expect(data.hold.id).to.be.a('string'); pm.expect(data.hold.expires_at).above(data.server_now); pm.variables.set('holdId', data.hold.id);`) });
step('18b owned hold readback', 'getSeats', 200, { tests: check('held seat readback', `pm.expect(data.hold.id).eql(${get('holdId')}); pm.expect(data.seats.filter(s=>s.state==='selected')).to.have.lengthOf(1); pm.expect(data.seats.find(s=>s.id===pm.environment.get('seatId')).state).eql('selected');`) });
step('19 demo checkout', 'createBooking', 201, { admission: true, body: { holdId: '{{holdId}}', buyerName: '검증회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo', total: 1 }, tests: check('server-calculated money and ownership', `const b=data.booking; pm.expect(b.hold_id).eql(${get('holdId')}); pm.expect(b.status).eql('confirmed'); pm.expect(b.seats).to.have.lengthOf(1);
pm.expect(b.ticket_total).eql(${get('seatPrice')}); pm.expect(b.fee).eql(2000); pm.expect(b.total).eql(Number(${get('seatPrice')})+2000); pm.variables.set('bookingId', b.id);`) });
step('20 booking query', 'listBookings', 200, { tests: check('confirmed booking retained', `pm.expect(data.bookings.some(b => b.id===${get('bookingId')} && b.status==='confirmed')).eql(true);`) });
step('21 cancel owned booking', 'cancelBooking', 200, { path: bookingPath, tests: check('full demo cancellation', `pm.expect(data.booking.id).eql(${get('bookingId')}); pm.expect(data.booking.status).eql('cancelled'); pm.expect(data.booking.total).eql(Number(${get('seatPrice')})+2000);`) });
step('22 cancelled history', 'listBookings', 200, { tests: check('cancellation is history, not deletion', `pm.expect(data.bookings.some(b => b.id===${get('bookingId')} && b.status==='cancelled')).eql(true);`) });
step('23 released inventory', 'getSeats', 200, { tests: check('seat released and hold absent', `pm.expect(data.hold).eql(null); pm.expect(data.seats.find(s=>s.id===pm.environment.get('seatId')).state).eql('available');`) });
step('24 leave queue', 'leaveQueue', 200);
step('25 member logout', 'logout', 200, { tests: `pm.variables.unset('csrf'); pm.variables.unset('admission');` });
step('26 revoked session', 'getSession', 200, { tests: check('cookie jar cleared by logout', `pm.expect(data.user).eql(null); pm.expect(data.csrf).eql(null);`) });
const smokeCount = items.length;
step('27 signup isolated second member', 'signup', 201, { localOnly: true, body: { email: '{{otherEmail}}', password: '{{otherPassword}}', name: '다른검증회원', phone: '01000000000', terms: true, ageConfirmed: true, role: 'admin' }, tests: loginTests });
step('28 other member cancellation denied', 'cancelBooking', 404, { localOnly: true, path: bookingPath });
step('29 other member logout', 'logout', 200, { localOnly: true, tests: `pm.variables.unset('csrf');` });
step('30 isolated administrator login', 'login', 200, { localOnly: true, body: { email: '{{adminEmail}}', password: '{{adminPassword}}' }, tests: check('administrator authenticated', `pm.expect(data.user.role).eql('admin'); pm.variables.set('csrf', data.csrf);`) });
step('31 administrator summary', 'adminSummary', 200, { localOnly: true });
step('32 create fixture concert', 'createConcert', 201, { localOnly: true, body: { title: 'CLI 가상 공연', artist: 'CLI 가상 밴드', venue: 'CLI 가상 공연장', description: '격리된 DB에서만 생성', basePrice: 50000, dates: ['{{futureDate}}'] } });
step('33 administrator blocks one seat', 'blockSeats', 200, { localOnly: true, body: { seatIds: ['A-03'], blocked: true } });
step('34 blocked seat visible', 'getSeats', 200, { localOnly: true, tests: check('administrator block applied', `pm.expect(data.seats.find(s=>s.id==='A-03').state).eql('blocked');`) });
step('35 administrator restores seat', 'blockSeats', 200, { localOnly: true, body: { seatIds: ['A-03'], blocked: false } });
step('36 administrator logout', 'logout', 200, { localOnly: true, tests: `pm.variables.unset('csrf');` });

function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => !['nullable', 'example'].includes(key)).map(([key, item]) => [key, jsonSchema(item)]));
  if (result.$ref) result.$ref = result.$ref.replace('#/components/schemas/', '#/definitions/');
  if (value.nullable && result.type) result.type = [result.type, 'null'];
  return result;
}
const contracts = Object.fromEntries(items.map(item => {
  const response = routes.get(item.id).operation.responses[String(item.status)];
  const schema = response.$ref ? spec.components.responses[response.$ref.split('/').pop()].content['application/json'].schema : response.content['application/json'].schema;
  return [item.name, { id: item.id, status: item.status, schema: jsonSchema(schema), localOnly: Boolean(item.localOnly), noCsrf: Boolean(item.noCsrf), admission: Boolean(item.admission) }];
}));
const preRequest = lines(`
const meta=JSON.parse(pm.collectionVariables.get('contracts'))[pm.info.requestName];
const mode=pm.environment.get('mode'), base=pm.environment.get('baseUrl');
const local=new RegExp('^http://127[.]0[.]0[.]1:[1-9][0-9]{0,4}$').test(base||'');
const staging=new RegExp('^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$').test(base||'');
let valid=pm.environment.get('allowWrite')==='dedicated-demo' && ((mode==='local'&&local)||(mode==='staging'&&staging));
valid=valid && ['memberEmail','memberPassword','performanceId','seatId'].every(k=>typeof pm.environment.get(k)==='string'&&pm.environment.get(k).length>0);
valid=valid && /^[A-Za-z0-9_-]{1,160}$/.test(pm.environment.get('performanceId')||'') && /^[A-Za-z0-9_-]{1,32}$/.test(pm.environment.get('seatId')||'');
valid=valid && !(meta.localOnly && mode!=='local');
const port=Number((base||'').match(/:([0-9]+)$/)?.[1] || (mode==='staging'?443:0)); valid=valid && port>0 && port<=65535;
if (!valid) { pm.test('dedicated demo target and run scope',()=>pm.expect(valid).eql(true)); pm.execution.setNextRequest(null); pm.execution.skipRequest(); }
if (pm.info.requestName==='01 health') { ['csrf','admission','holdId','bookingId','seatPrice','userId'].forEach(k=>pm.variables.unset(k)); }
pm.variables.set('futureDate',new Date(Date.now()+86400000*30).toISOString());
if (!pm.request.headers.has('Origin')) pm.request.headers.upsert({key:'Origin',value:base});
pm.request.headers.remove('X-CSRF-Token'); pm.request.headers.remove('X-Admission-Token');
if (!meta.noCsrf && pm.variables.get('csrf') && !['GET','HEAD'].includes(pm.request.method)) pm.request.headers.upsert({key:'X-CSRF-Token',value:pm.variables.get('csrf')});
if (meta.admission && pm.variables.get('admission')) pm.request.headers.upsert({key:'X-Admission-Token',value:pm.variables.get('admission')});
if (pm.request.body && pm.request.body.mode==='raw') {
  const replace=value=>typeof value==='string'?pm.variables.replaceIn(value):Array.isArray(value)?value.map(replace):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replace(item)])):value;
  pm.request.body.update(JSON.stringify(replace(JSON.parse(pm.request.body.raw))));
}
`);
const commonTest = `
const meta=JSON.parse(pm.collectionVariables.get('contracts'))[pm.info.requestName];
let data;
function verify(name, action) { let passed=true; pm.test(name,()=>{try {action();}catch(error){passed=false;throw error;}}); if(!passed){pm.execution.setNextRequest(null);throw new Error('POSTMAN_ASSERTION_STOPPED_MANUAL_REVIEW');} }
verify('HTTP status',()=>pm.expect(pm.response.code).eql(meta.status));
verify('JSON and no-store',()=>{pm.expect(pm.response.headers.get('Content-Type')).match(/^application\\/json/);pm.expect(pm.response.headers.get('Cache-Control')).eql('no-store');data=pm.response.json();});
verify('OpenAPI response schema',()=>pm.response.to.have.jsonSchema({...meta.schema,definitions:JSON.parse(pm.collectionVariables.get('definitions'))}));
`;
function requestItem(item) {
  const route = routes.get(item.id);
  const path = (item.path ?? route.path).replaceAll('{performanceId}', '{{performanceId}}').replaceAll('{bookingId}', '{{bookingId}}');
  const header = [{ key: 'Accept', value: 'application/json' }];
  if (item.body !== undefined) header.push({ key: 'Content-Type', value: 'application/json' });
  if (item.badOrigin) header.push({ key: 'Origin', value: 'https://untrusted.example.invalid' });
  return { name: item.name, request: { method: route.method.toUpperCase(), header, url: '{{baseUrl}}' + path,
    ...(item.body !== undefined ? { body: { mode: 'raw', raw: JSON.stringify(item.body), options: { raw: { language: 'json' } } } } : {}) },
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: lines('(function () {\n' + commonTest + '\n' + item.tests + '\n})();') } }] };
}
export function buildCollection() {
  return { info: { name: 'Temp Ticket current API regression', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: 'Current 18 operations only. Use a dedicated demo target. Run 01 Booking smoke only on staging. Cookie Jar must be enabled. Failures stop the run and require owned-state review.' },
    protocolProfileBehavior: { followRedirects: false },
    variable: [{ key: 'contracts', value: JSON.stringify(contracts) }, { key: 'definitions', value: JSON.stringify(jsonSchema(spec.components.schemas)) }],
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['(function () {', ...preRequest, '})();'] } }],
    item: [{ name: '01 Booking smoke', item: items.slice(0, smokeCount).map(requestItem) }, { name: '02 Isolated local authorization and admin', item: items.slice(smokeCount).map(requestItem) }] };
}
export async function checkCollection() {
  const collection = buildCollection();
  for (const script of [...collection.event, ...collection.item.flatMap(folder => folder.item.flatMap(item => item.event))]) {
    new Function(script.script.exec.join('\n')); // Compile only; never execute generated scripts here.
  }
  for (const mode of ['local', 'staging']) {
    const env = JSON.parse(await readFile(resolve(root, `postman/environments/${mode}.example.postman_environment.json`), 'utf8'));
    const values = Object.fromEntries(env.values.map(row => [row.key, row.value]));
    if (values.mode !== mode || values.allowWrite !== '' || Object.entries(values).some(([key, value]) => /Password|Email/.test(key) && value !== '')) throw new Error('POSTMAN_TEMPLATE_SECRET_OR_SCOPE');
  }
  const expected = JSON.stringify(collection, null, 2) + '\n';
  if (await readFile(resolve(root, 'postman/temp-ticket.postman_collection.json'), 'utf8') !== expected) throw new Error('POSTMAN_COLLECTION_DRIFT');
  const covered = new Set(items.filter(item => item.status < 400).map(item => item.id));
  if (covered.size !== routes.size || [...routes.keys()].some(id => !covered.has(id))) throw new Error('POSTMAN_OPERATION_COVERAGE');
  return { currentOperations: covered.size, requests: items.length, status: 'passed' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) console.log(JSON.stringify(await checkCollection()));
  else { await writeFile(resolve(root, 'postman/temp-ticket.postman_collection.json'), JSON.stringify(buildCollection(), null, 2) + '\n'); console.log('Postman collection generated'); }
}
