// Developer tests for the protected acceptance path at runtime (D3 §§1.1 to
// 1.4, 4.5, A.4): the JSON scan that finds repeated members, the governed
// file's defaults and refusals, a definition's rules, the requirement index
// parser, discovery of a scratch repository's tree, the check-tree
// materialization, and the output capture's bounds.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { scanJson, parseGoverned, parseDefinition, defaultGoverned, criterionErrors, checkFingerprint } = await import(join(dist, 'checks', 'schema.js'));
const { parseRequirementIndex } = await import(join(dist, 'checks', 'requirement-index.js'));
const { discover } = await import(join(dist, 'checks', 'discovery.js'));
const { materialize, releaseTree, listTrees } = await import(join(dist, 'checks', 'checktree.js'));
const { OutputCapture } = await import(join(dist, 'checks', 'run.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

const GOV = '.surety/checks/protected-policy.json';
const def = (key, fields) => JSON.stringify({ schema: 1, key, ...fields });
const smoke = (key, extra = {}) => def(key, { kind: 'smoke', command: ['probe'], timeout_s: 60, gate_kinds: ['stage'], ...extra });
const withProbe = () => {
  const g = defaultGoverned();
  g.check_commands = { probe: { path: '/usr/bin/true' } };
  return g;
};

test('scanJson finds a repeated member and names it by pointer; JSON otherwise as JSON.parse', () => {
  assert.deepEqual(scanJson('{"a": {"b": 1, "b": 2}}'), { ok: false, code: 'duplicate_entry', pointer: '/a/b' });
  assert.deepEqual(scanJson('{"a": [1, {"x": "y"}]}'), { ok: true, value: { a: [1, { x: 'y' }] } });
  assert.equal(scanJson('{"a": 1,}').ok, false);
  assert.equal(scanJson('{"a": 1} x').ok, false);
  assert.deepEqual(scanJson('"\\u00e9"'), { ok: true, value: 'é' });
});

test('the governed file: absent fields and members take A.4 defaults; refused values are errors at their pointer and never clamped', () => {
  assert.deepEqual(parseGoverned(null), { governed: defaultGoverned(), errors: [] });
  const r = parseGoverned(JSON.stringify({ runner_config: { direct: { timeout_max_s: 100000 }, remote: {} }, result_collection: { output_max_bytes: 10 }, required_checks: ['a', 'a'] }));
  assert.equal(r.governed.runner_config.direct.timeout_max_s, 600);
  assert.equal(r.governed.result_collection.output_max_bytes, 65536);
  assert.deepEqual(
    r.errors.map((e) => [e.path, e.code]).sort(),
    [
      [`${GOV}#/required_checks/1`, 'duplicate_entry'],
      [`${GOV}#/result_collection/output_max_bytes`, 'invalid_value'],
      [`${GOV}#/runner_config/direct/timeout_max_s`, 'invalid_value'],
      [`${GOV}#/runner_config/remote`, 'unknown_field'],
    ].sort(),
  );
  // A program outside the system directories and read_paths is refused.
  const p = parseGoverned(JSON.stringify({ check_commands: { a: { path: '/opt/x' }, b: ['node'] } }));
  assert.deepEqual(p.errors.map((e) => e.path).sort(), [`${GOV}#/check_commands/a/path`, `${GOV}#/check_commands/b`]);
  assert.equal(parseGoverned(JSON.stringify({ check_commands: { a: { path: '/opt/x/run' } }, runner_config: { direct: { read_paths: ['/opt/x'] } } })).errors.length, 0);
});

test('a definition: defaults, the key, covers by kind, engine variables, and inputs expanded to a manifest of regular files', () => {
  const entries = [
    { path: GOV, type: 'blob', mode: '100644', oid: 'a'.repeat(40) },
    { path: '.surety/checks/data.txt', type: 'blob', mode: '100644', oid: 'b'.repeat(40) },
    { path: '.surety/checks/run.sh', type: 'blob', mode: '100755', oid: 'c'.repeat(40) },
    { path: '.surety/checks/link', type: 'blob', mode: '120000', oid: 'd'.repeat(40) },
    { path: 'src/app.js', type: 'blob', mode: '100644', oid: 'e'.repeat(40) },
  ];
  const g = withProbe();
  const linked = parseDefinition('.surety/checks/defs/s.json', 's', smoke('s'), g, entries);
  assert.deepEqual(linked.errors, [{ path: '.surety/checks/link', code: 'input_not_regular' }], 'a link under the roots is refused under default inputs, by its own path');
  assert.ok(linked.definition, 'and the definition is still discovered');
  const ok = parseDefinition('.surety/checks/defs/s.json', 's', smoke('s'), g, entries.filter((e) => e.mode !== '120000'));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(
    { origin: ok.definition.origin, cwd: ok.definition.cwd, runner_class: ok.definition.runner_class, egress: ok.definition.egress, requires: ok.definition.requires },
    { origin: 'acceptance', cwd: '.', runner_class: 'direct', egress: [], requires: [] },
  );
  assert.deepEqual(
    ok.manifest.map((m) => m[0]),
    ['.surety/checks/data.txt', '.surety/checks/run.sh'],
    'default inputs: every regular file under the roots but the governed file',
  );
  const regular = entries.filter((e) => e.mode !== '120000');
  const codes = (text, stem = 'x', within = regular) => parseDefinition(`.surety/checks/defs/${stem}.json`, stem, text, g, within).errors.map((e) => e.code);
  assert.deepEqual(codes(smoke('y')), ['key_mismatch']);
  assert.deepEqual(codes(smoke('x', { covers: { criteria: ['R1.1'] } })), ['covers_not_allowed']);
  assert.deepEqual(codes(smoke('x', { env: { SURETY_X: '1' } })), ['invalid_value']);
  assert.deepEqual(codes(smoke('x', { inputs: ['.surety/checks/link'] }), 'x', entries), ['input_not_regular']);
  assert.deepEqual(codes(smoke('x', { inputs: ['src/app.js'] })), ['input_outside_roots']);
  assert.deepEqual(codes(smoke('x', { inputs: [GOV] })), ['invalid_value']);
  assert.deepEqual(codes(smoke('x', { command: ['other'] })), ['program_not_allowed']);
  assert.deepEqual(codes(def('x', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: ['stage'] })), ['invalid_value'], 'an acceptance check names a criterion');
  const acc = parseDefinition('.surety/checks/defs/a.json', 'a', def('a', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: ['stage'], covers: { criteria: ['R1.1', 'R2.1'] } }), g, entries);
  assert.deepEqual(criterionErrors([{ path: '.surety/checks/defs/a.json', criteria: acc.definition.covers.criteria }], new Set(['R1.1'])), [{ path: '.surety/checks/defs/a.json#/covers/criteria/1', code: 'criterion_unknown' }]);
  // The fingerprint moves with the manifest's mode, not only the content.
  const other = ok.manifest.map((m) => (m[0].endsWith('run.sh') ? [m[0], m[1], '100644', m[3]] : m));
  assert.notEqual(checkFingerprint(ok.definition, ok.manifest, g), checkFingerprint(ok.definition, other, g));
});

