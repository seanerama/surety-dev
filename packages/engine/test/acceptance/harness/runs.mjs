// Fixtures, commands and waits for the slice-2 rows (SEAM.md §§12–18): an
// engine with the scripted backend, projects and work installed as fixtures,
// ticks on request, Stop, Abandon, Resume and decisions through the public
// API, and assertions that join the store to the file system and to the
// scripted role's own log.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { freePort, installProject, makeTempDir, removeDir, sha256Hex, startEngine, waitFor, writeEngineConfig } from './engine.mjs';
import { assertRefused } from './fixtures.mjs';
import { git, makeRepo } from './git.mjs';
import { hasIdForm, newId } from './ids.mjs';
import { assertDispatched, assertEndedRun, assertQuarantinedRun } from './invariants.mjs';
import { Scripted } from './scripted.mjs';
import { withStore } from './store.mjs';

// Ticks only when a test asks; short real-time grace periods.
export const SLICE2_CONFIG = Object.freeze({ tick_interval: 600, terminate_grace: 2, kill_grace: 1 });

// A home, a scripted directory and (unless start is false) a running engine
// in harness mode with the scripted backend. `fx.start(opts)` starts another
// engine on the same home: after a kill, without --harness, or with barriers.
// With `homeSymlink`, $SURETY_HOME is a symbolic link to the directory that
// holds the engine's files; `fx.home` is the link, as the engine is given it.
export async function scriptedEngine(t, { config = {}, barriers = [], until = 'full', start = true, homeSymlink = false } = {}) {
  const root = makeTempDir('s2');
  const home = join(root, 'home');
  if (homeSymlink) {
    mkdirSync(join(root, 'home-real'));
    symlinkSync(join(root, 'home-real'), home);
  } else mkdirSync(home);
  const scripted = new Scripted(join(root, 'scripted'));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, ...SLICE2_CONFIG, ...config });
  const fx = { root, home, port, scripted, engine: null, engines: [], repos: 0 };
  t.after(async () => {
    for (const e of fx.engines) await e.kill();
    scripted.killStrays();
    removeDir(root);
  });
  fx.start = async ({ barriers: armed = [], harness = true, withScripted = true, until: state = 'full', timeoutMs, args: more = [] } = {}) => {
    const args = [...(harness && withScripted ? scripted.flag : []), ...armed.flatMap((b) => ['--harness-barrier', b]), ...more];
    const engine = await startEngine({ home, port, harness, args, until: state, timeoutMs });
    fx.engines.push(engine);
    fx.engine = engine;
    return engine;
  };
  if (start) await fx.start({ barriers, until });
  return fx;
}

// A fixture project on its own real repository. Needs a running harness engine.
export async function addProject(fx, { name, tier = 'T2' } = {}) {
  const n = ++fx.repos;
  const repo = makeRepo(join(fx.root, `repo-${n}`));
  const id = await installProject(fx.engine, { repoPath: repo.path, name: name ?? `fixture-project-${n}`, tier });
  return { id, repo };
}

const expectStatus = (res, statuses, what) => {
  if (![statuses].flat().includes(res.status)) throw new Error(`${what} → ${res.status} ${res.text}`);
  return res;
};

// ---- fixtures ------------------------------------------------------------------

// Observe a trigger (SEAM.md §15). Returns the raw response as well, so a
// test can assert a refusal.
export async function observeTrigger(engine, { project, kind, source = 'test', id, generation = 1, subject, depends_on }) {
  const body = { project, kind, trigger_source: source, trigger_id: id, trigger_generation: generation };
  if (subject !== undefined) body.subject = subject;
  if (depends_on !== undefined) body.depends_on = depends_on;
  const res = await engine.post('/v1/harness/fixtures/trigger', body);
  return { res, status: res.status, created: res.body?.created, workItem: res.body?.work_item?.id };
}

// One new eligible work item of `kind`, from a trigger nothing else uses.
export async function addWork(engine, project, kind, { subject, depends_on } = {}) {
  const trigger = { source: 'test', id: newId('trg_'), generation: 1 };
  const seen = await observeTrigger(engine, { project, kind, ...trigger, subject, depends_on });
  assert.equal(seen.status, 201, `trigger fixture for a ${kind} item (body: ${seen.res.text})`);
  assert.equal(seen.created, true, 'a new trigger identity creates its work item');
  assert.ok(hasIdForm(seen.workItem, 'wi_'), `work item id form: ${seen.workItem}`);
  return seen.workItem;
}

