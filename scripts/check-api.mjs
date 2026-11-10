import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(resolve(root, file), 'utf8');
export const currentSpec = JSON.parse(await read('docs/openapi.yaml'));
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
export const operations = spec => Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).filter(([method]) => methods.has(method)).map(([method, operation]) => ({ path, method, operation })));
export function dereference(spec, object) {
  if (!object?.$ref) return object;
  assert.ok(object.$ref.startsWith('#/'), 'Only local references are supported');
  const result = object.$ref.slice(2).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((o, key) => o?.[key], spec);
  assert.ok(result, `Unresolved reference: ${object.$ref}`);
  return result;
}

// Deliberately limited to keywords used in these documents, not a general OAS validator.
export function validateValue(spec, inputSchema, value, location = '$') {
  const s = dereference(spec, inputSchema);
  if (value === null) {
    assert.equal(s.nullable, true, `${location}: unexpected null`);
    if (s.enum) assert.ok(s.enum.includes(null), `${location}: null outside enum`);
    return;
  }
  if (s.enum) assert.ok(s.enum.includes(value), `${location}: outside enum`);
  if (s.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected object`);
    for (const key of s.required ?? []) assert.ok(Object.hasOwn(value, key), `${location}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (s.properties?.[key]) validateValue(spec, s.properties[key], item, `${location}.${key}`);
      else assert.notEqual(s.additionalProperties, false, `${location}: unknown property ${key}`);
    }
  } else if (s.type === 'array') {
    assert.ok(Array.isArray(value), `${location}: expected array`);
    if (s.minItems !== undefined) assert.ok(value.length >= s.minItems, `${location}: too few items`);
    if (s.maxItems !== undefined) assert.ok(value.length <= s.maxItems, `${location}: too many items`);
    if (s.uniqueItems) assert.equal(new Set(value.map(v => JSON.stringify(v))).size, value.length, `${location}: duplicate items`);
    for (let n = 0; n < value.length; n++) validateValue(spec, s.items, value[n], `${location}[${n}]`);
  } else if (s.type === 'string') {
    assert.equal(typeof value, 'string', `${location}: expected string`);
    if (s.minLength !== undefined) assert.ok(value.length >= s.minLength, `${location}: too short`);
    if (s.maxLength !== undefined) assert.ok(value.length <= s.maxLength, `${location}: too long`);
    if (s.pattern) assert.ok(new RegExp(s.pattern).test(value), `${location}: pattern mismatch`);
    if (s.format === 'date-time') assert.ok(Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value), `${location}: timezone/date required`);
  } else if (s.type === 'integer' || s.type === 'number') {
    assert.ok(typeof value === 'number' && Number.isFinite(value), `${location}: expected number`);
    if (s.type === 'integer') assert.ok(Number.isSafeInteger(value), `${location}: expected safe integer`);
    if (s.minimum !== undefined) assert.ok(value >= s.minimum, `${location}: below minimum`);
    if (s.maximum !== undefined) assert.ok(value <= s.maximum, `${location}: above maximum`);
  } else if (s.type === 'boolean') assert.equal(typeof value, 'boolean', `${location}: expected boolean`);
  else throw new Error(`Unsupported schema type: ${s.type}`);
}

export function validateResponse(spec, operation, status, body) {
  const response = operation.responses[String(status)] ?? operation.responses.default;
  assert.ok(response, `Undocumented response: ${operation.operationId}/${status}`);
  const schema = dereference(spec, response).content?.['application/json']?.schema;
  assert.ok(schema, 'JSON response schema required');
  validateValue(spec, schema, body);
}

