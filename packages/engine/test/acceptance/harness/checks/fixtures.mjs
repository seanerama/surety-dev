// Fixtures, commands and reads for the M3 rows of slice 15 (M201 to M205;
// SEAM.md §§177 to 185): projects whose protected set holds a governed file
// and check definitions, the requirement index through the plan fixture,
// the runner qualification fixture, the protected-version read, the
// candidate's check executions (store and routes), the gate read's per-check
// entries, and, for the sandbox lane, the test-owned check program and the
// host-side reads of the domain it runs in.
//
// Nothing here records a check result: results come only from the engine's
// own executions (D3 §2.6). The check-result fixture of SEAM §67 is not used
// by any slice-15 case.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { installProject, sha256Hex, waitFor } from '../engine.mjs';
import { askingForTicks, GOVERNED_FILE } from '../gates.mjs';
import { hasIdForm } from '../ids.mjs';
import { recordFile } from '../records.mjs';
import { makeProjectRepo, refOid, gitQuiet } from '../repos.mjs';
import { hasTable, withStore } from '../store.mjs';
import { procsOf } from '../sandbox/cgroup.mjs';
import { hostProcess } from '../sandbox/procs.mjs';

export { GOVERNED_FILE };
export const DEFS_DIR = '.surety/checks/defs/';
export const defPath = (key) => `${DEFS_DIR}${key}.json`;

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// ---- the governed file and definitions (D3 §§1.1 to 1.3, A.4) -----------------------------

// The text of a governed file holding exactly `fields`.
export const governedText = (fields) => `${JSON.stringify(fields, null, 2)}\n`;

// The text of a definition: schema 1, the key, and `fields` as given. A
// field given as undefined is left out.
export function definitionText(key, fields = {}) {
  const def = { schema: 1, key };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) def[k] = v;
  return `${JSON.stringify(def, null, 2)}\n`;
}

// A smoke check: covers no criterion, so it needs no requirement index.
export const smoke = (key, { command = ['probe'], gates = ['stage', 'alpha_authorize'], timeout = 60, ...rest } = {}) =>
  definitionText(key, { kind: 'smoke', command, timeout_s: timeout, gate_kinds: gates, ...rest });

// An acceptance check covering `criteria`.
export const acceptance = (key, criteria, { command = ['probe'], gates = ['stage', 'alpha_authorize'], timeout = 60, ...rest } = {}) =>
  definitionText(key, { kind: 'acceptance', command, timeout_s: timeout, gate_kinds: gates, covers: { criteria }, ...rest });

// A program path no check runs: discovery reads `check_commands` and never
// executes or stats a program (D3 §1.4). Used by the kernel-lane rows.
export const KERNEL_COMMANDS = Object.freeze({ probe: { path: '/usr/bin/true' } });

// ---- repositories with entries of every git type --------------------------------------------

// Commit `entries` on `ref` with plumbing, on top of the ref's commit. Each
// value is a string (a regular file, mode 100644), or {content, mode}
// (mode '100644' or '100755'), {link: target} (a symlink, 120000) or
// {gitlink: <40-hex commit id>} (a submodule entry, 160000). Returns the commit.
export function commitEntries(repo, ref, entries, message = 'fixture: protected entries') {
  const base = refOid(repo, ref);
  const index = join(repo, '.git', `fixture-index-${process.hrtime.bigint()}`);
  const env = { GIT_INDEX_FILE: index };
  if (base) gitQuiet(repo, ['read-tree', base], { env });
  for (const [path, value] of Object.entries(entries)) {
    let mode = '100644';
    let oid;
    if (typeof value === 'string') oid = gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: value });
    else if (value.link !== undefined) {
      mode = '120000';
      oid = gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: value.link });
    } else if (value.gitlink !== undefined) {
      mode = '160000';
      oid = value.gitlink;
    } else {
      mode = value.mode ?? '100644';
      oid = gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: value.content });
    }
    gitQuiet(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`], { env });
  }
  const tree = gitQuiet(repo, ['write-tree'], { env });
  const commit = gitQuiet(repo, ['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', message]);
  gitQuiet(repo, ['update-ref', ref, commit]);
  return commit;
}

// A project installed by the fixture on a repository whose first commit
// holds `files` (regular files), then, if given, a second commit with
// `entries` (any git type). `plant(repo)` runs before the project is
// installed, so a hostile configuration is in place when discovery reads the
// tree. Returns {id, repo, base}.
export async function checkProject(fx, { files = {}, entries, tier = 'T1', plant, name } = {}) {
  const n = ++fx.repos;
  const repo = makeProjectRepo(join(fx.root, `repo-${n}`), { files });
  if (entries !== undefined) commitEntries(repo.path, repo.ref, entries);
  if (plant !== undefined) plant(repo);
  const id = await installProject(fx.engine, { repoPath: repo.path, name: name ?? `check-project-${n}`, tier, branch: repo.branch });
  return { id, repo, base: refOid(repo.path, repo.ref) };
}

// ---- the requirement index through the plan fixture (SEAM.md §179) --------------------------

// The text of the requirement index (the spec template's section 5; D3 §4.5).
// `rows` are [{key, title?, phase?, areas?, criteria}]; areas default to none.
export function indexText(rows) {
  const lines = ['| Key | Title | Phase | Sensitive areas | Criteria |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.key} | ${r.title ?? `requirement ${r.key}`} | ${r.phase ?? 1} | ${(r.areas ?? []).length === 0 ? 'none' : r.areas.join(', ')} | ${r.criteria.join(', ')} |`);
  return `${lines.join('\n')}\n`;
}

