// The test side of the trust table in the kernel lane (M2 slice 10, rows
// M101 to M109; SEAM.md §§113 to 121): the stand-in backend binary, the
// fixture routes that install trust entries and qualification attempts, the
// engine-scoped decisions (`trust_activation`, `qualification_approval`)
// and the reads of `GET /v1/engine` these rows make.
//
// Nothing here qualifies a backend. A fixture entry is test setup, labelled
// as such in the events it causes, as M1's baseline approvals were (Plan
// §1; E19; M2 plan §2.3): it says what an entry would hold, so that the
// rules about entries can be tested before any attempt has run.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvalsOf, assertPreview, decision, decisionsOn, intentsOf } from './decisions.mjs';
import { sha256Hex, waitFor } from './engine.mjs';
import { assertRefused } from './fixtures.mjs';
import { changePolicy } from './journal.mjs';
import { hasIdForm } from './ids.mjs';
import { addGitProject } from './gitruns.mjs';
import { scriptedEngine, tick, tickUntil } from './runs.mjs';
import { holdSecret } from './records.mjs';
import { withStore } from './store.mjs';

const PROGRAM = join(dirname(fileURLToPath(import.meta.url)), 'standin', 'backend.mjs');

// The backend names the engine has an adapter for (D2 §4.5, §4.6). A fixture
// entry names one of them; `scripted` never has an entry (K10).
export const BACKENDS = Object.freeze({ claude: 'claude', codex: 'codex' });

// D2's mechanism identifiers (SEAM.md §116): the one isolation and the one
// boundary an entry may name in M2.
export const ISOLATION = 'linux-namespaces-1';
export const BOUNDARY = 'cgroup2-delegated-scope-1';

// The secret reference a backend's provider key is resolved by (SEAM.md §116).
export const apiKeyRef = (backend) => `backend/${backend}/api_key`;

// A stable identity of this installation, never the boot id (M2 plan §2.6;
// SEAM.md §116): the content of /etc/machine-id. A host without it fails the
// cases that read it; a missing lane is not a pass.
export function hostId() {
  assert.ok(existsSync('/etc/machine-id'), 'this host has /etc/machine-id, which the engine takes as its host identity');
  return readFileSync('/etc/machine-id', 'utf8').trim();
}

// ---- the stand-in binary -------------------------------------------------------

// A test-owned executable in `dir`: harness/standin/backend.mjs written with
// a shebang naming this process's node, so the engine's constructed PATH
// cannot keep it from starting. `path` and `sha256` are what a fixture
// entry records; `launches()` is what it recorded of each launch.
export class StandIn {
  // `logDir` (M2 slice 12; SEAM.md §139): where the stand-in logs and looks
  // for its hold, when that is not its own directory. Inside a sandbox the
  // binary's directory is the backend's installation, read-only; a
  // sandbox-lane test names the scripted directory, which the engine binds
  // read-write. The directory is written into the file's first line, so the
  // SHA-256 the entry records covers it.
  constructor(dir, { logDir } = {}) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.logDir = logDir ?? dir;
    this.path = join(dir, 'backend');
    const body = readFileSync(PROGRAM, 'utf8');
    const override = logDir === undefined ? '' : `const LOG_DIR_OVERRIDE = ${JSON.stringify(logDir)};\n`;
    writeFileSync(this.path, `#!${process.execPath}\n${override}${body}`);
    chmodSync(this.path, 0o755);
    this.sha256 = sha256Hex(readFileSync(this.path));
  }

  get binary() {
    return { path: this.path, sha256: this.sha256 };
  }

  get logFile() {
    return join(this.logDir, 'standin.jsonl');
  }

  // Make the next launches wait, after recording, until release() (the
  // stand-in bounds its own wait at two minutes).
  hold() {
    writeFileSync(join(this.logDir, 'standin-hold'), '');
  }

  release() {
    writeFileSync(join(this.logDir, 'standin-release'), '');
  }

  launches(filter = {}) {
    if (!existsSync(this.logFile)) return [];
    const text = readFileSync(this.logFile, 'utf8');
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'launch' && Object.entries(filter).every(([key, value]) => entry[key] === value));
  }

  waitForLaunch(filter = {}, { timeoutMs } = {}) {
    return waitFor(() => this.launches(filter)[0], { timeoutMs, what: `a launch of the stand-in binary matching ${JSON.stringify(filter)}` });
  }
}