export async function installPlan(engine, project, stages) {
  const res = expectStatus(await engine.post('/v1/harness/fixtures/plan', { project, stages }), 201, 'plan fixture');
  assert.ok(hasIdForm(res.body?.plan?.id, 'plan_'), `plan id form: ${res.text}`);
  assert.equal(res.body.stages?.length, stages.length, 'one stage row per stage sent');
  return res.body;
}

// One new eligible work item of any dispatched kind. A stage_build item is
// the work of a stage, so it comes from a one-stage plan.
export async function addWorkOfKind(engine, project, kind) {
  if (kind !== 'stage_build') return addWork(engine, project, kind);
  const plan = await installPlan(engine, project, [{ number: 1, goal: 'a stage to build' }]);
  return plan.stages[0].work_item;
}

// Ask the engine's work-item transition function for one edge (SEAM.md §15).
export const forceTransition = (engine, workItem, to) => engine.post(`/v1/harness/work/${workItem}/transition`, { to });

// Step an item through a route of legal edges.
export async function driveTo(engine, workItem, route) {
  for (const to of route) {
    const res = await forceTransition(engine, workItem, to);
    assert.equal(res.status, 200, `legal step to ${to} for ${workItem} (body: ${res.text})`);
    assert.equal(res.body?.work_item?.status, to, `the transition route reports the new status (body: ${res.text})`);
  }
}

// ---- ticks ---------------------------------------------------------------------

export const requestTick = async (engine, project) => expectStatus(await engine.post(`/v1/projects/${project}/tick`, {}), 202, 'tick request');

const lastTickSeq = (home) => withStore(home, (db) => db.prepare(`SELECT COALESCE(MAX("seq"), 0) AS n FROM "events" WHERE "type" = 'engine.tick'`).get().n);

// Run the scheduler and return once a tick that started after this call has
// finished. Two request-and-wait rounds: the first engine.tick seen may
// belong to a tick that was already under way; the second cannot.
//
// Each round sends one request, whatever the number of projects. The tick is
// engine-wide (SEAM.md §15): one request runs every step for every project,
// and the project in the route only has to exist. A request per project
// asked for as many ticks as there were projects, the round returned at the
// first one's end, and the others were still pending or under way when this
// returned: a tick nobody waited for could then dispatch work that the test
// had not finished setting up (SEAM.md §24, "Timing"). With one request per
// round, and no tick under way when this is called, none is when it returns.
export async function tick(engine, projects, { rounds = 2, timeoutMs } = {}) {
  const [project] = [projects].flat();
  for (let i = 0; i < rounds; i++) {
    const before = lastTickSeq(engine.home);
    await requestTick(engine, project);
    await waitFor(() => lastTickSeq(engine.home) > before, { timeoutMs, what: 'a tick to finish (an engine.tick event)' });
  }
}

// Exactly one tick: request it and wait for its engine.tick event. Only for
// use when no tick is under way and none is pending. Returns that event's seq.
export async function tickOnce(engine, project, { timeoutMs } = {}) {
  const before = lastTickSeq(engine.home);
  await requestTick(engine, project);
  return waitFor(
    () => {
      const seq = lastTickSeq(engine.home);
      return seq > before ? seq : undefined;
    },
    { timeoutMs, what: 'the requested tick to finish (an engine.tick event)' },
  );
}

// Tick until `done()` returns something, waiting after each tick for the runs
// it started to end. For work whose scripts all finish by themselves.
export async function tickUntil(engine, projects, done, { max = 12, what = 'the expected state' } = {}) {
  for (let i = 0; i <= max; i++) {
    const value = await done();
    if (value !== undefined && value !== false && value !== null) return value;
    if (i === max) break;
    await tick(engine, projects);
    await waitForIdle(engine.home, projects);
  }
  throw new Error(`${what} was not reached after ${max} ticks`);
}

// ---- commands ------------------------------------------------------------------

// Stop and Abandon: the first request raises the confirmation decision, the
// second consumes it with its preview hash (SEAM.md §17).
export async function confirmCommand(engine, path) {
  const first = await engine.post(path, {});
  assertRefused(first, 409, 'confirm_required', `${path} without a preview hash`);
  const { decision, preview_hash: previewHash } = first.body.subject ?? {};
  assert.ok(hasIdForm(decision, 'dec_'), `confirm_required names its decision: ${first.text}`);
  assert.ok(typeof previewHash === 'string' && previewHash.length > 0, `confirm_required carries the preview hash: ${first.text}`);
  const second = await engine.post(path, { preview_hash: previewHash });
  assert.equal(second.status, 200, `${path} with the preview hash (body: ${second.text})`);
  return { decision, previewHash, response: second };
}

