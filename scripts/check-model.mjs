import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Read documentation only. This verifier never imports Store or opens a database.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');
const logical = await read('docs/data-model/logical.md');
const normalization = await read('docs/data-model/normalization.md');
const names = text => text.trim().replace(/^\(|\)$/g, '').split(',').map(s => s.trim());
const keys = text => text.split(' / ').map(names);
const signature = key => [...key].sort().join(',');
const closure = (seed, fds) => {
  const result = new Set(seed);
  let changed;
  do {
    changed = false;
    for (const { left, right } of fds) {
      if (left.every(a => result.has(a))) {
        for (const a of right) if (!result.has(a)) {
          result.add(a);
          changed = true;
        }
      }
    }
  } while (changed);
  return result;
};

const models = new Map();
for (const match of logical.matchAll(/^([a-z_]+)\(([a-z_, ]+)\)$/gm)) {
  assert.ok(!models.has(match[1]), `Duplicate schema: ${match[1]}`);
  const attrs = names(match[2]);
  assert.equal(new Set(attrs).size, attrs.length, `Duplicate attribute: ${match[1]}`);
  models.set(match[1], { attrs });
}
assert.equal(models.size, 14);
for (const match of normalization.matchAll(/^\| ([a-z_]+) \| ([^|]+) \| ([^|]+) \|$/gm)) {
  const model = models.get(match[1]);
  assert.ok(model, `Undefined FD relation: ${match[1]}`);
  assert.ok(!model.keys, `Duplicate FD definition: ${match[1]}`);
  model.keys = keys(match[2].trim());
  model.fds = model.keys.map(left => ({ left, right: model.attrs.filter(a => !left.includes(a)) }));
}

let candidateKeys = 0;
let foreignKeys = 0;
for (const [name, model] of models) {
  assert.ok(model.keys?.length, `Missing FD definition: ${name}`);
  const section = logical.split(`### ${name}\n`)[1]?.split(/\n###? /)[0];
  assert.ok(section, `Missing relation section: ${name}`);
  const row = label => {
    const line = section.split('\n').find(l => l.startsWith(`| ${label} | `));
    assert.ok(line, `Missing ${label}: ${name}`);
    return line.slice(`| ${label} | `.length).replace(/ \|$/, '');
  };
  const logicalKeys = keys(row('PK / CK').split('; CK ')[1]);
  assert.deepEqual(logicalKeys.map(signature).sort(), model.keys.map(signature).sort(), `Key drift: ${name}`);
  const declaredPk = names(row('PK / CK').split(';')[0].replace(/^PK /, ''));
  assert.ok(model.keys.some(k => signature(k) === signature(declaredPk)), `PK not candidate: ${name}`);
  const [nullableText, fkText] = row('nullable / FK').split(' / ');
  const nullable = nullableText === '없음' ? [] : nullableText.split('·');
  for (const attr of nullable) assert.ok(model.attrs.includes(attr), `Unknown nullable attribute: ${name}.${attr}`);
  const domains = row('속성 도메인').split('; ').flatMap(s => s.split(':')[0].split('·'));
  assert.deepEqual([...domains].sort(), [...model.attrs].sort(), `Domain coverage: ${name}`);
  for (const key of model.keys) {
    candidateKeys++;
    for (const attr of key) {
      assert.ok(model.attrs.includes(attr), `Unknown key attribute: ${name}.${attr}`);
      assert.ok(!nullable.includes(attr), `Nullable candidate: ${name}.${attr}`);
    }
    assert.equal(closure(key, model.fds).size, model.attrs.length, `Key closure: ${name}`);
    for (const removed of key) {
      assert.ok(closure(key.filter(a => a !== removed), model.fds).size < model.attrs.length, `Nonminimal key: ${name}`);
    }
  }
  // Enumerate minimal keys independently under the supplied FD basis.
  const discovered = [];
  for (let mask = 0; mask < 2 ** model.attrs.length; mask++) {
    const seed = model.attrs.filter((_, i) => mask & (1 << i));
    if (closure(seed, model.fds).size !== model.attrs.length) continue;
    if (seed.some(a => closure(seed.filter(b => b !== a), model.fds).size === model.attrs.length)) continue;
    discovered.push(signature(seed));
  }
  assert.deepEqual(discovered.sort(), model.keys.map(signature).sort(), `Candidate enumeration: ${name}`);
  const prime = new Set(model.keys.flat());
  for (const fd of model.fds) {
    const superkey = closure(fd.left, model.fds).size === model.attrs.length;
    assert.ok(superkey || fd.right.every(a => prime.has(a)), `3NF: ${name}`);
  }
  model.foreignKeys = [];
  if (fkText !== '없음') for (const fk of fkText.split('; ')) {
    const m = /^(\([^)]*\)|[a-z_]+) → ([a-z_]+)\.(\([^)]*\)|[a-z_]+)$/.exec(fk);
    assert.ok(m, `FK notation: ${name}: ${fk}`);
    const local = names(m[1]), parent = models.get(m[2]), remote = names(m[3]);
    assert.ok(parent, `Unknown FK parent: ${name}`);
    assert.equal(local.length, remote.length);
    assert.ok(local.every(a => model.attrs.includes(a)) && remote.every(a => parent.attrs.includes(a)));
    const extra = m[2] === 'bookings' && logical.includes('UQ(id, hold_id)') ? [['id', 'hold_id']] : [];
    assert.ok([...parent.keys, ...extra].some(k => k.join(',') === remote.join(',')), `FK parent unique tuple: ${name}`);
    model.foreignKeys.push({ local, parent: m[2], remote });
    foreignKeys++;
  }
}

