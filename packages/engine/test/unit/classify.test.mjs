// Developer tests for the diff classifier (D3 §§3.1 to 3.3, A.2; B02; N01;
// T03; Q5): classify() over two sides built from file maps with the real
// schema functions, the class rule, the authority in force, and the
// configuration key `classifier_authority`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { classify, kindOf, authorityInForce, CLASSIFIER_VERSION, runningClassifierVersion } = await import(join(dist, 'checks', 'classify.js'));
const { parseGoverned, parseDefinition, checkFingerprint } = await import(join(dist, 'checks', 'schema.js'));
const { validateEngineConfig } = await import(join(dist, 'config', 'engine-config.js'));

const GOV = '.surety/checks/protected-policy.json';
const RUN = (key) => `.surety/checks/run/${key}.txt`;
const DEF = (key) => `.surety/checks/defs/${key}.json`;
const COMMANDS = { probe: { path: '/usr/bin/true' } };
const oid = (text) => createHash('sha1').update(text).digest('hex');

// A side as classify() takes it, from {path: text | {content, mode}}: the
// governed file and the definitions parsed by the real schema functions,
// every file an entry (all are taken to lie under the roots of the test).
function side(files) {
  const entries = Object.entries(files)
    .map(([path, v]) => {
      const content = typeof v === 'string' ? v : v.content;
      const mode = typeof v === 'string' ? '100644' : v.mode;
      return [path, mode === '120000' ? 'blob' : 'blob', mode, oid(content)];
    })
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const tree = entries.map(([path, type, mode, o]) => ({ path, type, mode, oid: o }));
  const { governed, errors } = parseGoverned(typeof files[GOV] === 'string' ? files[GOV] : null);
  const checks = [];
  const dir = governed.check_discovery.definitions;
  for (const [path, v] of Object.entries(files)) {
    if (!path.startsWith(dir) || !path.endsWith('.json') || path.slice(dir.length).includes('/')) continue;
    const stem = path.slice(dir.length, -'.json'.length);
    const parsed = parseDefinition(path, stem, typeof v === 'string' ? v : v.content, governed, tree);
    errors.push(...parsed.errors);
    if (parsed.definition === null) continue;
    const d = parsed.definition;
    checks.push({
      key: d.key,
      path,
      definition: d,
      input_manifest: parsed.manifest,
      fingerprint: checkFingerprint(d, parsed.manifest, governed),
      criteria: d.covers?.criteria ?? [],
      required: governed.required_checks === null || governed.required_checks.includes(d.key),
    });
  }
  return { discovery: { governed, checks, errors }, entries };
}

const gov = (fields) => JSON.stringify({ check_commands: COMMANDS, ...fields });
const def = (key, fields) => JSON.stringify({ schema: 1, key, kind: 'smoke', command: ['probe', key], timeout_s: 60, gate_kinds: ['stage'], ...fields });
const declared = (key, fields = {}) => def(key, { inputs: [RUN(key)], ...fields });

function base(extra = {}) {
  return {
    [GOV]: gov({ protected_paths: ['.surety/checks/'] }),
    [DEF('a')]: declared('a', { kind: 'acceptance', covers: { criteria: ['R1.1'] } }),
    [DEF('s')]: declared('s'),
    [RUN('a')]: 'a\n',
    [RUN('s')]: 's\n',
    '.surety/checks/README.md': 'readme\n',
    ...extra,
  };
}
const KNOWN = new Set(['R1.1', 'R1.2']);
const shape = (c) => c.elements.map((e) => (e.check ? `${e.reason}:${e.check}` : e.path ? `${e.reason}@${e.path}` : e.reason)).sort();
const run = (before, after, known = KNOWN) => classify(side(before), side(after), known);

test('a new check with declared inputs alone is a tightening, check_added', () => {
  const c = run(base(), base({ [DEF('n')]: declared('n'), [RUN('n')]: 'n\n' }));
  assert.equal(c.change_kind, 'tightening');
  assert.deepEqual(shape(c), ['check_added:n']);
  assert.deepEqual(c.affected_checks, [{ check: 'n', reasons: ['added'] }]);
});

test('the same new check under default inputs changes every default-input check: unclassifiable', () => {
  const b = base({ [DEF('a')]: def('a', { kind: 'acceptance', covers: { criteria: ['R1.1'] } }) });
  const c = run(b, { ...b, [DEF('n')]: def('n'), [RUN('n')]: 'n\n' });
  assert.equal(c.change_kind, 'unclassifiable');
  assert.ok(shape(c).includes('input_changed:a') && shape(c).includes('check_added:n'), shape(c).join());
});