function extractCurrentRoutes(server) {
  const found = [];
  for (const m of server.matchAll(/req\.method === '(GET|POST|PUT|PATCH|DELETE)' && path === '([^']+)'/g)) found.push(`${m[1].toLowerCase()} ${m[2]}`);
  for (const m of server.matchAll(/req\.method === '(POST)' && \[([^\]]+)\]\.includes\(path\)/g)) {
    for (const p of m[2].matchAll(/'([^']+)'/g)) found.push(`post ${p[1]}`);
  }
  for (const line of server.split('\n')) {
    const m = /^\s*const (\w+) = \/(.+)\/\.exec\(path\);/.exec(line);
    if (!m) continue;
    const matchedMethods = [...server.matchAll(new RegExp(`req\\.method === '(GET|POST|PUT|PATCH|DELETE)' && ${m[1]}\\b`, 'g'))].map(x => x[1]);
    assert.ok(matchedMethods.length, `Unrecognized dynamic router: ${m[1]}`);
    const route = m[2].replace(/^\^|\$$/g, '').replaceAll('\\/', '/');
    assert.ok(route.includes('([^/]+)'), 'Unrecognized path matcher');
    for (const method of matchedMethods) found.push(`${method.toLowerCase()} ${route.replace('([^/]+)', route.includes('/bookings/') ? '{bookingId}' : '{performanceId}')}`);
  }
  return found.sort();
}