export const stopRun = (engine, project, run) => confirmCommand(engine, `/v1/projects/${project}/runs/${run}/stop`);
export const abandonRun = (engine, project, run) => confirmCommand(engine, `/v1/projects/${project}/runs/${run}/abandon`);

export const pauseProject = async (engine, project) => expectStatus(await engine.post(`/v1/projects/${project}/pause`, {}), 200, 'pause');
export const resumeProject = async (engine, project) => expectStatus(await engine.post(`/v1/projects/${project}/resume`, {}), 200, 'resume project');

export const resumeWork = async (engine, project, workItem) =>
  expectStatus(await engine.post(`/v1/projects/${project}/work/${workItem}/resume`, {}), 200, `resume ${workItem}`);

export async function answerDecision(engine, project, decision, option) {
  const row = getRow(engine.home, 'decisions', decision);
  assert.ok(row, `decision ${decision} exists`);
  const keys = JSON.parse(row.options).map((o) => o.key);
  assert.ok(keys.includes(option), `decision ${decision} offers "${option}" (it offers ${keys.join(', ')})`);
  return expectStatus(
    await engine.post(`/v1/projects/${project}/decisions/${decision}/answer`, { option, preview_hash: row.preview_hash }),
    200,
    `answer ${decision} with ${option}`,
  );
}

export const advanceClock = async (engine, seconds) => expectStatus(await engine.post('/v1/harness/clock/advance', { seconds }), 200, 'clock advance');

// The slack a comparison between an engine timestamp and the controlled
// clock allows for a host clock that steps back (SEAM.md §23).
export const CLOCK_SLACK_MS = 2000;

// Move the clock forward by `seconds` in steps shorter than the lease TTL the
// test configured, leaving real time between steps for the roles' heartbeats
// to renew their leases. So nothing expires merely because the clock moved,
// and what the test observes is the deadline it is about.
//
// The pause alone assumed that a renewal lands inside it. Before another
// step is taken, this now also waits, for a bounded time, until every run
// lease that is live (unreleased and not closing) has been renewed since the
// step just taken: an engine that was slow for a moment gets its renewal in
// before the clock moves again. A renewal that never comes is not waited for
// beyond the bound, and the test's own assertions then say what is wrong.
export async function advanceClockInSteps(engine, seconds, { stepSeconds, pauseMs = 1200, renewalWaitMs = 5000 } = {}) {
  let left = seconds;
  while (left > 0) {
    const stepNow = Math.min(left, stepSeconds);
    const { now } = (await advanceClock(engine, stepNow)).body;
    left -= stepNow;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (left <= 0) break;
    const renewed = () =>
      withStore(engine.home, (db) => db.prepare(`SELECT "renewed_at" FROM "leases" WHERE "resource_kind" = 'run' AND "released_at" IS NULL AND "closing" = 0`).all()).every(
        (lease) => Date.parse(lease.renewed_at) >= Date.parse(now) - CLOCK_SLACK_MS,
      );
    await waitFor(renewed, { timeoutMs: renewalWaitMs, what: 'every live run lease to be renewed after a step of the clock' }).catch(() => {});
  }
}

export async function allocate(engine, run) {
  const res = expectStatus(await engine.post('/v1/harness/allocate', { run }), 200, `allocate for ${run}`);
  assert.ok(hasIdForm(res.body?.invocation, 'inv_'), `allocation returns an invocation id: ${res.text}`);
  return res.body.invocation;
}

// ---- store reads ---------------------------------------------------------------

export const getRow = (home, table, id) => withStore(home, (db) => db.prepare(`SELECT * FROM "${table}" WHERE "id" = ?`).get(id));
export const workItem = (home, id) => getRow(home, 'work_items', id);
export const run = (home, id) => getRow(home, 'runs', id);

// The runs of a work item, oldest first.
export const runsOf = (home, workItemId) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"').all(workItemId));

export const runsOfProject = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "project" = ? ORDER BY "seq"').all(project));

export const decisionsAbout = (home, subjectId, kind) =>
  withStore(home, (db) =>
    db.prepare('SELECT * FROM "decisions" WHERE "subject_id" = ? AND "kind" = ? ORDER BY "id"').all(subjectId, kind),
  );

// Every lease that names a run, oldest first.
export const leasesOf = (home, runId) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "leases" WHERE "resource_id" = ? ORDER BY "id"').all(runId));

export const countOf = (home, table, where = '1 = 1', ...params) =>
  withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...params).n);

// ---- waits ---------------------------------------------------------------------