// A plan whose approved spec's requirements are registered from the index.
// Returns the fixture's answer: {plan, stages, requirements: [{id, key, criteria, sensitive_areas}]}.
export async function installIndexedPlan(engine, project, { index, stages, modules }) {
  const body = { project, requirements: index.map((r) => ({ key: r.key })), requirement_index: indexText(index), stages };
  if (modules !== undefined) body.modules = modules;
  const res = await engine.post('/v1/harness/fixtures/plan', body);
  assert.equal(res.status, 201, `the plan fixture registers the requirement index through the index parser (SEAM.md §179) (body: ${res.text})`);
  for (const row of index) {
    const got = res.body.requirements?.find((r) => r.key === row.key);
    assert.ok(got, `the plan fixture answers with requirement ${row.key} (body: ${res.text})`);
    assert.deepEqual([got.criteria, got.sensitive_areas], [row.criteria, row.areas ?? []], `requirement ${row.key} is registered with the index's criteria and areas`);
  }
  return res.body;
}

// ---- the runner qualification fixture (SEAM.md §181) ---------------------------------------

export async function qualifyRunnerByFixture(engine) {
  const res = await engine.post('/v1/harness/fixtures/runner-qualification', { runner_class: 'direct' });
  assert.equal(res.status, 201, `the runner qualification fixture marks direct qualified, labelled test_fixture (SEAM.md §181) (body: ${res.text})`);
  assert.equal(typeof res.body?.host_qualification, 'string', `it names the host qualification it labelled (body: ${res.text})`);
  return res.body.host_qualification;
}

export const hostQualificationRow = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "host_qualifications" WHERE "id" = ?').get(id));
  return row ? { ...row, check_runner: json(row.check_runner) } : null;
};

// ---- the protected-version read (SEAM.md §178) ----------------------------------------------

export async function versionRead(engine, project, version) {
  const res = await engine.get(`/v1/projects/${project}/protected-versions/${version}`);
  assert.equal(res.status, 200, `GET the protected version ${version} (SEAM.md §178) (body: ${res.text})`);
  const v = res.body?.version;
  assert.ok(v && Array.isArray(v.discovery_errors) && Array.isArray(v.checks) && typeof v.governed === 'object', `the version read has governed, discovery_errors and checks (body: ${res.text})`);
  return v;
}

export const errorsAt = (version, file) => version.discovery_errors.filter((e) => e.path === file || e.path.startsWith(`${file}#`));
export const codesAt = (version, file) => errorsAt(version, file).map((e) => e.code);
export const checkByKey = (version, key) => version.checks.find((c) => c.key === key);

// ---- check executions (SEAM.md §180) ---------------------------------------------------------

function assertExecutionsTable(db) {
  assert.ok(hasTable(db, 'check_executions'), 'the store has check_executions (D3 A.3): the engine registers check executions');
}

const execRow = (row) => ({ ...row, trigger: json(row.trigger), toolchain: json(row.toolchain), init_reports: json(row.init_reports) });