// Whether any live process on the host is running the stand-in: read from
// /proc, the host side's view, so that "no process of the backend was ever
// started" rests on more than the stand-in's own log. Returns the pids.
export function standInProcesses(standIn) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').includes(standIn.path)) found.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

// ---- fixture routes (SEAM.md §116) ---------------------------------------------------

const created = (res, what) => {
  assert.equal(res.status, 201, `${what} (body: ${res.text})`);
  return res.body;
};

// Install a trust entry for a real backend name bound to the stand-in
// binary. Everything A.3 requires that `fields` does not give is the
// fixture's default (SEAM.md §116): one `qualification_evidence` record, a
// succeeded fixture attempt, `model_call` granularity with the `invocation`
// boundary enforced by `dispatch_check` under the deadline, D2's mechanism
// identifiers, the current host's identity. A `proposed` entry raises
// `trust_activation` as a succeeded attempt would; an `active` one was
// activated by a fixture decision the fixture answered; a `revoked` one
// carries a fixture reason. Returns {id, attempt, evidence: [record ids],
// decision: the open trust_activation decision's id or null}.
export async function installTrustEntry(engine, standIn, fields = {}) {
  const body = { backend: BACKENDS.claude, status: 'proposed', binary: standIn.binary, ...fields };
  const res = await engine.post('/v1/harness/fixtures/trust-entry', body);
  const out = created(res, `trust-entry fixture (${body.backend}, ${body.status})`);
  assert.ok(hasIdForm(out.trust_entry?.id, 'trust_'), `the fixture answers with the entry's id (body: ${res.text})`);
  assert.ok(hasIdForm(out.qualification_attempt?.id, 'qa_'), `and the attempt that stands as its evidence (body: ${res.text})`);
  assert.ok(Array.isArray(out.evidence) && out.evidence.every((id) => hasIdForm(id, 'rec_')), `and its evidence records (body: ${res.text})`);
  return { id: out.trust_entry.id, attempt: out.qualification_attempt.id, evidence: out.evidence, decision: out.decision ?? null };
}

// The same route, expected to refuse: returns the raw response after the
// status, the refusal shape and the code are checked.
export async function refusedTrustEntry(engine, standIn, fields, { status = 400, code = 'invalid_value', field } = {}) {
  const res = await engine.post('/v1/harness/fixtures/trust-entry', { backend: BACKENDS.claude, status: 'proposed', binary: standIn.binary, ...fields });
  assertRefused(res, status, code, `trust-entry fixture with ${JSON.stringify(fields)}`);
  if (field !== undefined) assert.equal(res.body.subject?.field, field, `the refusal names the field (body: ${res.text})`);
  return res;
}

// Install a qualification attempt for a real backend name bound to the
// stand-in binary, in the status given (SEAM.md §116). Returns its id.
export async function installAttempt(engine, standIn, fields = {}) {
  const body = { backend: BACKENDS.claude, status: 'authorized', binary: standIn.binary, ...fields };
  const res = await engine.post('/v1/harness/fixtures/qualification-attempt', body);
  const out = created(res, `qualification-attempt fixture (${body.backend}, ${body.status})`);
  assert.ok(hasIdForm(out.qualification_attempt?.id, 'qa_'), `the fixture answers with the attempt's id (body: ${res.text})`);
  return out.qualification_attempt.id;
}

// Point a project's roles at a backend (SEAM.md §116): every role unless
// `roles` names some. Not a widening: answered 200 as an ordinary change.
// `extra` adds other ordinary keys to the same change (one commit).
export async function useBackend(engine, project, backend, { roles = ['builder', 'verifier', 'reviewer', 'architect'], mode, extra = {} } = {}) {
  const change = { ...extra, ...Object.fromEntries(roles.map((role) => [`backend_${role}`, backend])) };
  if (mode !== undefined) change.backend_mode = mode;
  return changePolicy(engine, project, change);
}

// The policy of a project whose dispatches are refused on purpose (objection
// 002): a refused item parks at its first refusal instead of returning to
// `eligible` (SEAM.md §15), so that the next item of the project, not the
// refused one again, is what the next tick offers, and a tick the engine
// requests itself cannot refuse the same item twice.
export const PARK_ON_REFUSAL = Object.freeze({ preflight_refusals_max: 1 });