const rename = (name, mapping) => {
  const m = models.get(name), swap = a => mapping[a] ?? a;
  return { attrs: m.attrs.map(swap), fds: m.fds.map(f => ({ left: f.left.map(swap), right: f.right.map(swap) })) };
};
const booking = rename('bookings', { id: 'booking_id', status: 'booking_status', created_at: 'booked_at' });
const inventory = rename('inventory', { id: 'inventory_id' });
const performance = rename('performances', { id: 'performance_id' });
const losses = [
  [booking, { attrs: ['booking_id', 'inventory_id', 'performance_id', 'physical_seat_id', 'grade', 'price', 'blocked', 'grade_snapshot', 'price_snapshot'], fds: [] }],
  [inventory, rename('booking_items', {})],
  [performance, rename('concerts', { id: 'concert_id' })],
  [performance, rename('venues', { id: 'venue_id' })],
  [inventory, rename('physical_seats', { id: 'physical_seat_id' })],
  [booking, rename('holds', { id: 'hold_id', status: 'hold_status' })]
];
for (const [left, right] of losses) {
  const common = left.attrs.filter(a => right.attrs.includes(a));
  const reached = closure(common, [...left.fds, ...right.fds]);
  assert.ok(common.length && (left.attrs.every(a => reached.has(a)) || right.attrs.every(a => reached.has(a))), 'Lossless intersection condition');
}
assert.ok(!closure(['grade'], models.get('inventory').fds).has('price'), 'False grade/price FD');
assert.ok(!closure(['inventory_id'], models.get('booking_items').fds).has('price_snapshot'), 'False snapshot FD');
assert.ok(!closure(['user_id', 'performance_id'], models.get('holds').fds).has('id'), 'Partial unique is not a full key');
assert.ok(!closure(['booking_id'], models.get('payment_attempts').fds).has('id'), 'Nullable unique is not a full key');

const files = ['docs/data-model/conceptual.md', 'docs/data-model/logical.md', 'docs/data-model/normalization.md', 'docs/data-model/physical.md'];
let localLinks = 0;
for (const file of files) {
  const body = await read(file);
  assert.ok(!/[\ufffd\u3040-\u30ff\u3400-\u9fff]/.test(body), `Unexpected text encoding/language: ${file}`);
  assert.equal((body.match(/^```/gm) ?? []).length % 2, 0, `Unclosed fence: ${file}`);
  for (const match of body.matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:\/\//i.test(target)) continue;
    await access(resolve(dirname(resolve(root, file)), target));
    localLinks++;
  }
}
console.log(JSON.stringify({ relations: models.size, candidateKeys, foreignKeys, losslessExamples: losses.length, checkedDocuments: files.length, localLinks, status: 'passed', scope: 'documented FD basis and structure only; no database access' }, null, 2));