async function projectMarkdown(directory = '') {
  const files = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (['node_modules', '.git', '.tools', 'data', 'test-results'].includes(entry.name)) continue;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (path === 'postman/private' || path === 'docs/handoff.md') continue;
    if (entry.isDirectory()) files.push(...await projectMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

export async function verifyApiDocuments() {
  assert.deepEqual(currentSpec['x-supported-db-schemas'], ['legacy', 'model']);
  const server = await read('server.mjs'), store = await read('lib/store.mjs');
  const ddl = await read('db/migrations/001_model.sql');
  const sharedDdl = (await Promise.all(['003_admin_booking_cancellations.sql', '004_member_booking_restrictions.sql', '005_performance_sales.sql']
    .map(file => read(`db/migrations/${file}`)))).join('\n');
  const sharedTables = [...sharedDdl.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(m => m[1]);
  const targetTables = new Set([...ddl.matchAll(/CREATE TABLE ([a-z_]+) \(/g)].map(m => m[1]));
  const legacyTables = new Set([...store.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(m => m[1]));
  for (const table of sharedTables) { targetTables.add(table); legacyTables.add(table); }
  const crud = await read('docs/design/crud-matrix.md'), api = await read('docs/design/api.md');
  let examples = 0, refs = 0;
  const walk = (spec, value) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) { dereference(spec, value); refs++; }
    if (value.schema && Object.hasOwn(value, 'example')) { validateValue(spec, value.schema, value.example); examples++; }
    for (const child of Object.values(value)) walk(spec, child);
  };
  for (const [spec, implementation] of [[currentSpec, 'implemented-legacy']]) {
    assert.deepEqual(spec['x-request-limits'], { ip: 'socket peer; authenticated loopback proxy IP when configured', user: 'authenticated user across sessions', state: 'bounded process memory', retryAfter: 'seconds' });
    assert.deepEqual(spec['x-probes'], { implementation: 'connected', sessionLookup: false, requestLimits: false, documentation: 'README.md' });
    assert.deepEqual(spec['x-http-boundary'], { publicOrigin: 'explicit HTTPS origin in deployment', proxy: 'exact loopback peer plus secret token', forwardedHeaders: 'ignored', documentation: 'docs/design/api.md' });
    assert.deepEqual(spec['x-queue-core'], { implementation: 'connected', module: 'lib/performance-queue.mjs', apiImplemented: true, admissionTokens: true, documentation: 'docs/design/api.md' });
    await access(resolve(root, spec['x-queue-core'].module));
    await access(resolve(root, spec['x-queue-core'].documentation));
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(spec.info.title && spec.info.version && spec.servers[0].url);
    const ids = new Set();
    for (const { method, path, operation: o } of operations(spec)) {
      assert.ok(!ids.has(o.operationId), `Duplicate operationId: ${o.operationId}`); ids.add(o.operationId);
      assert.equal(o['x-implementation'], path.endsWith('/queue') ? 'implemented-queue' : /^\/api\/v1\/(health|readiness)$/.test(path) ? 'implemented-probe' : implementation);
      assert.ok(api.includes(o['x-legacy-operation-id'] ?? o.operationId), `Missing API description: ${o.operationId}`);
      for (const name of o['x-tables']) assert.ok(targetTables.has(name), `Unknown target table: ${name}`);
      for (const name of o['x-legacy-tables'] ?? []) assert.ok(legacyTables.has(name), `Unknown legacy table: ${name}`);
      const params = (o.parameters ?? []).map(p => dereference(spec, p));
      assert.equal(new Set(params.map(p => `${p.in}:${p.name}`)).size, params.length);
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
      assert.deepEqual(params.filter(p => p.in === 'path').map(p => p.name).sort(), expected);
      for (const p of params) if (p.in === 'path') assert.equal(p.required, true);
      for (const security of o.security) for (const name of Object.keys(security)) assert.ok(spec.components.securitySchemes[name]);
      if (o['x-role'] !== 'public') {
        assert.ok(o.security.every(s => s.cookieAuth), `Missing auth: ${method} ${path}`);
        if (method !== 'get') assert.ok(o.security.every(s => s.csrfToken), `Missing CSRF: ${method} ${path}`);
      }
      assert.ok(Object.keys(o.responses).some(code => /^2\d\d$/.test(code)));
      if (spec === currentSpec && o['x-implementation'] !== 'implemented-probe') assert.ok(o.responses['429']?.headers?.['Retry-After'], `Missing request limit contract: ${o.operationId}`);
    }
    walk(spec, spec);
  }
  const observed = extractCurrentRoutes(server);
  assert.deepEqual(operations(currentSpec).map(({ method, path }) => `${method} ${path}`).sort(), observed, 'Current router/spec drift');
  for (const table of targetTables) assert.ok(crud.includes(`| ${table} |`), `Missing CRUD table: ${table}`);
  for (const { operation: o } of operations(currentSpec)) {
    const row = crud.split('\n').find(line => line.startsWith(`| ${o.operationId} | `));
    assert.ok(row, `Missing CRUD operation: ${o.operationId}`);
    const columns = row.split('|').map(s => s.trim());
    const parseTables = cell => [...cell.matchAll(/\b([a-z_]+) [CRUD]+\b/g)].map(m => m[1]);
    const legacy = parseTables(columns[3]);
    if (columns[3].includes('+ expire')) legacy.push('holds', 'seats');
    assert.deepEqual([...new Set(legacy)].sort(), [...o['x-legacy-tables']].sort(), `Legacy CRUD drift: ${o.operationId}`);
    assert.deepEqual(parseTables(columns[4]).sort(), [...o['x-tables']].sort(), `Target CRUD drift: ${o.operationId}`);
  }
  const files = await projectMarkdown();
  assert.deepEqual(files.filter(file => !file.startsWith('docs/')), ['README.md'], 'Only root README may be outside docs');
  const indexed = [...new Set([...(await read('README.md')).matchAll(/\[[^\]\n]+\]\((docs\/[^)#]+\.md)\)/g)].map(match => match[1]))].sort();
  assert.deepEqual(indexed, files.filter(file => file.startsWith('docs/')), 'README must index every Markdown document');
  for (const name of ['task', 'bug_report']) {
    const form = JSON.parse(await read(`.github/ISSUE_TEMPLATE/${name}.yml`));
    assert.ok(form.name && form.description && form.title);
    assert.equal(new Set(form.body.filter(item => item.id).map(item => item.id)).size, 3);
    for (const field of form.body.filter(item => item.type !== 'markdown')) {
      assert.equal(field.type, 'textarea'); assert.ok(field.attributes.label); assert.equal(field.validations.required, true);
    }
  }
  let localLinks = 0;
  for (const file of files) {
    const text = await read(file);
    assert.ok(!/[\ufffd\u3040-\u30ff\u3400-\u9fff]/.test(text), `Unexpected encoding/language: ${file}`);
    assert.equal((text.match(/^```/gm) ?? []).length % 2, 0);
    for (const m of text.matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:\/\//i.test(m[1])) continue;
      const [path, anchor] = m[1].split('#'), absolute = path ? resolve(dirname(resolve(root, file)), path) : resolve(root, file);
      await access(absolute); localLinks++;
      if (anchor) {
        const body = await readFile(absolute, 'utf8');
        assert.ok([...body.matchAll(/^#+ (.+)$/gm)].some(h => h[1].trim().toLowerCase() === anchor), `Missing ASCII heading anchor: ${m[1]}`);
      }
    }
  }
  return { currentPaths: Object.keys(currentSpec.paths).length, currentOperations: operations(currentSpec).length, references: refs, examples, checkedDocuments: files.length, localLinks, status: 'passed', scope: 'local structural/used-schema checks; not full OAS certification' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyApiDocuments(), null, 2));