test('the requirement index: rows parsed; a malformed row, an unknown area, a foreign or repeated criterion refused with its row', () => {
  const head = '| Key | Title | Phase | Sensitive areas | Criteria |\n|---|---|---|---|---|\n';
  const r = parseRequirementIndex(`${head}| R1 | login | 1 | authentication | R1.1, R1.2 |\n| R2 | report | 2 | none | R2.1 |\n`);
  assert.deepEqual(r, {
    ok: true,
    rows: [
      { key: 'R1', title: 'login', phase: 1, sensitive_areas: ['authentication'], criteria: ['R1.1', 'R1.2'] },
      { key: 'R2', title: 'report', phase: 2, sensitive_areas: [], criteria: ['R2.1'] },
    ],
  });
  assert.equal(parseRequirementIndex(`${head}| R1 | a | 1 | none |\n`).row, 1);
  assert.equal(parseRequirementIndex(`${head}| R1 | a | 1 | magic | R1.1 |\n`).row, 1);
  assert.equal(parseRequirementIndex(`${head}| R1 | a | 1 | none | R1.1 |\n| R2 | b | 1 | none | R1.2 |\n`).row, 2);
  assert.equal(parseRequirementIndex(`${head}| R1 | a | 1 | none | R1.1, R1.1 |\n`).ok, false);
});

