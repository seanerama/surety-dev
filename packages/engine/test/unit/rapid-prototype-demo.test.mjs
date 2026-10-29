// The disposable end-to-end demonstration of Rapid prototype to Alpha (slice
// E4; the owner's request §10, demonstrations 1, 2, 3, 5, 6, 7, 8, 9 and 10;
// the rulings R1 to R9 of 2026-10-28). One disposable engine (`surety serve
// --harness`, the kernel lane) on a home under $TMPDIR, driven only through
// its HTTP API, with the scripted backend for every role: no model, no paid
// call, no sandbox, no user unit.
//
// What stands in for what:
// - The roles: the scripted role program the engine's `scripted` backend
//   launches (the Verifier's test/acceptance/harness/scripted/child.mjs,
//   copied unchanged into this test's scripted directory, as the harness's
//   own Scripted class copies it; SEAM.md §13). The scripts it follows are
//   written here, by work kind (`scripts/kind-<kind>.json`), by work item or
//   by run: the brief preparation writes .surety/spec/spec.md and reports the
//   brief, the first plan writes the architecture, module map, roadmap and
//   phase-1 plan, the check authoring writes the protected checks, the
//   Builders write the app, each reporting its usage as the scripted
//   provider's `usage` lines.
// - The checks: the kernel lane's scripted check boundary (SEAM.md §190):
//   each queued execution is moved to `recorded` with exit 0 by the harness
//   route; nothing is executed.
// - The deployment: the scripted deployment adapter of the test seam
//   (SEAM.md §247) with the adapter-qualification fixture (§248), as
//   M301-the-walking-deployment and M401's journeys use them: the
//   local_service adapter itself (a systemd user unit) cannot run in a unit
//   test, and no unit is started here.
//
// Slice E5 (the owner's rulings S1 to S5 and the four validation gaps of
// 2026-10-28) adds: a prototype created unpaused with nothing dispatched
// before its preparation's approval (S1); the effective allowance of each
// run, served on its invocations (S5); the unknown committed figure named,
// with only working next steps, raising a limit not reopening it and
// prepare refused (S2, case 7); (11) iteration 2 reaching its own Alpha
// through one bounded phase of its own (S4, gap 3); (12) two stages racing
// on one tick never over-reserving the allowance, and an engine killed and
// restarted mid-run (gaps 1 and 2); (13) a raised limit never undoing a
// Stop, and the deliberate resume (gap 4).
//
// Every assertion is read from the served API (the reads of the project,
// its iterations, the receipt, the decisions, the work, the policy and the
// event stream). The store is read only to drive the scripted boundaries
// (which executions are queued, whether a run is still under way), never to
// assert.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(root, 'dist', 'cli.js');
const CHILD = join(root, 'test', 'acceptance', 'harness', 'scripted', 'child.mjs');

// ---- the disposable engine and its minimal HTTP client -------------------------------------

function request(port, token, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, connection: 'close', ...(token ? { 'x-surety-token': token } : {}) };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, setHost: false, agent: false, timeout: 60_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r, j) => {
    s.once('error', j);
    s.listen(0, '127.0.0.1', r);
  });
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function waitFor(probe, { timeoutMs = 60_000, intervalMs = 50, what = 'a condition' } = {}) {
  const start = performance.now();
  let last;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined && v !== null && v !== false) return v;
    } catch (err) {
      last = err;
    }
    if (performance.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await sleep(intervalMs);
  }
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

class Fixture {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'rpd-'));
    this.home = join(this.dir, 'home');
    this.scripted = join(this.dir, 'scr');
    this.apps = join(this.dir, 'apps');
    assert.ok(Buffer.byteLength(this.home) <= 56, `the disposable engine home is at most 56 bytes (E134): ${this.home}`);
    for (const d of [this.home, join(this.scripted, 'scripts'), join(this.scripted, 'release'), this.apps]) mkdirSync(d, { recursive: true });
    copyFileSync(CHILD, join(this.scripted, 'child.mjs'));
    this.child = null;
    this.stderr = '';
  }

  async cleanup() {
    await this.kill();
    this.killStrays();
    if (process.env.RPD_KEEP === '1') return;
    // Sealed artifacts are read-only: access given back, then removed.
    execFileSync('chmod', ['-R', 'u+rwx', this.dir]);
    rmSync(this.dir, { recursive: true, force: true });
  }

  async start() {
    this.port ??= await freePort();
    writeFileSync(join(this.home, 'config.json'), json({ api_port: this.port, tick_interval: 600, terminate_grace: 2, kill_grace: 1 }));
    const env = { SURETY_HOME: this.home, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.home, LANG: 'C.UTF-8', TZ: 'UTC' };
    this.child = spawn(process.execPath, [CLI, 'serve', '--harness', '--harness-scripted', this.scripted], { env, cwd: this.home, stdio: ['ignore', 'ignore', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', (c) => (this.stderr = (this.stderr + c).slice(-8000)));
    this.exited = new Promise((r) => this.child.once('exit', r));
    await waitFor(
      async () => {
        if (this.child.exitCode !== null) throw Object.assign(new Error(`engine exited: ${this.stderr}`), { fatal: true });
        if (!existsSync(join(this.home, 'api.token'))) return undefined;
        const res = await this.get('/v1/health');
        return res.status === 200 && res.body?.mode === 'full';
      },
      { timeoutMs: 60_000, what: `the engine to be full (${this.stderr.slice(-400)})` },
    );
  }

  // SIGTERM, and SIGKILL after a grace.
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    const done = await Promise.race([this.exited, sleep(20_000).then(() => null)]);
    if (done === null) {
      this.child.kill('SIGKILL');
      await this.exited;
    }
  }

  async kill() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }

  // The scripted role processes of this fixture only, by the exact path of
  // its own copy of the role program (never a pattern kill).
  killStrays() {
    const program = join(this.scripted, 'child.mjs');
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').includes(program)) process.kill(Number(name), 'SIGKILL');
      } catch {
        // gone, or not ours
      }
    }
  }

  token() {
    return readFileSync(join(this.home, 'api.token'), 'utf8').trim();
  }
  get(path) {
    return request(this.port, this.token(), 'GET', path);
  }
  post(path, body = {}) {
    return request(this.port, this.token(), 'POST', path, body);
  }
  put(path, body) {
    return request(this.port, this.token(), 'PUT', path, body);
  }
  async ok(res, status, what) {
    const r = await res;
    assert.equal(r.status, status, `${what} (→ ${r.status} ${r.text.slice(0, 2000)})`);
    return r.body;
  }

  // The event stream (GET /v1/events), from `since`, to what is there now.
  async events(since = 0) {
    const res = await request(this.port, this.token(), 'GET', `/v1/events?since=${since}&limit=100000`);
    assert.equal(res.status, 200, `GET /v1/events (→ ${res.status})`);
    return res.text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
  }
  async lastSeq() {
    const all = await this.events(0);
    return all.length === 0 ? 0 : all.at(-1).seq;
  }

  // ---- the scripted backend's scripts (the role program's format, SEAM.md §13) ----
  writeScript(name, value) {
    const file = join(this.scripted, 'scripts', `${name}.json`);
    writeFileSync(`${file}.tmp`, json(value));
    renameSync(`${file}.tmp`, file);
  }
  kindScript(kind, value) {
    this.writeScript(`kind-${kind}`, value);
  }
  // Slice E5: the launches of a kind so far (the role program's own log),
  // and the next launches of that kind scripted after them, each earlier
  // ordinal keeping the script it had (`before`).
  launchesOf(kind) {
    const file = join(this.scripted, 'launches.jsonl');
    if (!existsSync(file)) return 0;
    return readFileSync(file, 'utf8').split('\n').filter((l) => {
      try {
        const e = JSON.parse(l);
        return e.event === 'launch' && e.work_kind === kind;
      } catch {
        return false;
      }
    }).length;
  }
  kindNext(kind, scripts, before) {
    this.kindScript(kind, [...Array(this.launchesOf(kind)).fill(before), ...scripts]);
  }
  itemScript(workItem, scripts) {
    this.writeScript(workItem, scripts);
  }
  runScript(run, scripts) {
    this.writeScript(`run-${run}`, scripts);
  }
  release(key = 'all', name = 'gate') {
    writeFileSync(join(this.scripted, 'release', `${key}.${name}`), '');
  }

  // Orchestration reads of the store (never asserted): what the scripted
  // boundaries must move, and whether runs are still under way.
  store(fn) {
    const db = new Database(join(this.home, 'store.db'), { readonly: true, fileMustExist: true });
    try {
      db.pragma('busy_timeout = 5000');
      return fn(db);
    } finally {
      db.close();
    }
  }
  queuedExecutions(project) {
    return this.store((db) => db.prepare(`SELECT x."id" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" = 'queued' ORDER BY x."execution_seq"`).all(project));
  }
  runsUnderWay(project) {
    return this.store((db) => db.prepare(`SELECT "id" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' AND "quarantined" = 0 AND NOT ("kind" = 'session' AND "session_state" IN ('open_idle', 'allocated', 'closed', 'closing'))`).all(project));
  }

  // One tick, requested through the owner's route, and the engine.tick event
  // that follows it, twice (the first seen may be of a tick under way).
  async tick(project) {
    for (let i = 0; i < 2; i++) {
      const before = await this.lastSeq();
      await this.ok(this.post(`/v1/projects/${project}/tick`), 202, 'POST …/tick');
      await waitFor(async () => (await this.events(before)).some((e) => e.type === 'engine.tick'), { what: 'a tick to finish' });
    }
  }
  async idle(project, timeoutMs = 120_000) {
    await waitFor(() => this.runsUnderWay(project).length === 0, { timeoutMs, what: `the runs of ${project} to end` });
  }

  // The kernel lane's scripted check boundary (SEAM.md §190): each queued
  // execution moved to recorded with exit 0.
  async recordChecks(project) {
    for (const { id } of this.queuedExecutions(project)) {
      for (const to of ['materializing', 'running', 'collecting', 'recorded']) {
        const res = await this.post('/v1/harness/fixtures/check-execution', { execution: id, to, ...(to === 'recorded' ? { exit_status: 0 } : {}) });
        if (res.status !== 200) break; // superseded or cancelled meanwhile
      }
    }
  }

  // ---- the owner's reads and answers ----
  async project(id) {
    return (await this.ok(this.get(`/v1/projects/${id}`), 200, `GET /v1/projects/${id}`)).project;
  }
  iterations(id) {
    return this.ok(this.get(`/v1/projects/${id}/iterations`), 200, 'GET …/iterations');
  }
  iteration(p, i) {
    return this.ok(this.get(`/v1/projects/${p}/iterations/${i}`), 200, 'GET …/iterations/:i');
  }
  async openDecisions(p) {
    return (await this.ok(this.get(`/v1/projects/${p}/decisions`), 200, 'GET …/decisions')).decisions;
  }
  async work(p) {
    return (await this.ok(this.get(`/v1/projects/${p}/work`), 200, 'GET …/work')).work_items;
  }
  async decision(p, id) {
    return (await this.ok(this.get(`/v1/projects/${p}/decisions/${id}`), 200, 'GET …/decisions/:d')).decision;
  }
  answer(p, d, option = 'approve') {
    return this.post(`/v1/projects/${p}/decisions/${d.id}/answer`, { option, preview_hash: d.preview_hash });
  }
  async answerOpen(p, kind, option = 'approve') {
    const d = (await this.openDecisions(p)).find((x) => x.kind === kind);
    assert.ok(d, `an open ${kind} is served (open: ${JSON.stringify((await this.openDecisions(p)).map((x) => x.kind))})`);
    await this.ok(this.answer(p, d, option), 200, `answering ${kind} ${option}`);
    return d;
  }
}