test('criteria lost, a gate kind gained: loosening beside strict, both recorded', () => {
  const c = run(base(), base({ [DEF('a')]: declared('a', { kind: 'acceptance', covers: { criteria: ['R1.2'] }, gate_kinds: ['stage', 'alpha_authorize'] }) }));
  assert.equal(c.change_kind, 'loosening');
  assert.deepEqual(shape(c), ['criteria_added:a', 'criteria_removed:a', 'gate_kinds_added:a']);
  assert.deepEqual(c.affected_checks, [{ check: 'a', reasons: ['definition_changed', 'applicability_changed'] }]);
});

test('tier_floor: removed is lowered, added is raised', () => {
  const t2 = base({ [DEF('s')]: declared('s', { tier_floor: 'T2' }) });
  assert.deepEqual(shape(run(t2, base())), ['tier_floor_lowered:s']);
  assert.deepEqual(shape(run(base(), t2)), ['tier_floor_raised:s']);
  assert.deepEqual(shape(run(t2, base({ [DEF('s')]: declared('s', { tier_floor: 'T3' }) }))), ['tier_floor_raised:s']);
});

test('a root added is root_layout_changed; narrowed, also root_removed; removed alone, a loosening (B02)', () => {
  const two = base({ [GOV]: gov({ protected_paths: ['.surety/checks/', 'docs/p/'] }), 'docs/p/x.md': 'x\n', 'docs/p/sub/y.md': 'y\n' });
  const added = run(base({ 'docs/p/x.md': 'x\n', 'docs/p/sub/y.md': 'y\n' }), { ...two });
  assert.equal(added.change_kind, 'unclassifiable');
  assert.deepEqual(shape(added), ['no_strict_change', 'root_layout_changed@docs/p/']);
  const narrowed = run(two, { ...two, [GOV]: gov({ protected_paths: ['.surety/checks/', 'docs/p/sub/'] }) });
  assert.deepEqual(shape(narrowed), ['root_layout_changed@docs/p/sub/', 'root_removed@docs/p/']);
  const removed = run(two, { ...two, [GOV]: gov({ protected_paths: ['.surety/checks/'] }) });
  assert.equal(removed.change_kind, 'loosening');
  assert.deepEqual(shape(removed), ['root_removed@docs/p/']);
});

test('a phase change or an added area beside a new check stays unclassifiable: nothing hides (T03)', () => {
  const plus = { [DEF('n')]: declared('n'), [RUN('n')]: 'n\n' };
  const phase = run(base(), base({ [DEF('s')]: declared('s', { phase: 2 }), ...plus }));
  assert.equal(phase.change_kind, 'unclassifiable');
  assert.deepEqual(shape(phase), ['check_added:n', 'unhandled_change:s']);
  const withFloor = base({ [DEF('f')]: declared('f', { kind: 'sensitivity_floor', covers: { sensitive_areas: ['authentication'] } }), [RUN('f')]: 'f\n' });
  const area = run(withFloor, { ...withFloor, [DEF('f')]: declared('f', { kind: 'sensitivity_floor', covers: { sensitive_areas: ['authentication', 'personal_data'] } }), ...plus });
  assert.deepEqual(shape(area), ['check_added:n', 'unhandled_change:f']);
});

test("an input's executable bit and content are input_changed; an execution field is execution_field_changed", () => {
  const mode = run(base(), base({ [RUN('a')]: { content: 'a\n', mode: '100755' } }));
  assert.deepEqual(shape(mode), ['input_changed:a', 'no_strict_change']);
  assert.deepEqual(mode.affected_checks, [{ check: 'a', reasons: ['input_changed'] }]);
  const timeout = run(base(), base({ [DEF('s')]: declared('s', { timeout_s: 90 }) }));
  assert.deepEqual(shape(timeout), ['execution_field_changed:s', 'no_strict_change']);
});

test('neutral changes only: neutral_file_changed per path and no_strict_change, unclassifiable', () => {
  const c = run(base(), base({ '.surety/checks/README.md': 'reworded\n' }));
  assert.equal(c.change_kind, 'unclassifiable');
  assert.deepEqual(shape(c), ['neutral_file_changed@.surety/checks/README.md', 'no_strict_change']);
  assert.deepEqual(c.affected_checks, []);
});