// The (index+1)-th run of a work item, once it exists and, if `state` is
// given, once it is in that state (or one of those states).
export function waitForRun(home, workItemId, { index = 0, state, timeoutMs } = {}) {
  const wanted = state === undefined ? null : [state].flat();
  return waitFor(
    () => {
      const found = runsOf(home, workItemId)[index];
      if (!found) return undefined;
      return wanted === null || wanted.includes(found.state) ? found : undefined;
    },
    { timeoutMs, what: `run ${index + 1} of ${workItemId}${wanted ? ` to be ${wanted.join(' or ')}` : ''}` },
  );
}

export function waitForRunState(home, runId, state, { timeoutMs } = {}) {
  const wanted = [state].flat();
  return waitFor(
    () => {
      const row = run(home, runId);
      return row && wanted.includes(row.state) ? row : undefined;
    },
    { timeoutMs, what: `run ${runId} to be ${wanted.join(' or ')}` },
  );
}

// No run of these projects is still under way (a quarantined run counts as settled).
export function waitForIdle(home, projects, { timeoutMs } = {}) {
  const ids = [projects].flat();
  return waitFor(() => ids.every((p) => runsOfProject(home, p).every((r) => r.state === 'ended' || r.quarantined === 1)), {
    timeoutMs,
    what: `every run of ${ids.join(', ')} to end`,
  });
}

export const waitForQuarantine = (home, runId, opts = {}) =>
  waitFor(
    () => {
      const row = run(home, runId);
      return row && row.quarantined === 1 ? row : undefined;
    },
    { timeoutMs: opts.timeoutMs, what: `run ${runId} to be quarantined` },
  );

export function waitForWork(home, workItemId, status, { timeoutMs } = {}) {
  const wanted = [status].flat();
  return waitFor(
    () => {
      const row = workItem(home, workItemId);
      return row && wanted.includes(row.status) ? row : undefined;
    },
    { timeoutMs, what: `work item ${workItemId} to be ${wanted.join(' or ')}` },
  );
}

// ---- assertions that join the store, the file system and the launch log -------------

const repoOf = (home, project) => getRow(home, 'projects', project).dev_repo_path;

const worktreePaths = (repo) =>
  git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();

// A path with its symbolic links resolved, which is how git prints a
// worktree. The part of it that no longer exists (a discarded workspace) is
// kept as given.
export function resolvedPath(path) {
  let head = path;
  const tail = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...tail);
}

// The worktrees registered in a project's repository, other than its main
// work tree, that no `workspaces` row of the project names. Paths are
// compared with their symbolic links resolved.
export function unownedWorktrees(home, project) {
  const repo = repoOf(home, project);
  const owned = new Set(
    withStore(home, (db) => db.prepare('SELECT "path" FROM "workspaces" WHERE "project" = ?').all(project)).map((w) => resolvedPath(w.path)),
  );
  return worktreePaths(repo)
    .map(resolvedPath)
    .filter((path) => path !== resolvedPath(repo) && !owned.has(path));
}

// The git_worktree operations journaled for a run under one journal kind
// (`worktree_add` or `worktree_remove`), oldest first, each with its status
// and the kinds of its journal events in order.
export function worktreeOperations(home, runId, journalKind) {
  return withStore(home, (db) =>
    db
      .prepare(
        `SELECT o."id", o."status" FROM "operations" o
         WHERE o."kind" = 'git_worktree' AND EXISTS (
           SELECT 1 FROM "git_journal_events" e
           WHERE e."operation" = o."id" AND e."journal_kind" = ? AND json_extract(e."payload", '$.run') = ?)
         ORDER BY o."seq"`,
      )
      .all(journalKind, runId)
      .map((op) => ({
        ...op,
        events: db.prepare('SELECT "event_kind" FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"').all(op.id).map((e) => e.event_kind),
      })),
  );
}

// The run has ended as SEAM.md §16 says, and its workspace is where its
// disposition says: still there when retained, gone and unregistered when
// discarded.
export function assertRunEnded(home, runId, expect = {}) {
  const facts = withStore(home, (db) => assertEndedRun(db, runId, expect));
  for (const ws of facts.workspaces) {
    const repo = repoOf(home, facts.run.project);
    if (ws.disposition === 'retained') assert.ok(isDirectory(ws.path), `retained workspace ${ws.path} is still there`);
    if (ws.disposition === 'discarded') {
      assert.ok(!existsSync(ws.path), `discarded workspace ${ws.path} is gone`);
      assert.ok(!worktreePaths(repo).includes(ws.path), `discarded workspace ${ws.path} is no longer a worktree of ${repo}`);
    }
  }
  return facts;
}