// ---- the prototype's products, as the scripted roles write them ---------------------------

const REQS = [
  { key: 'R1', title: 'Add a task', statement: 'A user adds a task with a title.', crit: 'Given the app is running, when a user posts a title, then the task is listed.' },
  { key: 'R2', title: 'List tasks', statement: 'A user lists the tasks.', crit: 'Given two tasks, when a user requests the list, then both are listed in order.' },
  { key: 'R3', title: 'Finish a task', statement: 'A user marks a task done.', crit: 'Given a task, when a user marks it done, then it is listed as done.' },
];

function specText({ version = 1, purpose = 'A small task list, to show the idea.', changeLog = [], reqs = REQS } = {}) {
  return `# Tasks

**Spec version:** ${version}
**Status:** draft
**Tier:** T1
**Owner:** Sean

## 1. Purpose

${purpose}

## 2. Non-goals

- Accounts

## 3. Users and situations

One person on this host.

## 4. Requirements

${reqs.map((r) => `### ${r.key}. ${r.title}\n\n${r.statement}\n\n**Rationale.** The prototype shows it.\n\n**Sensitive areas:** none\n\n**Acceptance criteria**\n\n- ${r.key}.1 ${r.crit}\n`).join('\n')}
## 5. Requirement index

| Key | Title | Phase | Sensitive areas | Criteria |
|---|---|---|---|---|
${reqs.map((r) => `| ${r.key} | ${r.title} | ${r.phase ?? 1} | none | ${r.key}.1 |`).join('\n')}

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
| app | \`server.mjs\`, \`src/\` | none |

**Protected paths**

- \`.surety/checks/\`

## 7. Environments

| Environment | Purpose | Verified means |
|---|---|---|
| alpha | the owner's prototype target | the post-deploy behaviour check passes against it |

- **Target:** \`local_service\`, target \`app\`.
- **Runtime and start command:** \`node server.mjs\`.
- **Port:** \`PORT\`.
- **Excluded from the artifact:** none.
- **Required post-deploy behaviour check:** GET /tasks answers 200.
- **Stable arguments:** the service does not change its process title or arguments.

## 8. Constraints

- Node's own modules only.

## 9. Interfaces and data

HTTP on this host; JSON; no persistent data.

## 10. Open questions

None.

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-10-28 | First approved version | Sean |
${changeLog.map((c) => `| ${c.version} | 2026-10-28 | ${c.change} | Sean |`).join('\n')}
`;
}

const LIMITATIONS = ['tasks are lost when the service restarts', 'one user at a time; no login'];
const modelBrief = (over = {}) => ({
  app: 'Tasks',
  for: 'one person trying the idea',
  experience: 'Open the page, add tasks, finish them.',
  included: ['adding, listing and finishing tasks'],
  objectives: REQS.map((r) => `${r.key}: ${r.statement}`),
  mocked: ['no login'],
  left_out: ['sharing a list'],
  assumptions: ['one user at a time'],
  limitations: LIMITATIONS,
  constraints: ["Node's own modules only"],
  estimates: { runs: [6, 9], tokens: [400_000, 900_000], usd: [0, 0], minutes: 30 },
  ...over,
});

// The scripted provider's usage (scripted-1: input, cache reads and output,
// each counted once).
const usage = (input, cached, out) => ({ usage: { semantics: 'cumulative', raw: { input_tokens: input, cache_read_tokens: cached, output_tokens: out } } });
const write = (path, content) => ({ write: { path, content } });
const result = (extra = {}) => ({ result: { status: 'completed', summary: 'scripted role finished', ...extra } });

const prepScript = ({ brief = modelBrief(), spec = specText(), use = usage(1200, 300, 400) } = {}) => ({ steps: [use, write('.surety/spec/spec.md', spec), result({ summary: 'the brief and its minimal specification', brief })] });