test('required_checks: a list introduced omitting a check is required_key_removed, affected required_changed only (N01)', () => {
  const c = run(base(), base({ [GOV]: gov({ protected_paths: ['.surety/checks/'], required_checks: ['a'] }) }));
  assert.equal(c.change_kind, 'loosening');
  assert.deepEqual(shape(c), ['required_key_removed:s']);
  assert.deepEqual(c.affected_checks, [{ check: 's', reasons: ['required_changed'] }]);
  const back = run(base({ [GOV]: gov({ protected_paths: ['.surety/checks/'], required_checks: ['a'] }) }), base({ [GOV]: gov({ protected_paths: ['.surety/checks/'], required_checks: ['a', 's'] }) }));
  assert.deepEqual(shape(back), ['no_strict_change', 'required_key_added_alone:s']);
  const withNew = run(
    base({ [GOV]: gov({ protected_paths: ['.surety/checks/'], required_checks: ['a', 's'] }) }),
    base({ [GOV]: gov({ protected_paths: ['.surety/checks/'], required_checks: ['a', 's', 'n'] }), [DEF('n')]: declared('n'), [RUN('n')]: 'n\n' }),
  );
  assert.deepEqual(shape(withNew), ['check_added:n', 'required_key_added_with_check:n']);
});

test('a governed field change is governed_field_changed; a criterion the index lacks is a discovery_error (L5)', () => {
  const g = run(base(), base({ [GOV]: gov({ protected_paths: ['.surety/checks/'], result_collection: { output_max_bytes: 131072 } }) }));
  assert.deepEqual(shape(g), [`governed_field_changed@${GOV}#/result_collection`, 'no_strict_change']);
  const ghost = run(base(), base({ [DEF('g')]: declared('g', { kind: 'acceptance', covers: { criteria: ['R9.1'] } }), [RUN('g')]: 'g\n' }));
  assert.equal(ghost.change_kind, 'unclassifiable');
  assert.ok(ghost.elements.some((e) => e.reason === 'discovery_error' && e.path === `${DEF('g')}#/covers/criteria/0`), shape(ghost).join());
  const unparsed = run(base(), base({ [DEF('s')]: '{"schema": 1' }));
  assert.ok(!shape(unparsed).includes('check_removed:s'), 'a definition that no longer parses is an error, not a removal');
  assert.equal(unparsed.change_kind, 'unclassifiable');
});

test("D3 §3.1's class rule, and the authority in force (Q5)", () => {
  assert.equal(kindOf([]), 'unclassifiable');
  assert.equal(kindOf([{ reason: 'check_added' }]), 'tightening');
  assert.equal(kindOf([{ reason: 'check_added' }, { reason: 'check_removed' }]), 'loosening');
  assert.equal(kindOf([{ reason: 'check_added' }, { reason: 'input_changed' }]), 'unclassifiable');
  assert.equal(kindOf([{ reason: 'neutral_file_changed' }]), 'unclassifiable');
  assert.equal(authorityInForce(undefined, 1), 'recommend');
  assert.equal(authorityInForce({ mode: 'recommend' }, 1), 'recommend');
  assert.equal(authorityInForce({ mode: 'authoritative', version: 2 }, 1), 'recommend');
  assert.equal(authorityInForce({ mode: 'authoritative', version: 1 }, 1), 'authoritative');
  assert.equal(runningClassifierVersion(), CLASSIFIER_VERSION, 'outside harness mode the running version is the built one');
});

test('classifier_authority: the default, an accepted value, and every refusal', () => {
  assert.deepEqual(validateEngineConfig({}).values.classifier_authority, { mode: 'recommend' });
  assert.deepEqual(validateEngineConfig({ classifier_authority: { mode: 'authoritative', version: 7 } }).values.classifier_authority, { mode: 'authoritative', version: 7 });
  for (const bad of ['recommend', null, { mode: 'authoritative' }, { mode: 'sometimes' }, { mode: 'authoritative', version: '1' }, { mode: 'authoritative', version: 1.5 }, { mode: 'recommend', other: 1 }]) {
    assert.throws(
      () => validateEngineConfig({ classifier_authority: bad }),
      (err) => err.code === 'invalid_value' && err.subject?.field === 'classifier_authority',
      JSON.stringify(bad),
    );
  }
});