// A kernel-lane engine whose project dispatches its `verification` work to
// a real backend name bound to the stand-in binary (SEAM.md §113): the
// scripted engine of M1, a stand-in directory beside its scripted one, one
// fixture project whose verifier backend is `backend`, and the backend's
// provider key held by the resolver. Returns {fx, standIn, project, key}.
// `policy` adds ordinary keys to the project's one policy commit (the
// refusal rows pass PARK_ON_REFUSAL).
export async function realBackendProject(t, { backend = BACKENDS.claude, roles = ['verifier'], config, key = 'sk-test-key-for-the-stand-in-0001', policy = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  const standIn = new StandIn(join(fx.root, 'standin'));
  // A repository whose integration branch is checked out nowhere, so that a
  // policy change can be committed (SEAM.md §§25, 30).
  const project = (await addGitProject(fx)).id;
  await holdSecret(fx.engine, apiKeyRef(backend), key);
  await useBackend(fx.engine, project, backend, { roles, extra: policy });
  return { fx, standIn, project, key };
}

// ---- store reads ------------------------------------------------------------------------

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export const trustEntry = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "trust_entries" WHERE "id" = ?').get(id));
  return row && { ...row, capabilities: json(row.capabilities), enforceable_boundaries: json(row.enforceable_boundaries), evidence: json(row.evidence), egress_hosts: json(row.egress_hosts) };
};

export const trustEntries = (home) => withStore(home, (db) => db.prepare('SELECT "id" FROM "trust_entries" ORDER BY rowid').all()).map((row) => trustEntry(home, row.id));

export const attemptRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "qualification_attempts" WHERE "id" = ?').get(id));

// Events about one trust entry, oldest first, each with its payload parsed.
export const trustEvents = (home, id, type) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "type" LIKE \'trust.%\' ORDER BY "seq"').all())
    .map((row) => ({ ...row, subject: json(row.subject), payload: json(row.payload) }))
    .filter((row) => row.subject?.trust_entry === id && (type === undefined || row.type === type));

export const eventsNamed = (home, type) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "type" = ? ORDER BY "seq"').all(type)).map((row) => ({ ...row, subject: json(row.subject), payload: json(row.payload) }));

// A trust row's status may be changed only through the engine's transitions
// (SEAM.md §116): attempt one direct change and report whether SQLite
// refused it with a constraint error. Engine stopped.
export function directUpdateRefused(home, sql, ...params) {
  return withStore(
    home,
    (db) => {
      try {
        db.prepare(sql).run(...params);
        return { refused: false, code: null };
      } catch (err) {
        return { refused: true, code: err.code ?? String(err) };
      }
    },
    { readonly: false },
  );
}

// ---- GET /v1/engine (SEAM.md §118) ---------------------------------------------------------

// The trust entry as the engine read shows it.
export function entryShown(info, id) {
  assert.ok(Array.isArray(info.trust_entries), `GET /v1/engine lists trust_entries (it has: ${Object.keys(info).join(', ')})`);
  const shown = info.trust_entries.find((entry) => entry.id === id);
  assert.ok(shown, `GET /v1/engine lists trust entry ${id} (it lists: ${info.trust_entries.map((entry) => entry.id).join(', ') || 'none'})`);
  return shown;
}

// The host qualification as the engine read shows it, with the keys the
// kernel lane reads checked for their form.
export function hostShown(info) {
  const host = info.host_qualification;
  assert.ok(host && typeof host === 'object', `GET /v1/engine has host_qualification (it has: ${Object.keys(info).join(', ')})`);
  assert.ok(typeof host.eligible === 'boolean', `host_qualification.eligible is a boolean (${JSON.stringify(host.eligible)})`);
  assert.ok(['harness', 'qualification'].includes(host.source), `host_qualification.source says where the eligibility comes from (${JSON.stringify(host.source)})`);
  assert.ok(Array.isArray(host.checks), 'host_qualification.checks is a list');
  return host;
}

// ---- engine-scoped decisions (SEAM.md §117) ------------------------------------------------

// GET /v1/decisions: the open engine-scoped decisions.
export async function listEngineDecisions(engine) {
  const res = await engine.get('/v1/decisions');
  assert.equal(res.status, 200, `GET /v1/decisions (body: ${res.text})`);
  assert.ok(Array.isArray(res.body?.decisions), `the read lists decisions (body: ${res.text.slice(0, 300)})`);
  return res.body;
}