function scratchRepo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { env });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env }).toString().trim();
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 24, home: dir, incarnation: 'inc_unit' });
  return { dir, repo, head };
}

test('discovery of a tree: the governed values, the checks, the required set, and a required key with no definition', async (t) => {
  const { repo, head } = scratchRepo(t, {
    [GOV]: JSON.stringify({ check_commands: { probe: { path: '/usr/bin/true' } }, required_checks: ['a', 'ghost'] }),
    '.surety/checks/defs/a.json': smoke('a'),
    '.surety/checks/defs/b.json': smoke('b'),
    '.surety/checks/expect.txt': 'x\n',
    'src/app.js': 'export const a = 1;\n',
  });
  const d = await discover(repo, head);
  assert.deepEqual(
    d.checks.map((c) => [c.key, c.required]),
    [
      ['a', true],
      ['b', false],
    ],
  );
  assert.deepEqual(d.errors, [{ path: `${GOV}#/required_checks/1`, code: 'required_key_without_definition' }]);
  assert.equal(await discover(repo, '0'.repeat(40)), null, 'an unreadable tree is not an empty one');
});

test('a check tree: the source projection without the roots or .git, the inputs by object id, reused, and removed', async (t) => {
  const { dir, repo, head } = scratchRepo(t, {
    [GOV]: '{}',
    '.surety/checks/expect.txt': 'expected\n',
    'src/app.js': 'export const a = 1;\n',
  });
  const home = join(dir, 'home');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  const oid = execFileSync('git', ['-C', repo, 'rev-parse', `${head}:.surety/checks/expect.txt`]).toString().trim();
  const project = `proj_${'0'.repeat(26)}`;
  const version = `pv_${'1'.repeat(26)}`;
  const args = { home, scratch: join(home, 'tmp'), repo, project, revision: head, version, roots: ['.surety/checks/'], manifests: [[['.surety/checks/expect.txt', 'blob', '100644', oid]]], maxEntries: 1000, maxBytes: 1 << 30 };
  const tree = await materialize(args);
  assert.equal(readFileSync(join(tree.src, 'src/app.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(existsSync(join(tree.src, '.surety')), false, 'the candidate copy of the protected paths is never in the projection');
  assert.equal(existsSync(join(tree.src, '.git')), false);
  assert.equal(readFileSync(join(tree.protected, '.surety/checks/expect.txt'), 'utf8'), 'expected\n');
  assert.deepEqual(await materialize(args), tree, 'the same triple is reused');
  assert.deepEqual(listTrees(home, project), [{ revision: head, version }]);
  releaseTree(home, project, head, version);
  assert.equal(existsSync(tree.root), false);
  await assert.rejects(materialize({ ...args, maxEntries: 0 }), /checktree_max_entries/);
  assert.deepEqual(listTrees(home, project), [], 'a failed build leaves nothing');
});

test('the output capture keeps the first and last halves of its bound and counts what it dropped', () => {
  const c = new OutputCapture(10);
  c.push(Buffer.from('0123456789'));
  c.push(Buffer.from('abcdef'));
  assert.equal(c.bytes().toString(), '01234bcdef');
  assert.equal(c.dropped, 6);
});

test("D3 A.7's keys are configuration: defaults, ranges, and checktrees_max_bytes never below checktree_max_bytes", async () => {
  const { validateEngineConfig } = await import(join(dist, 'config', 'engine-config.js'));
  const v = validateEngineConfig({}).values;
  assert.deepEqual([v.check_timeout_max, v.check_output_max_bytes, v.check_infra_retries_max], [1800, 1048576, 2]);
  assert.throws(() => validateEngineConfig({ check_timeout_max: 5 }), (err) => err.code === 'invalid_value');
  assert.throws(() => validateEngineConfig({ checktree_max_bytes: 4294967296, checktrees_max_bytes: 3221225472 }), (err) => err.code === 'invalid_value' && err.subject.field === 'checktrees_max_bytes');
  assert.equal(validateEngineConfig({ checktree_max_bytes: 67108864, checktrees_max_bytes: 67108864 }).values.checktrees_max_bytes, 67108864);
});