// Every execution of a candidate, oldest registration first, each with its check's key.
export const executionsOf = (home, candidate) =>
  withStore(home, (db) => {
    assertExecutionsTable(db);
    return db
      .prepare('SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."candidate" = ? ORDER BY x."execution_seq"')
      .all(candidate)
      .map(execRow);
  });

export const executionRow = (home, id) =>
  withStore(home, (db) => {
    assertExecutionsTable(db);
    const row = db.prepare('SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."id" = ?').get(id);
    return row ? execRow(row) : null;
  });

export const allExecutionCount = (home) =>
  withStore(home, (db) => {
    assertExecutionsTable(db);
    return db.prepare('SELECT COUNT(*) AS n FROM "check_executions"').get().n;
  });

export const resultCount = (home) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "check_results"').get().n);

// The identity of a registration's trigger and key, for "once per trigger generation and key".
export const triggerKey = (x) => `${x.trigger?.source}|${x.trigger?.id}|${x.trigger?.generation}|${x.key}`;

// No two registrations share a trigger identity (D3 §2.5).
export function assertOncePerTrigger(executions, what) {
  const seen = new Map();
  for (const x of executions) seen.set(triggerKey(x), (seen.get(triggerKey(x)) ?? 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(twice, [], `${what}: exactly one registration per trigger generation and key`);
}

export const checksRowsOf = (home, version) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "checks" WHERE "protected_version" = ? ORDER BY "key"').all(version)).map((row) => ({ ...row, gate_kinds: json(row.gate_kinds) }));

// GET /v1/projects/:p/candidates/:c/checks (D3 A.7; SEAM.md §180).
export async function listExecutions(engine, project, candidate) {
  const res = await engine.get(`/v1/projects/${project}/candidates/${candidate}/checks`);
  assert.equal(res.status, 200, `GET the candidate's check executions (body: ${res.text})`);
  assert.ok(Array.isArray(res.body?.executions), `the read lists executions (body: ${res.text})`);
  return res.body.executions;
}

// POST /v1/projects/:p/candidates/:c/checks: the raw response.
export const requestChecks = (engine, project, candidate, body = {}) => engine.post(`/v1/projects/${project}/candidates/${candidate}/checks`, body);

// ---- results and their output records -------------------------------------------------------

export const resultRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(id));
export const resultsOfProject = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "project" = ? ORDER BY "execution_seq"').all(project));

// The bytes of a result's output record, as text. The record is required to exist and be readable.
export function outputText(home, result) {
  assert.ok(result.output, `result ${result.id} names its output record (D3 §2.6: every established result names one)`);
  const record = withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(result.output));
  assert.ok(record, `the output record ${result.output} exists`);
  assert.equal(record.kind, 'check_output', `the output record is a check_output record (${record.kind})`);
  assert.ok(record.path !== null, `the output record ${record.id} has its bytes`);
  return readFileSync(recordFile(home, record), 'utf8');
}

// The program's report in an output record (SEAM.md §182), parsed.
export function programReport(text) {
  const line = text.split('\n').find((l) => l.startsWith('SURETY-CHECK-REPORT '));
  assert.ok(line, `the check program's report is in its output record (output: ${JSON.stringify(text.slice(0, 400))})`);
  return JSON.parse(line.slice('SURETY-CHECK-REPORT '.length));
}

// Ask for ticks until every key in `keys` has an execution of the candidate
// with a recorded result. Returns {key: execution row}.
export async function waitRecorded(fx, project, candidate, keys, { what = 'the checks to be recorded' } = {}) {
  return askingForTicks(
    fx,
    project,
    () => {
      const latest = {};
      for (const x of executionsOf(fx.home, candidate)) if (keys.includes(x.key)) latest[x.key] = x;
      return keys.every((k) => latest[k]?.status === 'recorded' && latest[k]?.result) ? latest : undefined;
    },
    what,
  );
}

// ---- the gate's per-check entries (SEAM.md §183) ---------------------------------------------

export function gateCheckEntries(evaluation) {
  assert.ok(evaluation.checks && typeof evaluation.checks === 'object', `the evaluation carries a checks entry per required check (SEAM.md §183) (keys: ${Object.keys(evaluation).join(', ')})`);
  assert.deepEqual(Object.keys(evaluation.checks).sort(), Object.keys(evaluation.check_states).sort(), 'one checks entry per required check, the same ids as check_states');
  return evaluation.checks;
}