export function assertRunQuarantined(home, runId, expect = {}) {
  const facts = withStore(home, (db) => assertQuarantinedRun(db, runId, expect));
  for (const ws of facts.workspaces) assert.ok(isDirectory(ws.path), `quarantined workspace ${ws.path} is untouched`);
  return facts;
}

// What a dispatch wrote, with the workspace checked on disk and in git.
export function assertRunDispatched(home, runId, phase, expect = {}) {
  const facts = withStore(home, (db) => assertDispatched(db, runId, phase, expect));
  const ws = facts.workspaces[0];
  const repo = repoOf(home, facts.run.project);
  assert.ok(ws.path.startsWith(`${join(home, 'workspaces')}/`), `workspace ${ws.path} is under the engine home's workspaces/`);
  assert.ok(isDirectory(ws.path), `workspace ${ws.path} exists`);
  assert.ok(worktreePaths(repo).includes(ws.path), `workspace ${ws.path} is a worktree of ${repo}`);
  assert.equal(git(ws.path, ['rev-parse', 'HEAD']), facts.run.base_revision, 'the workspace is checked out at the run base');
  assert.equal(git(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'the workspace HEAD is detached');
  const journal = withStore(home, (db) =>
    db
      .prepare(
        `SELECT e."event_kind" FROM "git_journal_events" e JOIN "operations" o ON o."id" = e."operation"
         WHERE o."kind" = 'git_worktree' AND e."journal_kind" = 'worktree_add' AND json_extract(e."payload", '$.run') = ?
         ORDER BY e."seq"`,
      )
      .all(runId),
  );
  assert.equal(journal[0]?.event_kind, 'intended', `the workspace was created through the journal: a worktree_add journal naming the run, starting with intended (events: ${journal.map((j) => j.event_kind).join(', ') || 'none'})`);
  return facts;
}

const REQUEST_KEYS = ['domain', 'invocation', 'project', 'role', 'run', 'work_item', 'work_kind', 'workspace'];

// The scripted role's own record of its launch agrees with the store, and
// the launch followed SEAM.md §13. Returns the launch entry.
export function assertLaunchMatchesStore(fx, runId) {
  const facts = withStore(fx.home, (db) => {
    const r = db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(runId);
    const domain = db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(runId);
    return {
      run: r,
      work: db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(r.work_item),
      domain,
      own: db.prepare('SELECT * FROM "process_ownership" WHERE "domain" = ?').get(domain.id),
      ws: db.prepare('SELECT * FROM "workspaces" WHERE "run" = ?').get(runId),
    };
  });
  const launches = fx.scripted.launches({ run: runId });
  assert.equal(launches.length, 1, `exactly one process was launched for run ${runId}`);
  const l = launches[0];
  assert.equal(l.request_error, undefined, `the request arrived on stdin: ${l.request_error}`);
  for (const key of REQUEST_KEYS) assert.ok(l.request_keys.includes(key), `the request has "${key}" (keys: ${l.request_keys.join(', ')})`);
  assert.equal(l.invocation, facts.domain.invocation, 'SURETY_INVOCATION is the receipt id');
  assert.equal(l.domain, facts.domain.id, 'SURETY_DOMAIN is the execution domain id');
  assert.equal(l.project, facts.run.project, 'request project');
  assert.equal(l.work_item, facts.run.work_item, 'request work item');
  assert.equal(l.work_kind, facts.work.kind, 'request work kind');
  assert.equal(l.role, facts.run.role, 'request role');
  assert.equal(l.workspace, facts.ws.path, 'request workspace');
  assert.equal(l.cwd, facts.ws.path, 'the role runs in the workspace');
  assert.deepEqual(l.argv, [], 'the program is launched with no further arguments');
  assert.equal(l.pgrp, l.pid, 'the role leads a new process group');
  assert.ok(!l.env_keys.includes('SURETY_HOME'), `the engine's environment is not inherited (keys: ${l.env_keys.join(', ')})`);
  assert.ok(!l.env_value_hashes.includes(sha256Hex(fx.engine.token())), 'no environment value is the API token');
  if (facts.own.pid !== null) {
    assert.equal(facts.own.pid, l.pid, 'process_ownership.pid is the launched process');
    assert.equal(facts.own.pgid, l.pgrp, 'process_ownership.pgid is its process group');
    assert.equal(String(facts.own.pid_start_time), String(l.start_time), 'process_ownership.pid_start_time is its start time');
  }
  return l;
}