const MODULES = { version: 1, modules: [{ name: 'app', paths: ['server.mjs', 'src/'], sensitive_areas: [], interfaces: [{ name: 'tasks', kind: 'http', path: '/tasks', description: 'the task list' }] }], mapping_from_spec: [{ spec_module: 'app', to: ['app'] }] };
const ROADMAP = { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'the task list, end to end', modules: ['app'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }] };
const STAGES = [
  { number: 1, goal: 'add and list tasks', tasks: ['write server.mjs with POST /tasks and GET /tasks'], modules: ['app'], implements: ['R1', 'R2'], adrs: [], depends_on: [], validation: { criteria: ['R1.1', 'R2.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] },
  { number: 2, goal: 'finish a task', tasks: ['write src/done.mjs and POST /tasks/:id/done'], modules: ['app'], implements: ['R3'], adrs: [], depends_on: [1], validation: { criteria: ['R3.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] },
];
const firstPlanScript = ({ use = usage(2000, 0, 900), stages = STAGES } = {}) => ({
  steps: [
    use,
    write('.surety/architecture/architecture.md', '# Tasks: architecture\n\nOne module, `app`: `server.mjs` with Node\'s own `http`, and helpers under `src/`.\n'),
    write('.surety/architecture/modules.json', json(MODULES)),
    write('.surety/roadmap/roadmap.json', json(ROADMAP)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list, end to end (R1, R2, R3).\n'),
    { write: { path: '.surety/phases/phase-1.json', content: json({ phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: '__HEAD__' }, stages, conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-1.md', '# Phase 1\n\n- Stage 1: add and list tasks\n- Stage 2: finish a task\n'),
    result({ summary: 'the first plan', plan: 'phase-1', conformance: 'within_baseline' }),
  ],
});

const def = (key, fields) => json({ schema: 1, key, ...fields });
const GATES = ['stage', 'alpha_authorize'];
const CHECK_FILES = {
  '.surety/checks/protected-policy.json': json({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: '/usr/bin/true' } } }),
  '.surety/checks/defs/accept-r1.json': def('accept-r1', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
  '.surety/checks/defs/accept-r2.json': def('accept-r2', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R2.1'] } }),
  '.surety/checks/defs/accept-r3.json': def('accept-r3', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
  '.surety/checks/defs/smoke.json': def('smoke', { kind: 'smoke', command: ['probe'], timeout_s: 60, gate_kinds: GATES }),
  '.surety/checks/defs/operation.json': def('operation', { kind: 'post_deploy_behavior', command: ['probe'], timeout_s: 60, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
};
const authoringScript = ({ use = usage(900, 100, 300), files = CHECK_FILES } = {}) => ({
  steps: [use, ...Object.entries(files).map(([p, c]) => write(p, c)), result({ proposal: { rationale: "The Verifier authors the prototype's checks before any stage builds.", requested_change_kind: 'unclassifiable' } })],
});
const SERVER = "import { createServer } from 'node:http';\nconst tasks = [];\ncreateServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(tasks)); }).listen(Number(process.env.PORT), '127.0.0.1');\n";
const builderScript = (stage, { use = usage(1500, 500, 700), steps = [] } = {}) => ({
  steps: [use, ...steps, stage === 1 ? write('server.mjs', SERVER) : write('src/done.mjs', 'export const done = (t) => ({ ...t, done: true });\n'), result()],
});

// Slice E5: a Builder writing one file of its own; iteration 2's
// requirement, its plan (phase 2 only, one stage) and its check.
const builderOwn = (path, content, { use = usage(1500, 500, 700) } = {}) => ({ steps: [use, write(path, content), result()] });
const REQ4 = { key: 'R4', title: 'Count open tasks', statement: 'A user sees how many tasks are open.', crit: 'Given two open tasks and one done, when a user lists the tasks, then 2 open tasks are counted.', phase: 2 };
const ROADMAP2 = { version: 2, architecture_version: 1, phases: [...ROADMAP.phases, { number: 2, goal: 'the open count', modules: ['app'], requirement_ids: ['R4'], depends_on: [1] }] };
const STAGES2 = [{ number: 1, goal: 'count the open tasks', tasks: ['write src/count.mjs'], modules: ['app'], implements: ['R4'], adrs: [], depends_on: [], validation: { criteria: ['R4.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] }];
const secondPlanScript = ({ use = usage(1800, 0, 700) } = {}) => ({
  steps: [
    use,
    write('.surety/roadmap/roadmap.json', json(ROADMAP2)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list, end to end (R1, R2, R3).\n2. The open count (R4).\n'),
    { write: { path: '.surety/phases/phase-2.json', content: json({ phase: 2, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: STAGES2, conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-2.md', '# Phase 2\n\n- Stage 1: count the open tasks\n'),
    result({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});
const CHECK_FILE_R4 = { '.surety/checks/defs/accept-r4.json': def('accept-r4', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R4.1'] } }) };

// The scripts every prototype of this file follows by default (a launch of
// a kind with its own work-item or run script follows that one instead).
function defaultScripts(fx) {
  fx.kindScript('brief_preparation', prepScript());
  fx.kindScript('replan', firstPlanScript());
  fx.kindScript('check_authoring', authoringScript());
  fx.kindScript('verification', { steps: [usage(300, 0, 100), result()] });
  fx.kindScript('phase_verification', { steps: [usage(300, 0, 100), result({ signoffs: [{ scope: 'phase' }] })] });
  fx.kindScript('fix', { steps: [usage(300, 0, 100), result()] });
  fx.writeScript('default', { steps: [usage(100, 0, 50), result()] });
}

// The local_service configuration of environment alpha (D4 A.2), as the
// owner writes it; the scripted deployment adapter stands in for the unit.
const configContent = (port = 18080) => ({
  adapter: 'local_service',
  adapter_version: '1',
  targets: ['app'],
  runtime: { path: process.execPath, sha256: execFileSync('sha256sum', [process.execPath], { encoding: 'utf8' }).split(' ')[0] },
  start: [process.execPath, 'server.mjs'],
  port,
  env: {},
  secrets: {},
  check_secrets: [],
  egress: [],
  artifact: { exclude: [] },
  identity_method: 'tree_digest',
});

// The owner configures alpha; the test seam scripts the adapter's deploy
// answers (SEAM.md §247) and records the adapter's qualification fixture
// (§248), as M301 and M401 do.
async function alphaReady(fx, project, { answers = [{ result: 'issued', apply: true }], port = 18080 } = {}) {
  const res = await fx.put(`/v1/projects/${project}/environments/alpha/config`, configContent(port));
  assert.ok([200, 201].includes(res.status), `PUT …/environments/alpha/config (→ ${res.status} ${res.text})`);
  const env = res.body.environment;
  await fx.ok(fx.post(`/v1/harness/deploy/environments/${env.id}/answers`, { call: 'deploy', answers }), 200, 'the scripted adapter takes its deploy answers');
  await fx.ok(fx.post('/v1/harness/fixtures/adapter-qualification', { adapter: 'local_service', adapter_version: '1' }), 201, 'the adapter qualification fixture');
  return env;
}

const CHECK_KINDS = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'];

const IMPORTED_IDEA = `# Idea: Tasks

## What

A small task list for one person: add a task, list the tasks, mark one done.

## Why

To try the idea before building it properly.

## Out of scope

- accounts
- sharing
`;

async function newPrototype(fx, { name, idea = 'A small task list app: add, list and finish tasks.', mode = 'rapid_prototype', tier } = {}) {
  const body = { name, idea, dev_repo_path: join(fx.apps, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), ...(mode ? { mode } : {}), ...(tier ? { tier } : {}) };
  const made = await fx.ok(fx.post('/v1/projects/new', body), 201, `POST /v1/projects/new (${mode})`);
  const id = made.project?.id ?? made.id;
  assert.match(id ?? '', /^proj_/, `the new app is named (${JSON.stringify(made)})`);
  await waitFor(async () => (await fx.project(id)).registration_state === 'registered', { what: `project ${id} registered` });
  // A planned app is created paused (the onboarding design): the owner
  // starts it (POST …/resume). A rapid prototype is created unpaused (slice
  // E5, the owner's ruling S1): creating it launches no work, and its
  // preparation's work item exists only once the owner approves that run.
  if (mode === 'rapid_prototype') {
    assert.equal((await fx.project(id)).paused, false, 'a new prototype is created unpaused (S1)');
    assert.deepEqual(await fx.work(id), [], 'no work item at creation');
    assert.deepEqual((await fx.openDecisions(id)).map((d) => d.kind), ['prototype_preparation_approval'], 'only the preparation is asked');
  } else {
    assert.equal((await fx.project(id)).paused, true, 'a new planned app is created paused');
    await fx.ok(fx.post(`/v1/projects/${id}/resume`), 200, 'POST …/resume');
  }
  return id;
}

// Tick until `done` answers, recording queued check executions (exit 0) and
// answering, as the owner, only the kinds given; never any other.
async function pump(fx, project, done, { answer = [], max = 60, what = 'the journey to advance', acts = [], wait = true } = {}) {
  for (let i = 0; ; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    if (i >= max) {
      const open = (await fx.openDecisions(project)).map((d) => d.kind);
      const work = (await fx.work(project)).filter((w) => !['complete', 'cancelled'].includes(w.status)).map((w) => `${w.kind}:${w.status}:${JSON.stringify(w.blocker ?? null).slice(0, 200)}`);
      const pr = await fx.get(`/v1/projects/${project}`);
      throw new Error(`${what}: not reached in ${max} ticks (now: ${JSON.stringify(pr.body?.project?.now ?? pr.body?.now ?? null)}; held: ${JSON.stringify(pr.body?.project?.held_work ?? null)}; work items: ${JSON.stringify(await fx.work(project)).slice(0, 3000)}; engine stderr: ${fx.stderr.slice(-1500)}; open decisions: ${JSON.stringify(open)}; work: ${JSON.stringify(work)}; acts: ${JSON.stringify(acts)})`);
    }
    if (wait) await fx.idle(project);
    await fx.recordChecks(project);
    for (const d of await fx.openDecisions(project)) {
      if (!answer.includes(d.kind)) continue;
      const res = await fx.answer(project, d, 'approve');
      acts.push({ kind: d.kind, id: d.id, status: res.status });
    }
    await fx.tick(project);
    if (wait) await fx.idle(project);
    else await sleep(300);
  }
}

// A policy submission as the owner makes it: a widening confirmed through
// its decision. Returns what the submission said of the prototype's current
// iteration (slice E5: whether a raise reopens it, and why not).
async function answerPolicy(fx, p, res, what) {
  if (res.status === 409) {
    const d = await fx.decision(p, res.body.subject.decision);
    await fx.ok(fx.answer(p, d), 200, `the owner approves ${what}`);
    return res.body.subject.prototype;
  }
  assert.ok([200, 201, 202].includes(res.status), `${what} (→ ${res.status} ${res.text})`);
  return res.body.prototype;
}

const current = async (fx, p) => (await fx.iterations(p)).iterations.at(-1);

describe('Rapid prototype to Alpha, demonstrated over HTTP on a disposable engine with the scripted backend', () => {
  let fx;
  const S = {};
  before(async () => {
    fx = new Fixture();
    defaultScripts(fx);
    await fx.start();
  });
  after(async () => fx?.cleanup());

  test('(1) a typed idea and a Markdown-imported idea each reach a readable brief after the preparation approval; nothing is built or deployed before the brief is approved', async () => {
    S.typed = await newPrototype(fx, { name: 'Tasks typed' });
    S.imported = await newPrototype(fx, { name: 'Tasks imported', idea: IMPORTED_IDEA });
    for (const p of [S.typed, S.imported]) {
      const read = await fx.project(p);
      assert.deepEqual([read.mode, read.prototype?.status], ['rapid_prototype', 'preparing'], 'a rapid prototype, its first iteration preparing');
      const it = await current(fx, p);
      assert.equal(it.seq, 1);
      // Nothing is dispatched before the preparation is authorized.
      await fx.tick(p);
      assert.deepEqual((await fx.work(p)).map((w) => w.kind), [], 'no work before the preparation is authorized');
      const d = await fx.answerOpen(p, 'prototype_preparation_approval');
      assert.match(d.question, /exactly one preparation run/, 'the authorization states it covers exactly one run');
      assert.match(d.question, /scripted provider is unpaid/, 'the scripted provider is said to be unpaid');
      await pump(fx, p, async () => (await current(fx, p)).status === 'awaiting_brief_approval', { what: 'the brief' });
      const read2 = await fx.iteration(p, it.id);
      assert.equal(read2.iteration.status, 'awaiting_brief_approval');
      assert.match(read2.iteration.brief.record ?? '', /^rec_/, 'the brief is recorded');
      assert.equal(read2.iteration.brief.version, 1, 'the brief is version 1 of the specification');
      const open = await fx.openDecisions(p);
      const spec = open.find((x) => x.kind === 'spec_approval');
      assert.ok(spec, 'the brief is put to the owner as the ordinary spec_approval');
      assert.equal(spec.dependency_manifest?.brief_record ?? spec.manifest?.brief_record ?? read2.iteration.brief.record, read2.iteration.brief.record);
      // Readable: the brief, whole, in its shape, from the record the read names.
      assert.deepEqual(read2.brief?.limitations, LIMITATIONS, 'the brief is served whole with the iteration (its limitations as prepared)');
      // No build and no deployment before the brief's approval.
      const kinds = (await fx.work(p)).map((w) => w.kind);
      assert.deepEqual([...new Set(kinds)], ['brief_preparation'], `only the preparation was dispatched (${kinds})`);
      assert.deepEqual(read2.usage.runs.map((r) => r.work_kind), ['brief_preparation'], 'one run, the preparation');
      assert.equal(read2.alpha.deployment_request, null, 'no deployment request');
      assert.equal(read2.plan, null, 'no plan');
      assert.equal((await fx.project(p)).environments?.length ?? 0, 0, 'no environment, nothing deployed');
    }
  });

  test('(2) a second preparation (a changed brief) invalidates the first brief\'s spec_approval, and answering that one is refused', async () => {
    const p = S.imported;
    const it = await current(fx, p);
    const first = (await fx.openDecisions(p)).find((d) => d.kind === 'spec_approval');
    const firstRecord = (await fx.iteration(p, it.id)).iteration.brief.record;
    const asked = await fx.ok(fx.post(`/v1/projects/${p}/iterations/${it.id}/prepare`), 201, 'POST …/prepare asks for another preparation');
    assert.equal(asked.decision.kind, 'prototype_preparation_approval');
    // Slice E5b (row M602 (d)): asked again while that one is open, 409, naming it.
    const twice = await fx.post(`/v1/projects/${p}/iterations/${it.id}/prepare`);
    assert.equal(twice.status, 409, `…/prepare while a preparation approval is open (→ ${twice.status} ${twice.text})`);
    assert.deepEqual([twice.body.code, twice.body.reason, twice.body.subject.decision], ['illegal_transition', `Iteration ${it.seq}'s brief preparation is already awaiting your authorization (decision ${asked.decision.id}).`, asked.decision.id]);
    await fx.answerOpen(p, 'prototype_preparation_approval');
    const item = (await fx.work(p)).filter((w) => w.kind === 'brief_preparation').at(-1);
    assert.equal(item.status, 'eligible', 'one more preparation registered');
    // The changed brief: the same specification, another app sentence and one more limitation.
    fx.itemScript(item.id, [prepScript({ brief: modelBrief({ app: 'Tasks, changed', limitations: [...LIMITATIONS, 'no undo'] }) })]);
    await pump(fx, p, async () => {
      const r = await fx.iteration(p, it.id);
      return r.iteration.brief.record !== firstRecord && r.iteration.status === 'awaiting_brief_approval' ? r : undefined;
    }, { what: 'the changed brief' });
    const read = await fx.iteration(p, it.id);
    assert.equal(read.brief.app, 'Tasks, changed', 'the iteration serves the changed brief');
    const stale = await fx.decision(p, first.id);
    assert.equal(stale.status, 'invalidated', 'the first brief\'s spec_approval is invalidated');
    assert.match(stale.invalidated_reason ?? '', /a later brief/, 'it names the later brief');
    const refused = await fx.answer(p, first, 'approve');
    assert.equal(refused.status, 409, `answering the stale approval is refused (→ ${refused.status} ${refused.text})`);
    const open = (await fx.openDecisions(p)).filter((d) => d.kind === 'spec_approval');
    assert.equal(open.length, 1, 'one spec_approval is open: the changed brief\'s');
    assert.notEqual(open[0].id, first.id);
    assert.equal((await fx.decision(p, open[0].id)).dependency_manifest.brief_record, read.iteration.brief.record, 'it binds the changed brief\'s record');
    assert.equal(read.approved_at ?? read.iteration.approved_at, null, 'nothing was approved');
  });

  test('(3) one approved brief reaches alpha_ready through the reduced path with exactly three owner answers: preparation, brief, check correction; (5) three Builder runs are three runs of one role', async () => {
    const p = S.typed;
    const it = await current(fx, p);
    // Stage 1's first Builder run fails (exit without a result) and is
    // retried: three Builder runs in all.
    fx.kindScript('stage_build', [{ steps: [usage(800, 0, 200), { exit: 3 }] }, builderScript(1), builderScript(2)]);
    const acts = [];
    await fx.answerOpen(p, 'spec_approval');
    acts.push('spec_approval');
    const env = await alphaReady(fx, p);
    await pump(fx, p, async () => ((await fx.iteration(p, it.id)).iteration.status === 'alpha_ready' ? true : undefined), { answer: CHECK_KINDS, acts, max: 80, what: 'alpha_ready' });
    const read = await fx.iteration(p, it.id);
    S.typedRead = read;
    S.env = env;
    // Exactly three owner answers, counted from the decisions the read serves.
    assert.deepEqual(read.owner_approvals.by_kind, { prototype_preparation_approval: 1, spec_approval: 1, check_correction_unclassifiable: 1 }, `the owner approved preparation, brief and check correction (${JSON.stringify(read.owner_approvals)})`);
    assert.equal(read.owner_approvals.count, 3);
    for (const d of read.owner_approvals.decisions) assert.equal((await fx.decision(p, d.id)).status, 'consumed');
    assert.deepEqual(acts.map((a) => a.kind ?? a), ['spec_approval', 'check_correction_unclassifiable'], 'the pump answered only the check correction');
    // The first plan was published by the prototype policy, never as a human approval.
    assert.equal(read.plan.routing, 'policy_authorized');
    assert.equal(read.plan.approved_by, 'policy:rapid_prototype');
    assert.deepEqual(Object.keys(read.plan.approvals), ['policy_authorized']);
    // Artifacts and evidence recorded on the iteration.
    const named = (v) => typeof v === 'string' && v.length > 0;
    assert.ok(named(read.iteration.brief.spec_revision), 'the approved spec revision');
    assert.match(read.iteration.brief.record ?? '', /^rec_/, 'the brief record');
    assert.ok(named(read.plan.bundle) && named(read.plan.phase_plan), 'the plan bundle and the phase plan it published');
    assert.equal(read.plan.bundle_status, 'published');
    assert.match(read.alpha.candidate ?? '', /^cand_/, 'the candidate');
    assert.ok(named(read.alpha.deployment_request), 'the deployment request');
    assert.deepEqual(read.alpha.environment, { id: env.id, name: 'alpha' });
    assert.ok(read.alpha.deployed_at, 'Alpha reached, with its time');
    assert.equal(read.outcome.next_step, 'open_alpha');
    // (5): three Builder runs, three distinct runs of one role.
    const builders = read.usage.runs.filter((r) => r.role === 'builder');
    assert.equal(builders.length, 3, `three Builder runs (${JSON.stringify(read.usage.runs.map((r) => [r.role, r.work_kind, r.outcome]))})`);
    assert.equal(new Set(builders.map((r) => r.id)).size, 3);
    assert.equal(read.usage.totals.roles_used.filter((r) => r === 'builder').length, 1, 'the Builder is one role');
    assert.equal(read.usage.totals.agent_runs, read.usage.runs.length, 'agent_runs counts runs, not roles');
    assert.deepEqual(read.usage.totals.roles_used, [...new Set(read.usage.runs.map((r) => r.role))]);
    for (const r of builders) assert.equal(r.invocations.length, 1, 'each one-shot Builder run is one invocation');
  });

  test('(5) a run with two invocations (a session of two turns) shows 2, each distinguishable', async () => {
    const p = S.imported;
    const it = await current(fx, p);
    const opened = await fx.ok(fx.post(`/v1/projects/${p}/sessions`, { role: 'spec_writer' }), 201, 'POST …/sessions opens a Spec Writer session');
    const run = opened.run.id;
    const turn = (reply) => ({ steps: [usage(400, 100, 80), result({ summary: reply, reply, artifact_changed: false })] });
    fx.runScript(run, [turn('First answer.'), turn('Second answer.')]);
    for (const text of ['What does the prototype leave out?', 'And what is mocked?']) {
      const posted = await fx.ok(fx.post(`/v1/projects/${p}/sessions/${run}/turns`, { text }), 202, 'POST …/turns');
      await waitFor(async () => {
        await fx.tick(p);
        const r = await fx.ok(fx.get(`/v1/projects/${p}/sessions/${run}`), 200, 'GET …/sessions/:r');
        const t = (r.turns ?? []).find((x) => x.turn === posted.turn);
        return t && ['settled', 'failed', 'unknown'].includes(t.state) ? t : undefined;
      }, { what: `turn ${posted.turn} to settle` });
    }
    const read = await fx.iteration(p, it.id);
    const session = read.usage.runs.find((r) => r.id === run);
    assert.ok(session, 'the session run is attributed to the open iteration');
    assert.equal(session.invocations.length, 2, 'one run, two invocations');
    assert.equal(new Set(session.invocations.map((i) => i.id)).size, 2, 'each invocation distinguishable');
    assert.equal(new Set(session.invocations.map((i) => i.turn)).size, 2, 'each its own turn');
    // Slice E5 (S5): each turn given the session's effective allowance, the
    // per-run limit capped at what the iteration had left; the session's
    // bound, its earlier turn's charge included, is the same for both.
    assert.ok(session.invocations.every((i) => i.limited_by === 'iteration' && i.run_limit_tokens === 5_000_000 && i.effective_limit_tokens > 0 && i.effective_limit_tokens <= 1_500_000), JSON.stringify(session.invocations));
    assert.equal(session.invocations[0].effective_limit_tokens, session.invocations[1].effective_limit_tokens);
    assert.ok(session.invocations.every((i) => i.usage.state === 'complete' && i.usage.billable_in === 400 && i.usage.cached_in === 100 && i.usage.out === 80), JSON.stringify(session.invocations.map((i) => i.usage)));
    await fx.ok(fx.post(`/v1/projects/${p}/sessions/${run}/close`, { refuse: true }), 200, 'the session closed');
  });

  test('(9) the receipt keeps the brief\'s limitations and claims no human acceptance', async () => {
    const p = S.typed;
    const it = S.typedRead.iteration;
    const res = await fx.get(`/v1/projects/${p}/iterations/${it.id}/receipt.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'] ?? '', /^attachment; filename="surety-receipt-/);
    const receipt = res.body;
    assert.equal(receipt.receipt_version, 1);
    assert.equal(receipt.outcome.status, 'alpha_ready');
    assert.deepEqual(receipt.brief.limitations, LIMITATIONS, 'the brief, whole, with its limitations');
    assert.deepEqual(receipt.limitations.brief, LIMITATIONS, 'the limitations kept beside the outcome');
    assert.deepEqual(receipt.limitations.left_out, ['sharing a list']);
    assert.equal(receipt.limitations.human_acceptance, 'not_recorded');
    assert.match(receipt.limitations.statement, /records no human acceptance/);
    // No field anywhere claims a person's (or a visual) acceptance.
    const leaves = [];
    const walk = (v, path) => {
      if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      else leaves.push([path, v]);
    };
    walk(receipt, []);
    const claims = leaves.filter(([path, v]) => path.some((k) => /visual|accepted_by|human_accept|signed_off/i.test(k)) && !(path.at(-1) === 'human_acceptance' && v === 'not_recorded'));
    assert.deepEqual(claims, [], 'no field claims visual or human acceptance');
    assert.ok(!leaves.some(([path, v]) => /accept/i.test(path.at(-1)) && v === true), 'no acceptance flag is true');
  });

  test('(8) Iterate: iteration 2 continues from 1 with the change; the predecessor is untouched and its Alpha stays deployed; its deployment never satisfies iteration 2\'s Alpha', async () => {
    const p = S.typed;
    const one = S.typedRead.iteration;
    // The environment observed (the observer runs off the tick once due:
    // the engine's clock advanced past its cadence through the test seam,
    // SEAM.md §291): Alpha is available now.
    await fx.ok(fx.post('/v1/harness/clock/advance', { seconds: 31 }), 200, 'the clock advanced');
    await pump(fx, p, async () => (await fx.iteration(p, one.id)).alpha.current, { what: 'an observation of alpha' });
    S.typedRead = await fx.iteration(p, one.id);
    assert.ok(S.typedRead.alpha.current?.healthy, `iteration 1's Alpha is current and healthy after the deployment (${JSON.stringify(S.typedRead.alpha)})`);
    // Refusals first: not the current iteration's status, not a known field, not empty.
    assert.equal((await fx.post(`/v1/projects/${p}/iterations/${one.id}/iterate`, { change: '' })).status, 400, 'an empty change is refused');
    assert.equal((await fx.post(`/v1/projects/${p}/iterations/${one.id}/iterate`, { note: 'x' })).status, 400, 'an unknown field is refused');
    const imported = await current(fx, S.imported);
    const notEnded = await fx.post(`/v1/projects/${S.imported}/iterations/${imported.id}/iterate`, {});
    assert.equal(notEnded.status, 409, `an iteration that has not ended is not iterated (→ ${notEnded.status} ${notEnded.text})`);
    const since = await fx.lastSeq();
    const change = 'Show the number of open tasks at the top.';
    const made = await fx.ok(fx.post(`/v1/projects/${p}/iterations/${one.id}/iterate`, { change }), 201, 'POST …/iterate');
    assert.deepEqual([made.iteration.seq, made.iteration.status, made.iteration.predecessor, made.iteration.change], [2, 'preparing', one.id, change]);
    assert.deepEqual(made.iteration.limits, S.typedRead.iteration.limits, 'the limits snapshotted from the policy in force');
    assert.deepEqual([made.predecessor.seq, made.predecessor.status], [1, 'alpha_ready']);
    assert.deepEqual(made.cancelled_work, [], 'iteration 1 left no work unfinished');
    const again = await fx.post(`/v1/projects/${p}/iterations/${one.id}/iterate`, { change });
    assert.equal(again.status, 409, 'iteration 1 is no longer the current one');
    const two = made.iteration.id;
    S.two = two;
    // The preparation's question names the iteration it continues and the change.
    const q = (await fx.openDecisions(p)).find((d) => d.kind === 'prototype_preparation_approval');
    assert.ok(q && q.subject_id === two, 'iteration 2\'s preparation is asked for');
    assert.match(q.question, /This is iteration 2 of the app, continuing from iteration 1/);
    assert.ok(q.question.includes(change), 'with the change text');
    assert.match(q.question, /the brief approved in iteration 1/);
    const manifest = (await fx.decision(p, q.id)).dependency_manifest;
    assert.deepEqual([manifest.continues?.iteration, manifest.change], [one.id, change]);
    // The list serves both, the predecessor named.
    const list = (await fx.iterations(p)).iterations;
    assert.deepEqual(list.map((i) => [i.seq, i.status, i.predecessor, i.change]), [[1, 'alpha_ready', null, null], [2, 'preparing', one.id, change]]);
    // The predecessor untouched: its receipt's runs, usage, approvals, outcome and Alpha as they were.
    const before = S.typedRead;
    const after1 = await fx.iteration(p, one.id);
    for (const k of ['usage', 'owner_approvals', 'plan', 'brief', 'limitations', 'outcome']) assert.deepEqual(after1[k], before[k], `iteration 1's ${k} unchanged`);
    assert.deepEqual([after1.iteration.status, after1.iteration.alpha_at, after1.alpha.candidate, after1.alpha.deployment_request], [before.iteration.status, before.iteration.alpha_at, before.alpha.candidate, before.alpha.deployment_request]);
    assert.ok(after1.alpha.current, 'iteration 1\'s Alpha stays deployed (current) until iteration 2\'s own deployment replaces it');
    // Iteration 2: its own totals, nothing of the predecessor's; the app's totals sum both once.
    const read2 = await fx.iteration(p, two);
    assert.deepEqual([read2.usage.totals.agent_runs, read2.usage.totals.invocations, read2.usage.totals.unknown_allowance_tokens], [0, 0, null], 'iteration 2 counts none of iteration 1\'s runs');
    assert.equal(read2.app_totals.iterations, 2);
    assert.equal(read2.app_totals.agent_runs, after1.usage.totals.agent_runs, 'the app\'s runs: iteration 1\'s and none twice');
    assert.deepEqual(read2.app_totals.tokens.billable_in, after1.usage.totals.tokens.billable_in);
    assert.deepEqual(after1.app_totals, read2.app_totals, 'the app\'s totals are the same from either iteration');
    assert.match(read2.app_totals.cumulative_rule, /each counted once/);
    assert.deepEqual([read2.alpha.candidate, read2.alpha.deployment_request, read2.alpha.current], [null, null, null], 'iteration 2 has no Alpha');
    assert.equal((await fx.project(p)).prototype.iteration, two);
    const iterated = (await fx.events(since)).filter((e) => e.type === 'prototype.iteration_iterated');
    assert.equal(iterated.length, 1);
    assert.deepEqual([iterated[0].payload.predecessor, iterated[0].payload.change], [one.id, change]);

    // The predecessor's deployment again: torn down by the owner, then its
    // candidate deployed again while iteration 2 is open. It completes, and
    // is refused as iteration 2's Alpha.
    await fx.ok(fx.post(`/v1/harness/deploy/environments/${S.env.id}/answers`, { call: 'teardown', answers: [{ result: 'issued', apply: true }] }), 200, 'teardown answers');
    const td = await fx.post(`/v1/projects/${p}/environments/alpha/teardown`, {});
    assert.ok(td.status >= 200 && td.status < 300, `the owner's teardown (→ ${td.status} ${td.text})`);
    await pump(fx, p, async () => ((await fx.iteration(p, one.id)).alpha.current === null ? true : undefined), { what: 'the teardown' });
    const withdrawn = await fx.ok(fx.get(`/v1/projects/${p}/candidates/${one.id && before.alpha.candidate}`), 200, 'GET …/candidates/:c');
    assert.equal(withdrawn.candidate?.progress ?? withdrawn.progress, 'developing', 'the torn-down Alpha\'s candidate is set back');
    await fx.ok(fx.post(`/v1/harness/deploy/environments/${S.env.id}/answers`, { call: 'deploy', answers: [{ result: 'issued', apply: true }] }), 200, 'deploy answers');
    const since2 = await fx.lastSeq();
    const req = await fx.post(`/v1/projects/${p}/deployments`, { candidate: before.alpha.candidate, environment: 'alpha' });
    assert.ok([200, 201, 202].includes(req.status), `the predecessor's candidate requested again (→ ${req.status} ${req.text})`);
    const refused = await pump(fx, p, async () => (await fx.events(since2)).find((e) => e.type === 'prototype.alpha_not_attributed'), { what: 'the stale deployment to complete' });
    assert.equal(refused.subject.iteration, two);
    assert.equal(refused.payload.candidate, before.alpha.candidate);
    assert.match(refused.payload.reason, /iteration 1's Alpha, not iteration 2's/);
    const read2b = await fx.iteration(p, two);
    assert.deepEqual([read2b.iteration.status, read2b.alpha.candidate, read2b.alpha.deployment_request, read2b.alpha.current, read2b.iteration.alpha_at], ['preparing', null, null, null, null], 'iteration 2 is not Alpha-ready on its predecessor\'s deployment');
    const read1b = await fx.iteration(p, one.id);
    assert.deepEqual([read1b.iteration.status, read1b.iteration.alpha_at, read1b.alpha.deployment_request], [before.iteration.status, before.iteration.alpha_at, before.alpha.deployment_request], 'iteration 1\'s history unchanged');
  });

  // Every invocation once, each figure the sum of the invocations' own:
  // nothing counted twice, and no unknown shown as 0.
  function assertAccounted(read, what) {
    const invs = read.usage.runs.flatMap((r) => r.invocations);
    assert.equal(new Set(invs.map((i) => i.id)).size, invs.length, `${what}: every invocation once`);
    assert.equal(read.usage.totals.invocations, invs.length);
    assert.equal(read.usage.totals.agent_runs, read.usage.runs.length);
    const sum = (k) => invs.reduce((a, i) => (i.usage[k] === null ? a : (a ?? 0) + i.usage[k]), null);
    for (const k of ['billable_in', 'cached_in', 'out']) assert.equal(read.usage.totals.tokens[k], sum(k), `${what}: ${k} is the sum of the invocations' own`);
    const allowance = invs.reduce((a, i) => (i.unknown_allowance_tokens === null ? a : (a ?? 0) + i.unknown_allowance_tokens), null);
    assert.equal(read.usage.totals.unknown_allowance_tokens, allowance, `${what}: the unknown allowances apart, summed once`);
    for (const i of invs.filter((x) => x.usage.state === 'incomplete')) {
      // An incomplete invocation's unknown is an allowance; with none
      // charged and its billable tokens unknown, what the iteration
      // committed is unknown, never 0.
      if (!(i.unknown_allowance_tokens > 0)) assert.ok(i.usage.billable_in !== null || read.remaining.committed.total_tokens === null, `${what}: an unknown is never counted as 0 (${JSON.stringify(i)})`);
    }
    if (invs.some((i) => i.usage.state !== 'complete')) assert.equal(read.usage.totals.tokens.total_is, 'lower_bound', `${what}: a lower bound while any usage is not complete`);
    const c = read.remaining.committed;
    if (c.total_tokens !== null) assert.equal(c.total_tokens, c.settled_tokens + c.unknown_allowance_tokens + c.under_way_observed_tokens + c.under_way_reserved_tokens, `${what}: committed is settled + allowances + under way`);
  }

  test('(6) cached usage, a pending run, a retry, a cancellation, an engine restart and missing usage: correct totals, nothing counted twice, unknown never 0; (7) a limit and Stop prevent further dispatch, and unknown usage consumes the allowance', async () => {
    const p = await newPrototype(fx, { name: 'Tasks metered' });
    S.metered = p;
    const it = await current(fx, p);
    // The scripts of this project's launches, by each kind's launch ordinal
    // in this engine (the typed app's were the first): the first plan's
    // first run fails and is retried; stage 1's first Builder run reports
    // usage and holds until it is stopped; its next one reports no usage.
    fx.kindScript('replan', [firstPlanScript(), { steps: [usage(500, 0, 100), { exit: 3 }] }, firstPlanScript()]);
    fx.kindScript('stage_build', [
      { steps: [usage(800, 0, 200), { exit: 3 }] },
      builderScript(1),
      builderScript(2),
      { steps: [usage(1000, 200, 300), { hold: 'gate', heartbeat_ms: 250 }], on_term: 'exit' },
      { steps: [write('server.mjs', SERVER), result()] },
    ]);
    await fx.answerOpen(p, 'prototype_preparation_approval');
    await pump(fx, p, async () => (await current(fx, p)).status === 'awaiting_brief_approval', { what: 'the brief' });
    await fx.answerOpen(p, 'spec_approval');

    // Pending: stage 1's Builder under way, its usage observed so far.
    const pending = await pump(
      fx,
      p,
      async () => {
        const r = await fx.iteration(p, it.id);
        const run = r.usage.runs.find((x) => x.work_kind === 'stage_build' && x.finished_at === null);
        return run && run.invocations[0]?.usage.billable_in === 1000 ? { r, run } : undefined;
      },
      { answer: CHECK_KINDS, wait: false, what: 'stage 1 under way' },
    );
    const inv = pending.run.invocations[0];
    assert.equal(inv.usage.state, 'pending', 'its usage is pending while it runs');
    assert.deepEqual([inv.usage.billable_in, inv.usage.cached_in, inv.usage.out], [1000, 200, 300], 'what it observed so far');
    assert.equal(inv.cost.status, 'unknown', 'its cost is not known while it runs');
    assert.ok(inv.reserved_tokens > 0, 'it still reserves part of its run limit');
    assert.equal(pending.r.remaining.committed.under_way_reserved_tokens, inv.reserved_tokens, 'the reservation is counted in what the iteration committed');
    assert.equal(pending.r.usage.totals.tokens.total_is, 'lower_bound');
    assert.equal(pending.r.usage.totals.completeness.pending, 1);
    assertAccounted(pending.r, 'while pending');

    // Cancellation: the owner stops the run (its confirmation, then the stop).
    const path = `/v1/projects/${p}/runs/${pending.run.id}/stop`;
    const ask = await fx.post(path, {});
    assert.equal(ask.status, 409, `the stop asks for its confirmation (→ ${ask.status} ${ask.text})`);
    await fx.ok(fx.post(path, { preview_hash: ask.body.subject.preview_hash }), 200, 'the stop confirmed');
    await fx.idle(p);
    const stopped = await fx.iteration(p, it.id);
    const sr = stopped.usage.runs.find((x) => x.id === pending.run.id);
    assert.ok(sr.finished_at, 'the stopped run ended');
    assert.notEqual(sr.outcome, 'completed');
    const si = sr.invocations[0];
    assert.equal(si.usage.state, 'incomplete', 'a stopped run\'s usage is incomplete');
    assert.deepEqual([si.usage.billable_in, si.usage.cached_in, si.usage.out], [1000, 200, 300], 'what it observed is kept');
    assert.ok(si.unknown_allowance_tokens > 0, `the rest of its run limit is charged as an unknown allowance, never 0 (${si.unknown_allowance_tokens})`);
    // The retry: the first plan's work had two runs, each counted once.
    const plans = stopped.usage.runs.filter((x) => x.work_kind === 'replan');
    assert.equal(plans.length, 2, `the first plan's failed run and its retry (${JSON.stringify(plans.map((x) => [x.outcome, x.reason_class]))})`);
    assert.equal(new Set(plans.map((x) => x.work_item)).size, 1, 'one work item, two runs');
    assert.deepEqual(plans.map((x) => x.invocations[0].usage.billable_in), [500, 2000], 'the failed run\'s usage and the retry\'s, each once');
    // Cached: the preparation's cache reads reported as cached_in, apart from billable_in.
    const prep = stopped.usage.runs.find((x) => x.work_kind === 'brief_preparation').invocations[0];
    assert.deepEqual([prep.usage.state, prep.usage.billable_in, prep.usage.cached_in, prep.usage.out], ['complete', 1200, 300, 400]);
    assert.equal(stopped.usage.totals.preparation.tokens, 1900, 'the preparation subtotal: 1200 + 300 + 400');
    assertAccounted(stopped, 'after the stop');
    assert.equal(stopped.remaining.committed.unknown_allowance_tokens, si.unknown_allowance_tokens, 'the allowance is part of what the iteration committed');
    assert.deepEqual(stopped.app_totals.tokens, stopped.usage.totals.tokens, 'one iteration: the app\'s totals are the iteration\'s');

    // An engine restart mid-iteration: the same totals, nothing counted twice.
    await fx.stop();
    await fx.start();
    const restarted = await fx.iteration(p, it.id);
    assert.deepEqual(restarted.usage.totals, stopped.usage.totals, 'the totals after the restart are those before it');
    assert.deepEqual(restarted.remaining.committed, stopped.remaining.committed);
    assert.deepEqual(restarted.usage.runs.map((r) => r.invocations.map((i) => i.id)), stopped.usage.runs.map((r) => r.invocations.map((i) => i.id)));
    assertAccounted(restarted, 'after the restart');

    // (7) S5: the stopped run had been given its effective allowance, the
    // per-run limit (5,000,000) capped at what the iteration had left, and is
    // charged it less what it observed (C4): unknown usage consumes the
    // allowance, never 0 (here all that was left of it at its dispatch).
    const stoppedInv = restarted.usage.runs.find((x) => x.id === pending.run.id).invocations[0];
    assert.deepEqual([stoppedInv.run_limit_tokens, stoppedInv.limited_by], [5_000_000, 'iteration'], `the run was given what the iteration had left (${JSON.stringify(stoppedInv)})`);
    assert.equal(stoppedInv.unknown_allowance_tokens, stoppedInv.effective_limit_tokens - 1300, 'charged its effective allowance less the 1,300 it observed');
    const committed = restarted.remaining.committed.total_tokens;
    assert.ok(committed <= 1_500_000, `never reserved past the allowance (${committed})`);
    assert.equal(restarted.remaining.tokens, 1_500_000 - committed);
    // A limit: the owner lowers the allowance to what was committed, so that
    // nothing is left for the next run.
    if (committed < 1_500_000) {
      const res = await fx.post(`/v1/projects/${p}/policy`, { prototype_budget_tokens: Math.max(committed, 10_000) });
      assert.ok([200, 201].includes(res.status), `lowering the allowance applies directly (→ ${res.status} ${res.text})`);
      await waitFor(async () => (await fx.iteration(p, it.id)).iteration.limits.prototype_budget_tokens === Math.max(committed, 10_000), { what: 'the lowered limit committed' });
    }
    const held = (await fx.work(p)).find((w) => w.kind === 'stage_build' && w.status === 'held');
    assert.ok(held, 'the stopped run\'s work is held');
    await fx.ok(fx.post(`/v1/projects/${p}/work/${held.id}/resume`), 200, 'the owner resumes the held work');
    const runsBefore = (await fx.iteration(p, it.id)).usage.runs.length;
    await fx.tick(p);
    await fx.idle(p);
    const limited = await fx.iteration(p, it.id);
    assert.equal(limited.iteration.status, 'limit_reached', `the dispatch was refused at the limit (${JSON.stringify(limited.outcome)})`);
    assert.match(limited.outcome.reason, /^tokens: prototype_budget_tokens \d+: committed \d+ .* leaves 0: a run would get no positive allowance \(its per-run limit 5000000, capped at what the iteration has left\)/);
    assert.equal(limited.outcome.next_step, 'raise the limit or discard');
    assert.equal(limited.usage.runs.length, runsBefore, 'no run was dispatched');
    assert.equal(limited.remaining.tokens, 0, 'nothing left: the unknown allowance included');
    await fx.tick(p);
    assert.equal((await fx.iteration(p, it.id)).usage.runs.length, runsBefore, 'still no run');

    // Raised again (a widening, confirmed by the owner); the submission says
    // it reopens the iteration. Stage 1 is built by a run that reports no
    // usage at all: its usage is unknown and, the scripted provider having
    // said nothing, no allowance is charged (D2 C4).
    const raised = await answerPolicy(fx, p, await fx.post(`/v1/projects/${p}/policy`, { prototype_budget_tokens: 3_000_000 }), 'the raised allowance');
    assert.deepEqual([raised?.iteration, raised?.reopens, raised?.status], [it.id, true, 'limit_reached'], `the submission says it reopens the iteration (${JSON.stringify(raised)})`);
    await waitFor(async () => (await fx.iteration(p, it.id)).iteration.status === 'building', { what: 'the iteration open again' });
    const unknown = await pump(fx, p, async () => {
      const r = await fx.iteration(p, it.id);
      return r.iteration.status === 'limit_reached' ? r : undefined;
    }, { answer: CHECK_KINDS, what: 'the missing usage to stop dispatch' });
    const missingRun = unknown.usage.runs.filter((x) => x.work_kind === 'stage_build').at(-1);
    const missing = missingRun.invocations[0];
    assert.deepEqual([missing.usage.state, missing.usage.billable_in, missing.unknown_allowance_tokens], ['incomplete', null, null], 'missing usage: unknown, no figure');
    assert.equal(missing.limited_by, 'iteration', 'it too was given what the iteration had left');
    // S2: what is unknown is named; only what works is offered.
    assert.equal(unknown.remaining.tokens, null, 'the remaining allowance is unknown, never the limit less 0');
    assert.ok(unknown.remaining.tokens_reason.includes(`invocation ${missing.id} of run ${missingRun.id} (builder, stage_build)`), unknown.remaining.tokens_reason);
    assert.equal(unknown.remaining.committed.total_tokens, null);
    assert.equal(unknown.usage.totals.tokens.total_is, 'lower_bound');
    assert.ok(unknown.outcome.reason.includes(`invocation ${missing.id} of run ${missingRun.id}`), unknown.outcome.reason);
    assert.match(unknown.outcome.reason, /unknown billable tokens and no unknown allowance .* Raising a limit cannot resolve an unknown total; no run is dispatched against an unknown total$/);
    assert.equal(unknown.outcome.next_step, "iterate (a new iteration, whose own totals exclude this one's; the app's totals keep this unknown) or discard");
    assert.equal(unknown.controls.resume.available, false);
    assertAccounted(unknown, 'after the missing usage');
    // Raising a limit does not reopen it, and the submission says why.
    const notReopened = await answerPolicy(fx, p, await fx.post(`/v1/projects/${p}/policy`, { prototype_budget_tokens: 4_000_000 }), 'a second raise');
    assert.equal(notReopened?.reopens, false);
    assert.match(notReopened?.reason ?? '', /^iteration 1's accounting is unresolved: .*Raising a limit cannot resolve an unknown total\. Next: iterate/);
    await waitFor(async () => (await fx.iteration(p, it.id)).iteration.limits.prototype_budget_tokens === 4_000_000, { what: 'the second raise committed' });
    const still = await fx.iteration(p, it.id);
    assert.deepEqual([still.iteration.status, still.outcome.reason], ['limit_reached', unknown.outcome.reason], 'not reopened; the original uncertainty kept');
    // "prepare again" does not bypass it.
    const prepAgain = await fx.post(`/v1/projects/${p}/iterations/${it.id}/prepare`, {});
    assert.equal(prepAgain.status, 409);
    assert.match(prepAgain.body.reason, /cannot be prepared again while its accounting is unresolved: 1 charged invocation\(s\) have unknown billable tokens/);
    assert.deepEqual(prepAgain.body.subject.unknown_invocations, [missing.id]);

    // Stop: the project paused, nothing dispatched.
    const stopPath = `/v1/projects/${p}/iterations/${it.id}/stop`;
    const stopAsk = await fx.post(stopPath, {});
    assert.equal(stopAsk.status, 409, `Stop asks for its confirmation (→ ${stopAsk.status} ${stopAsk.text})`);
    await fx.ok(fx.post(stopPath, { preview_hash: stopAsk.body.subject.preview_hash }), 200, 'Stop confirmed');
    const runsAtStop = (await fx.iteration(p, it.id)).usage.runs.length;
    await fx.tick(p);
    await fx.tick(p);
    const afterStop = await fx.iteration(p, it.id);
    assert.equal(afterStop.iteration.status, 'stopped');
    assert.equal((await fx.project(p)).paused, true, 'the project is paused');
    assert.equal(afterStop.usage.runs.length, runsAtStop, 'nothing dispatched after Stop');
    assert.deepEqual(afterStop.usage.totals, unknown.usage.totals, 'Stop erases nothing of the usage');

    // Iterate from the stopped iteration: its unfinished work is not carried
    // over (cancelled), and the next step says the project must be resumed.
    const made = await fx.ok(fx.post(`/v1/projects/${p}/iterations/${it.id}/iterate`, {}), 201, 'Iterate from a stopped iteration');
    assert.equal(made.iteration.change, null);
    assert.equal(made.project_paused, true);
    assert.match(made.iteration.next_step, /^resume the project \(it is paused\), then approve preparation/);
    assert.ok(made.cancelled_work.length >= 1, `the stopped iteration's unfinished work is cancelled (${JSON.stringify(made.cancelled_work)})`);
    const left = (await fx.work(p)).filter((w) => !['complete', 'cancelled'].includes(w.status));
    assert.deepEqual(left, [], 'nothing of iteration 1 remains to be dispatched under iteration 2');
    const one = await fx.iteration(p, it.id);
    assert.deepEqual([one.iteration.status, one.usage.totals], ['stopped', afterStop.usage.totals], 'iteration 1 keeps its outcome and accounting');
    // S2: the new iteration's own totals exclude the predecessor's unknown;
    // the app's totals keep it.
    const fresh = await fx.iteration(p, made.iteration.id);
    assert.deepEqual([fresh.usage.totals.invocations, fresh.remaining.tokens, fresh.remaining.tokens_reason], [0, 4_000_000, null]);
    assert.ok(fresh.app_totals.completeness.incomplete >= 1 && fresh.app_totals.tokens.total_is !== 'complete', JSON.stringify(fresh.app_totals));
  });

  test('(10) a planned build beside the prototypes keeps its policy and behaviour', async () => {
    const p = await newPrototype(fx, { name: 'Planned beside', mode: null, tier: 'T2' });
    const read = await fx.project(p);
    assert.deepEqual([read.mode, read.prototype, read.tier], ['planned', null, 'T2']);
    assert.deepEqual((await fx.iterations(p)).iterations, [], 'a planned build has no iteration');
    const policy = await fx.ok(fx.get(`/v1/projects/${p}/policy`), 200, 'GET …/policy');
    assert.equal(policy.revision ?? policy.policy_revision ?? null, null, `no bootstrap policy revision (${JSON.stringify(policy).slice(0, 400)})`);
    const proto = await fx.ok(fx.get(`/v1/projects/${S.typed}/policy`), 200, 'the prototype\'s policy');
    assert.notDeepEqual(policy.effective, proto.effective, 'the planned build does not take the prototype preset');
    assert.notEqual(policy.effective.alpha_deploy, 'on_phase_complete', 'its alpha_deploy is the planned default');
    // Its decisions are raised as before: loosening alpha_deploy is a widening the owner confirms.
    const widen = await fx.post(`/v1/projects/${p}/policy`, { alpha_deploy: 'on_phase_complete' });
    assert.equal(widen.status, 409, `a widening asks the owner (→ ${widen.status} ${widen.text})`);
    assert.equal(widen.body.code, 'confirm_required');
    const kinds = (await fx.openDecisions(p)).map((d) => d.kind);
    assert.deepEqual(kinds, ['policy_widening'], 'the ordinary policy_widening, and no prototype question');
    await fx.tick(p);
    assert.deepEqual(await fx.work(p), [], 'nothing is dispatched for it');
  });

  test('(11) gap 3, S4: iteration 2 reaches its own Alpha through one bounded phase of its own, without counting its predecessor\'s deployment', async () => {
    const p = S.typed;
    const two = S.two;
    const oneId = S.typedRead.iteration.id;
    const before1 = await fx.iteration(p, oneId);
    const reqs2 = [...REQS, REQ4];
    fx.kindNext('brief_preparation', [prepScript({ spec: specText({ version: 2, reqs: reqs2, changeLog: [{ version: 2, change: 'Show the number of open tasks at the top' }] }), brief: modelBrief({ objectives: reqs2.map((r) => `${r.key}: ${r.statement}`), included: ['adding, listing and finishing tasks', 'the number of open tasks'] }) })], prepScript());
    fx.kindNext('replan', [secondPlanScript()], firstPlanScript());
    fx.kindNext('check_authoring', [authoringScript({ files: { ...CHECK_FILES, ...CHECK_FILE_R4 } })], authoringScript());
    fx.kindNext('stage_build', [builderOwn('src/count.mjs', 'export const open = (ts) => ts.filter((t) => !t.done).length;\n')], builderScript(1));
    await fx.ok(fx.post(`/v1/harness/deploy/environments/${S.env.id}/answers`, { call: 'deploy', answers: [{ result: 'issued', apply: true }] }), 200, 'deploy answers for iteration 2');
    const since = await fx.lastSeq();
    await fx.answerOpen(p, 'prototype_preparation_approval');
    await pump(fx, p, async () => (await fx.iteration(p, two)).iteration.status === 'awaiting_brief_approval', { what: "iteration 2's brief" });
    const briefRead = await fx.iteration(p, two);
    assert.deepEqual([briefRead.iteration.brief.version, briefRead.brief.objectives.length], [2, 4], 'a new specification revision, its four objectives');
    await fx.answerOpen(p, 'spec_approval');
    const acts = [];
    await pump(
      fx,
      p,
      async () => {
        const routed = (await fx.events(since)).find((e) => e.type === 'prototype.plan_routed_to_owner');
        if (routed) throw Object.assign(new Error(`iteration 2's plan was routed to the owner: ${JSON.stringify(routed.payload)}`), { fatal: true });
        return (await fx.iteration(p, two)).iteration.status === 'alpha_ready' ? true : undefined;
      },
      { answer: CHECK_KINDS, acts, max: 100, what: "iteration 2's own Alpha" },
    );
    const read2 = await fx.iteration(p, two);
    // Its own plan: one bounded phase, the next one (phase 2), published by the prototype policy.
    assert.deepEqual([read2.plan.routing, read2.plan.approved_by, read2.plan.bundle_status], ['policy_authorized', 'policy:rapid_prototype', 'published']);
    const authorized = (await fx.events(since)).filter((e) => e.type === 'prototype.plan_policy_authorized');
    assert.equal(authorized.length, 1);
    assert.deepEqual([authorized[0].subject.iteration, authorized[0].payload.plan_phase, authorized[0].payload.expected_phase, authorized[0].payload.stages, authorized[0].payload.phases], [two, 2, 2, 1, 2]);
    assert.notEqual(read2.plan.bundle, before1.plan.bundle);
    // Its own candidate and deployment, never its predecessor's.
    assert.match(read2.alpha.candidate ?? '', /^cand_/);
    assert.notEqual(read2.alpha.candidate, before1.alpha.candidate, 'its own candidate');
    assert.ok(read2.alpha.deployment_request && read2.alpha.deployment_request !== before1.alpha.deployment_request, 'its own deployment request');
    assert.ok(read2.iteration.alpha_at > before1.iteration.alpha_at);
    assert.deepEqual(read2.owner_approvals.by_kind, { prototype_preparation_approval: 1, spec_approval: 1, check_correction_unclassifiable: 1 }, JSON.stringify(read2.owner_approvals));
    // The predecessor's history unchanged; its stale deployment was refused as iteration 2's (case 8).
    const after1 = await fx.iteration(p, oneId);
    assert.deepEqual([after1.iteration.status, after1.iteration.alpha_at, after1.alpha.candidate, after1.alpha.deployment_request], [before1.iteration.status, before1.iteration.alpha_at, before1.alpha.candidate, before1.alpha.deployment_request], "iteration 1's Alpha history unchanged");
    assert.deepEqual(after1.usage, before1.usage, "iteration 1's usage unchanged");
    const stale = (await fx.events(0)).filter((e) => e.type === 'prototype.alpha_not_attributed' && e.subject.iteration === two);
    assert.ok(stale.length >= 1 && stale.every((e) => e.payload.candidate === before1.alpha.candidate), 'the stale deployment of the predecessor was refused, never counted');
    // Each iteration's runs its own; the app's totals both, once.
    const ids1 = new Set(after1.usage.runs.map((r) => r.id));
    assert.ok(read2.usage.runs.length > 0 && read2.usage.runs.every((r) => !ids1.has(r.id)), 'no run of iteration 1 counted in iteration 2');
    assert.equal(read2.app_totals.agent_runs, after1.usage.totals.agent_runs + read2.usage.totals.agent_runs);
    // Current availability: iteration 1's is no longer claimed, iteration
    // 2's deployment running in the environment now.
    assert.equal((await fx.iteration(p, oneId)).alpha.current, null, "iteration 1's Alpha is not claimed available: iteration 2's deployment runs there");
    assert.deepEqual(read2.alpha.environment, after1.alpha.environment, 'the same environment, its deployment replaced');
  });

  test('(12) gaps 1 and 2: two stages eligible in one tick never over-reserve the shared allowance; a restart mid-run ends the run recovered, attributed, with its allowance and consistent totals, and the iteration offers a usable next step', async () => {
    const p = await newPrototype(fx, { name: 'Tasks concurrent' });
    const it = await current(fx, p);
    const independent = STAGES.map((s) => ({ ...s, depends_on: [] }));
    fx.kindNext('brief_preparation', [prepScript()], prepScript());
    fx.kindNext('check_authoring', [authoringScript()], authoringScript());
    fx.kindNext('replan', [firstPlanScript({ stages: independent })], firstPlanScript());
    fx.kindNext('stage_build', [{ steps: [usage(1000, 0, 200), { hold: 'conc', heartbeat_ms: 250 }], on_term: 'exit' }, builderOwn('server.mjs', SERVER), builderOwn('src/b.mjs', 'export const b = 2;\n'), builderOwn('src/c.mjs', 'export const c = 3;\n')], builderScript(1));
    await fx.answerOpen(p, 'prototype_preparation_approval');
    await pump(fx, p, async () => (await current(fx, p)).status === 'awaiting_brief_approval', { what: 'the brief' });
    await alphaReady(fx, p, { port: 18090 });
    await fx.answerOpen(p, 'spec_approval');
    // Gap 1: the two stages, independent, are both eligible once the checks are authored.
    const racing = await pump(
      fx,
      p,
      async () => {
        const items = (await fx.work(p)).filter((w) => w.kind === 'stage_build');
        const r = await fx.iteration(p, it.id);
        const under = r.usage.runs.filter((x) => x.work_kind === 'stage_build' && x.finished_at === null);
        return items.length === 2 && under.length >= 1 && under[0].invocations[0]?.usage.billable_in === 1000 ? { items, r, under } : undefined;
      },
      { answer: CHECK_KINDS, wait: false, what: 'a stage build under way beside the other' },
    );
    await fx.tick(p);
    await fx.tick(p);
    const r = await fx.iteration(p, it.id);
    const under = r.usage.runs.filter((x) => x.work_kind === 'stage_build' && x.finished_at === null);
    assert.equal(under.length, 1, `one stage build under way: the first claimed was given all the iteration had left (${JSON.stringify(r.usage.runs.map((x) => [x.work_kind, x.finished_at]))})`);
    const inv = under[0].invocations[0];
    assert.deepEqual([inv.limited_by, inv.run_limit_tokens], ['iteration', 5_000_000]);
    assert.equal(r.remaining.committed.total_tokens, 1_500_000, 'settled + its reservation: exactly the allowance, never past it');
    assert.equal(r.remaining.tokens, 0);
    assert.equal(r.remaining.next_dispatch?.kind, 'settling', 'the other waits on the run under way');
    assert.equal(r.remaining.next_run_reservation_tokens, null);
    const waiting = (await fx.work(p)).filter((w) => w.kind === 'stage_build' && w.id !== under[0].work_item);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].status, 'eligible', 'not dispatched: held on the reservation');
    assertAccounted(r, 'two stages racing');

    // Gap 2: the engine killed and restarted while the run executes.
    const runId = under[0].id;
    await fx.kill();
    await fx.start();
    const ended = await waitFor(async () => {
      await fx.tick(p);
      const x = await fx.iteration(p, it.id);
      const run = x.usage.runs.find((y) => y.id === runId);
      return run?.finished_at ? { x, run } : undefined;
    }, { timeoutMs: 120_000, what: 'the interrupted run to end' });
    assert.equal(ended.run.outcome, 'recovered', `the interrupted run ends recovered (${JSON.stringify(ended.run)})`);
    assert.ok(ended.x.usage.runs.some((y) => y.id === runId), 'still attributed to its iteration');
    const ri = ended.run.invocations[0];
    assert.deepEqual([ri.usage.state, ri.usage.billable_in, ri.usage.out], ['incomplete', 1000, 200], 'what it observed is kept');
    assert.equal(ri.unknown_allowance_tokens, ri.effective_limit_tokens - 1200, 'charged its effective allowance less what it observed, never 0');
    assertAccounted(ended.x, 'after the restart');
    assert.ok(ended.x.remaining.committed.total_tokens <= 1_500_000);
    // A usable next step, each one working: with nothing left of the
    // allowance the waiting stage's dispatch meets the limit (raise it); the
    // recovered run's work is held, and the iteration names it (resume it).
    const limited = await pump(fx, p, async () => {
      const x = await fx.iteration(p, it.id);
      return x.iteration.status === 'limit_reached' ? x : undefined;
    }, { what: 'the next dispatch to meet the spent allowance' });
    assert.equal(limited.outcome.next_step, 'raise the limit or discard');
    const raised = await answerPolicy(fx, p, await fx.post(`/v1/projects/${p}/policy`, { prototype_budget_tokens: 3_000_000 }), 'the raised allowance');
    assert.equal(raised?.reopens, true);
    const named = await pump(fx, p, async () => {
      const x = await fx.iteration(p, it.id);
      return x.iteration.status === 'awaiting_owner' && (x.outcome.next_step ?? '').startsWith('resume the held work') ? x : undefined;
    }, { answer: CHECK_KINDS, what: 'the held work to be named' });
    assert.ok(named.outcome.next_step.includes(`work/${ended.run.work_item}/resume`) && named.outcome.next_step.includes(`its run ${runId} ended recovered`), named.outcome.next_step);
    await fx.ok(fx.post(`/v1/projects/${p}/work/${ended.run.work_item}/resume`), 200, 'the owner resumes the held work');
    await pump(fx, p, async () => ((await fx.iteration(p, it.id)).iteration.status === 'alpha_ready' ? true : undefined), { answer: CHECK_KINDS, max: 100, what: 'alpha_ready after the recovery' });
    const done = await fx.iteration(p, it.id);
    assert.ok(done.usage.runs.some((y) => y.id === runId && y.outcome === 'recovered'), 'the recovered run kept in the receipt');
    assertAccounted(done, 'at Alpha');
  });

  test('(13) gap 4: raising a budget does not silently undo an explicit Stop; resumption is the deliberate POST …/resume, served in controls.resume', async () => {
    const p = S.imported;
    const it = await current(fx, p);
    const before = await fx.iteration(p, it.id);
    assert.equal(before.iteration.status, 'awaiting_brief_approval');
    assert.equal(before.controls.resume.available, false);
    const stopPath = `/v1/projects/${p}/iterations/${it.id}/stop`;
    const ask = await fx.post(stopPath, {});
    assert.equal(ask.status, 409);
    const confirm = await fx.decision(p, ask.body.subject.decision);
    assert.ok(confirm.question.endsWith(`To go on: resume it (POST /v1/projects/${p}/iterations/${it.id}/resume), iterate, or discard; raising a limit does not reopen a stopped iteration.`), `the Stop question names the ways back that work (${confirm.question})`);
    await fx.ok(fx.post(stopPath, { preview_hash: ask.body.subject.preview_hash }), 200, 'Stop confirmed');
    let read = await fx.iteration(p, it.id);
    assert.deepEqual([read.iteration.status, read.outcome.next_step, (await fx.project(p)).paused], ['stopped', 'resume (POST …/resume), iterate or discard', true]);
    assert.equal(read.controls.resume.available, true, read.controls.resume.reason);
    // The owner raises the allowance: the submission says the Stop stands.
    const raised = await answerPolicy(fx, p, await fx.post(`/v1/projects/${p}/policy`, { prototype_budget_tokens: 2_000_000 }), 'the raised allowance');
    assert.equal(raised?.reopens, false);
    assert.equal(raised?.reason, `iteration ${it.seq} was stopped by the owner: raising a limit does not undo a Stop; resume it deliberately (POST /v1/projects/${p}/iterations/${it.id}/resume)`);
    await waitFor(async () => (await fx.iteration(p, it.id)).iteration.limits.prototype_budget_tokens === 2_000_000, { what: 'the raise committed' });
    await fx.tick(p);
    read = await fx.iteration(p, it.id);
    assert.deepEqual([read.iteration.status, (await fx.project(p)).paused], ['stopped', true], 'the raise committed, the Stop stands: still stopped and paused');
    const changed = (await fx.events(0)).filter((e) => e.type === 'prototype.iteration_limits_changed' && e.subject.iteration === it.id).at(-1);
    assert.deepEqual([changed.payload.reopened, changed.payload.status], [false, 'stopped']);
    assert.match(changed.payload.not_reopened_because, /raising a limit does not undo a Stop/);
    // The deliberate resume.
    assert.equal((await fx.post(`/v1/projects/${p}/iterations/${it.id}/resume`, { note: 'x' })).status, 400, 'no field is taken');
    const resumed = await fx.ok(fx.post(`/v1/projects/${p}/iterations/${it.id}/resume`, {}), 200, 'POST …/resume');
    // The brief's approval bound the policy the raise changed, so it was
    // invalidated: the iteration resumes preparing, and says what works.
    assert.equal((await fx.decision(p, before.iteration.brief.decision)).status, 'invalidated');
    assert.deepEqual([resumed.iteration.status, resumed.iteration.next_step, resumed.project_unpaused], ['preparing', 'request preparation or discard', true]);
    read = await fx.iteration(p, it.id);
    assert.deepEqual([read.iteration.status, read.outcome.next_step, (await fx.project(p)).paused], ['preparing', 'request preparation or discard', false]);
    assert.equal(read.controls.resume.available, false);
    assert.equal((await fx.post(`/v1/projects/${p}/iterations/${it.id}/resume`, {})).status, 409, 'resumed once: not stopped any more');
    const asked = await fx.ok(fx.post(`/v1/projects/${p}/iterations/${it.id}/prepare`, {}), 201, 'the next step works: a preparation asked for');
    assert.equal(asked.decision.kind, 'prototype_preparation_approval');
  });

});