// The one open decision of an engine-scoped kind about a subject, ticking
// (through `project`, which only has to exist) until the engine has raised
// it; its preview checked against the contract. The row has no project.
export async function openEngineDecision(fx, project, kind, subjectId, { max = 4 } = {}) {
  const found = await tickUntil(
    fx.engine,
    project,
    () => {
      const open = decisionsOn(fx.home, kind, subjectId).filter((row) => row.status === 'open');
      return open.length > 0 ? open : undefined;
    },
    { max, what: `an open ${kind} decision about ${subjectId}` },
  );
  assert.equal(found.length, 1, `one open ${kind} decision about ${subjectId}, not ${found.length}`);
  assert.equal(found[0].project ?? null, null, `a ${kind} decision is engine-scoped: it belongs to no project`);
  return assertPreview(found[0]);
}

// POST /v1/decisions/:d/answer, with the preview hash of `row` as read.
export const answerEngine = (engine, row, option, previewHash = row.preview_hash) => engine.post(`/v1/decisions/${row.id}/answer`, { option, preview_hash: previewHash });

export async function consumeEngine(fx, row, option) {
  const res = await answerEngine(fx.engine, row, option);
  assert.equal(res.status, 200, `answer ${row.kind} ${row.id} with ${option} (body: ${res.text})`);
  const after = decision(fx.home, row.id);
  assert.deepEqual([after.status, after.answer?.option], ['consumed', option], `the ${row.kind} decision is consumed with the answer given`);
  return after;
}

// An answer on a preview taken before a dependency changed is refused and
// changes nothing (SEAM.md §76, through the engine-scoped route).
export async function assertStaleEngineAnswer(fx, previewed, option) {
  const res = await answerEngine(fx.engine, previewed, option);
  assertRefused(res, 409, ['decision_stale', 'decision_invalidated'], `answering ${previewed.kind} with a preview taken before its dependency changed`);
  const after = decision(fx.home, previewed.id);
  assert.ok(['open', 'invalidated'].includes(after.status), `the decision is not consumed (it is ${after.status})`);
  assert.equal(after.answer ?? null, null, 'no answer is recorded on it');
  assert.equal(approvalsOf(fx.home, previewed.id).length, 0, 'no approval is recorded');
  assert.equal(intentsOf(fx.home, previewed.id).length, 0, 'no effect is intended');
  return res;
}

// The next generation of an engine-scoped decision after a change that
// leaves the question standing (SEAM.md §76): the old one invalidated, a new
// open one with another preview whose manifest differs in `changed`.
export async function nextEngineGeneration(fx, project, previewed, { changed, max = 4 }) {
  const next = await tickUntil(
    fx.engine,
    project,
    () => {
      const open = decisionsOn(fx.home, previewed.kind, previewed.subject_id).filter((row) => row.status === 'open' && row.id !== previewed.id);
      return decision(fx.home, previewed.id).status === 'invalidated' && open.length === 1 ? open[0] : undefined;
    },
    { max, what: `the ${previewed.kind} decision to be invalidated and its next generation raised` },
  );
  assertPreview(next);
  assert.equal(next.semantic_generation, previewed.semantic_generation + 1, 'the next generation follows the one that was invalidated');
  assert.notEqual(next.preview_hash, previewed.preview_hash, 'a changed dependency is a changed preview');
  for (const key of [changed].flat()) assert.notDeepEqual(next.manifest[key], previewed.manifest[key], `the manifests differ in "${key}", the dependency that changed`);
  assert.equal(approvalsOf(fx.home, next.id).length, 0, 'the next generation starts with no approval');
  return next;
}

// The question a rejected engine-scoped decision asked is closed (SEAM.md
// §102, through ticks on `project`): no open decision of that kind about
// that subject, and the rejected one still consumed with its answer.
export async function assertEngineQuestionClosed(fx, project, rejected, { ticks = 3 } = {}) {
  for (let i = 0; i < ticks; i++) await tick(fx.engine, project);
  const open = decisionsOn(fx.home, rejected.kind, rejected.subject_id).filter((row) => row.status === 'open');
  assert.deepEqual(open.map((row) => row.id), [], `no ${rejected.kind} decision about ${rejected.subject_id} is open after the rejection, however many ticks run`);
  const same = decision(fx.home, rejected.id);
  assert.deepEqual([same.status, same.answer?.option], ['consumed', 'reject'], 'the rejected decision is closed with its answer recorded');
  assert.equal(approvalsOf(fx.home, rejected.id).length, 0, 'and still approves nothing');
}