export const entryByKey = (entries, key) => Object.entries(entries).find(([, e]) => e.key === key)?.[1];

// ---- the check program in the sandbox lane (SEAM.md §182) -----------------------------------

const PROGRAM_SOURCE = new URL('./program.mjs', import.meta.url);

// The node installation the program's shebang names, as read_paths: none
// when it lies under the system directories every check domain has.
export function nodeReadPaths() {
  const prefix = dirname(dirname(process.execPath));
  return ['/usr', '/bin', '/lib', '/lib64'].some((sys) => prefix === sys || prefix.startsWith(`${sys}/`)) ? [] : [prefix];
}

// Install the check program in a directory of the test's own:
// <dir>/program.mjs (executable, with a shebang naming the test's node), an
// empty <dir>/release/, and <dir>/not-executable, a file of mode 0644 that a
// check_commands entry can name so that the exec fails (M205 (e)).
export function installCheckProgram(root) {
  const dir = join(root, 'checks');
  mkdirSync(join(dir, 'release'), { recursive: true });
  const program = join(dir, 'program.mjs');
  writeFileSync(program, `#!${process.execPath}\n${readFileSync(PROGRAM_SOURCE, 'utf8')}`);
  chmodSync(program, 0o755);
  const noexec = join(dir, 'not-executable');
  writeFileSync(noexec, '#!/bin/sh\nexit 0\n');
  chmodSync(noexec, 0o644);
  return { dir, program, noexec, releaseDir: join(dir, 'release'), readPaths: [dir, ...nodeReadPaths()] };
}

// The governed file of a sandbox-lane project whose checks run the program.
export function sandboxGoverned(prog, extra = {}) {
  return governedText({
    protected_paths: ['.surety/checks/'],
    check_commands: { probe: { path: prog.program }, noexec: { path: prog.noexec } },
    runner_config: { direct: { read_paths: prog.readPaths } },
    ...extra,
  });
}

// Arguments that make the program hold at `name` until the test releases it.
export const holdArgs = (prog, name) => ['--hold', name, '--release-dir', prog.releaseDir];
export const release = (prog, name) => writeFileSync(join(prog.releaseDir, name), '');

// The first execution of the candidate that is running in its domain with
// the program's host process a member of the domain's cgroup, holding at
// the hold `holds[key]` for its key. `holds` is {key: hold name}. Returns
// {key, execution, domain, member}.
export async function heldExecution(fx, project, candidate, holds) {
  return askingForTicks(
    fx,
    project,
    () => {
      for (const x of executionsOf(fx.home, candidate)) {
        const hold = holds[x.key];
        if (hold === undefined || x.status !== 'running' || !x.domain) continue;
        const domain = domainOfExecution(fx.home, x);
        if (!domain?.cgroup_path) continue;
        let pids;
        try {
          pids = procsOf(domain.cgroup_path);
        } catch {
          continue;
        }
        for (const pid of pids) {
          const p = hostProcess(pid);
          if (p && p.cmdline.some((a) => a.endsWith('/program.mjs')) && p.cmdline.includes('--hold') && p.cmdline.includes(hold)) return { key: x.key, execution: x, domain, member: p };
        }
      }
      return undefined;
    },
    `a check of ${Object.keys(holds).join(', ')} to be running in its domain, its program held`,
  );
}

export const domainOfExecution = (home, x) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(x.domain));
  return row ? { ...row, launch_binding: json(row.launch_binding) } : null;
};

// Every entry under $SURETY_HOME/checktrees/, host-read: [{path, type}], no link followed.
export function checktreeEntries(home) {
  const root = join(home, 'checktrees');
  assert.ok(existsSync(root), `the engine home has checktrees/ (D3 §2.4; build spec §5)`);
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      out.push({ path: full, name, type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other' });
      if (st.isDirectory() && !st.isSymbolicLink()) visit(full);
    }
  };
  visit(root);
  return out;
}

export const fileHolding = (entries, content) => entries.some((e) => e.type === 'file' && sha256Hex(readFileSync(e.path)) === sha256Hex(content));

export const machineId = () => readFileSync('/etc/machine-id', 'utf8').trim();

export { hasIdForm, waitFor };
