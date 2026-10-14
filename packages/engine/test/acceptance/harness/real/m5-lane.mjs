// The real lane of M5 (slice 38; rows M443 and M444; BS5 §12; D6-J02,
// D6-J04; E139 items 7 and 8, E140 N3, E141 item 3, E144 items 1 and 2;
// SEAM.md §§456, 457). PAID, by Sean's command only (the driver's at his
// delegation, E144 item 2), on his subscription token, each file run ALONE
// with `node --test` after `npm run build`, never with `run-tests.mjs --lane
// real` (which runs M2's, M3's and M4's paid files too). Sean's steps are
// docs/acceptance/reports/M5-real-lane/README.md.
//
// One run directory and one engine home (`<run dir>/home`, at most 56 bytes,
// E134) for both journeys, so that the qualification attempts are paid once;
// M2's lane (lane.mjs): the preflight, `state.json`, steps run at most once,
// halts, reruns by step (`SURETY_REAL_RERUN=<step>` clears that step and the
// steps after it in the file's order), `observed/`, the token searched for by
// its file and never shown.
//
// THE ENGINES. The qualification attempts run on a production engine (no
// `--harness`), D2 §7.2's path exactly, as M2's and M420's. The journeys'
// engine is M342's (deploy-journey.mjs): the real lane's test mode
// (`--harness-real-lane`) with the runner's own self-test and the real
// adapter (`--harness-runner-self-test run`, `--harness-deploy-adapter
// real`), without which test mode stubs both; it installs nothing by
// fixture (BS5 §4.1 rule 20): every intermediate state is reached through
// the owner's routes and the engine's transitions. Under the rehearsal switch
// alone (SEAM.md §171) the activation installs the fixture trust entries the
// fake's script form needs (the rehearsal's attempt cannot pass the
// provider-tunnel control).
//
// SEAN'S ACTS ARE PRINTED AND WAITED FOR (BS5 §12): every command he types
// (a session's open, say, save, close; `surety spec change-request`;
// `surety project adopt`; `surety qualify-adapter local_service`; `surety
// deploy`) and every decision he answers (with its curl line) is printed on
// his terminal and in `<run dir>/WAITING.txt`, and the runner waits
// SURETY_REAL_WAIT_MINUTES for it. It never acts for him, except under the
// rehearsal switch, where it runs the printed command or answers the
// decision itself, after printing it, and records that it did. If Sean
// tells the driver to act for him, the driver records his words and the act
// with `recordInstruction` (`acted_by: driver, on_instruction`).
//
// SAFETY (BS5 §4.1 rules 1, 2, 7, 8, 11, 15, 19, 20). Nothing here creates,
// stops, restarts or resets a unit, signals a process or writes to a cgroup:
// every unit is the engine's, under the run home's own prefix, made and
// removed through its adapter. The host is only read (`systemctl --user
// show` and `list-units`, filtered here; cgroup files; `journalctl --user
// -u` of exact names). Before any step that starts an engine (but a
// teardown), a unit of the run home's prefix still loaded refuses the step;
// work of an earlier try that could be dispatched refuses it. Every step
// pauses its project before its engine stops. A teardown not `applied`, or
// one that leaves anything of the prefix, halts the run directory and
// prints the exact names; nothing is cleaned by the test, and nothing by
// pattern.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { CLI, freePort, startEngine, writeEngineConfig } from '../engine.mjs';
import { decisionsOfKind } from '../decisions.mjs';
import { eventsOfType } from '../journal.mjs';
import { withStore } from '../store.mjs';
import { sandboxEnv } from '../sandbox/lane.mjs';
import { RUNTIME, attemptsOf, configContent, homeHash, operationsOf } from '../deploy/kernel.mjs';
import { REAL_ADAPTER, cgroupsNamed, holdsAny, intendedUnits, journalOf, listUnits, unitShow } from '../deploy/host.mjs';
import { LOCAL_SERVICE_VERSION, adapterQualifications, qualificationRuns } from '../deploy/qualify.mjs';
import { IDEA_BRIEF } from '../journey/reference.mjs';
import { makeAdoptedRepo } from '../retrofit/repo.mjs';
import { CLAIMS as SUMS_CLAIMS, REQUIREMENTS as SUMS_REQUIREMENTS } from '../retrofit/products.mjs';
import { trustEntries } from '../trust.mjs';
import { attemptOf } from '../sandbox/qualify.mjs';
import { collectAttempt, realPolicy } from './attempt.mjs';
import { SELF_TEST, leftovers, refuseLeftovers } from './checks-journey.mjs';
import { REAL, observe, realStep, secretArgs, secretHits, stepValue, tellSean } from './lane.mjs';
import { TALLY_ARCHITECTURE, TALLY_CHANGE_TEXT, block, ownerSays, tallyBrief, tallyContent, sumsArchitecture, sumsBrief, sumsContent, SUMS_ANSWERS } from './rehearsal-content.mjs';

// ---- what Sean decided, and the run's shape ------------------------------------------------

// E139 Q6: Opus for the Spec Writer's and the Architect's sessions (and
// Vision's), Sonnet for the Builders, Verifiers and Reviewers. The real run
// qualifies one entry per model in the one home (E146 item 3, M1: the role's
// model selects the entry), each attempt paid once.
export const MODELS = Object.freeze({ sessions: 'claude-opus-5-5', one_shots: 'claude-sonnet-5-5' });
export const ROLE_MODELS = Object.freeze({
  model_vision: MODELS.sessions,
  model_spec_writer: MODELS.sessions,
  model_architect: MODELS.sessions,
  model_builder: MODELS.one_shots,
  model_verifier: MODELS.one_shots,
  model_reviewer: MODELS.one_shots,
});
// Each file's own confirmation (SEAM.md §456): consent to one is never read
// as consent to the other or to M2's, M3's or M4's.
export const CONFIRM_PHRASE_M443 = 'I accept the M5 real journey from an idea to Alpha (M443) on my Claude subscription, about 5 USD as estimated';
export const CONFIRM_PHRASE_M444 = 'I accept the M5 real retrofit journey (M444) on my Claude subscription, about 3 USD as estimated';

// The steps in the order they run (BS5 §12, with two placements SEAM.md §456
// explains: the qualification before phase 2 so that `on_phase_complete`
// can request Alpha at its completion, and each teardown in its deployment's
// `finally`, so that no unit is loaded when a later step starts).
export const M443_STEPS = Object.freeze(['m5_attempt_opus', 'm5_attempt_sonnet', 'm5_activation', 'm5a_create', 'm5a_vision', 'm5a_spec', 'm5a_architecture', 'm5a_phase1', 'm5a_change', 'm5a_qualify', 'm5a_phase2', 'm5a_alpha', 'm5a_teardown']);
export const M444_STEPS = Object.freeze(['m5_attempt_opus', 'm5_attempt_sonnet', 'm5_activation', 'm5r_adopt', 'm5r_spec', 'm5r_architecture', 'm5r_conformance', 'm5r_qualify', 'm5r_deploy', 'm5r_teardown', 'm5r_replan', 'm5r_phase2']);

export const HOME_MAX_BYTES = 56;
export const SECRET_REF = 'deploy/ref_secret';
export const SECRET_VAR = 'REF_SECRET';
export const STEP_HOURS = 4;
const HOURS = 3_600_000;

export const homeOf = (ctx) => join(ctx.runDir, 'home');
const runHomePrefix = (ctx) => `surety-${homeHash(homeOf(ctx))}-`;
const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const one = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p));
const notEstablished = (path, what, detail) => {
  throw new Error(`${path} not established: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 900)})`}`);
};

// What a run can cost, stated before anything starts (SEAM.md §161's form).
export function costStatement(row) {
  const expected = row === 'M443' ? 'about 5 USD' : 'about 3 USD';
  return [
    `SURETY REAL LANE, M5 (row ${row}): what this run can cost, before anything starts.`,
    `Expected: ${expected} in Claude Code's own estimates (BS5 §12; E139 item 7, E140 N3), drawn from your subscription's usage limits, which your own Claude use shares.`,
    row === 'M443'
      ? '  Three sessions of a few turns each on Opus (Vision optional), about twelve to sixteen one-shot runs on Sonnet (two check authorings, four Builders, four Verifiers, four Reviewers, two phase verifications, one replan, one Spec Writer change run, plus repairs).'
      : '  Two sessions on Opus (the Spec Writer and the Architect in retrofit mode), three or four one-shot runs on Sonnet (the conformance authoring, phase verification, the replan, one Builder and its checks\' roles).',
    `  The qualification attempts, once per run directory and per model: Opus with the continuation canary, Sonnet; under 0.50 USD (E146 item 5's was 0.088 USD).`,
    `At most: each run is bounded by ${REAL.runBillableTokens} billable tokens; the project's day limit of ${REAL.dayVerifiedUsd.pathOne} USD in estimates stops it earlier. The only hard maximum is your subscription's own usage limits.`,
    'An estimate, not a cap and not an authorization. Nothing paid starts before your qualification_approval and trust_activation.',
  ].join('\n');
}
const shownCost = new Set();
export function showCost(ctx, row) {
  if (shownCost.has(row)) return;
  shownCost.add(row);
  process.stderr.write(`\n${'='.repeat(78)}\n${costStatement(row)}\n${'='.repeat(78)}\n`);
  observe(ctx, row, 'cost_statement', costStatement(row));
}

// ---- the home, its units, its secret, its engine -------------------------------------------

export function checkHome(ctx) {
  const home = homeOf(ctx);
  if (Buffer.byteLength(home) > HOME_MAX_BYTES) throw new Error(`the engine home ${home} is ${Buffer.byteLength(home)} bytes; at most ${HOME_MAX_BYTES} (E134; BS5 §4.1 rule 15). Choose a shorter SURETY_REAL_RUN_DIR. Nothing was started.`);
  return home;
}

export function unitsOfRunHome(ctx, path) {
  const units = listUnits();
  if (units === null) throw new Error(`${path} refused: the user units could not be listed, so what is loaded is unknown. Nothing was started.`);
  return units.filter((u) => u.unit.startsWith(runHomePrefix(ctx))).map((u) => u.unit);
}

function refuseLoadedUnits(ctx, path) {
  const left = unitsOfRunHome(ctx, path);
  if (left.length === 0) return;
  tellSean(ctx, [`SURETY REAL LANE: ${path} refused before starting anything: units of this run home's prefix are loaded.`, ...left.map((u) => `  ${u}`), "Each was made by this run home's engine. A rerun of the journey's teardown step asks the engine to tear it down;", 'or stop one yourself by its exact name: systemctl --user stop -- <name>. Nothing is cleaned by the test, and nothing by pattern.'].join('\n'));
  throw new Error(`${path} refused: units of the run home's prefix are loaded (${left.join(', ')}). Nothing was started.`);
}

// The one disposable secret of the service (D4 §7.4): random, made once in
// the run directory, 0600, never printed, never one of Sean's.
export function serviceSecretFile(ctx) {
  const dir = join(ctx.runDir, 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'ref_secret');
  if (!existsSync(file)) writeFileSync(file, `surety-m5-ref-${createHash('sha256').update(String(performance.now()) + String(process.pid) + Math.random()).digest('hex').slice(0, 36)}`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// The run home's engine: the journeys' (the real lane's test mode with the
// real runner and adapter), or with `production` the attempts' (above).
export async function m5Engine(ctx, { production = false } = {}) {
  const home = checkHome(ctx);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, tick_interval: 30 });
  const args = production ? secretArgs(ctx, ctx.keyRef) : [...secretArgs(ctx, ctx.keyRef), '--secret-file', `${SECRET_REF}=${serviceSecretFile(ctx)}`, '--harness-real-lane', ...SELF_TEST, ...REAL_ADAPTER];
  const engine = await startEngine({ home, port, harness: !production, args, env: { ...sandboxEnv(), PATH: `${ctx.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` }, timeoutMs: 180_000 });
  return { engine, home, port, root: ctx.runDir };
}

// A step on the run home's engine: the refusals before anything starts, the
// project resumed if asked, and in `finally` the project paused before the
// engine stops (BS5 §12).
export async function onEngine(ctx, path, { projects = [], resume = null, teardown = false, production = false } = {}, fn) {
  if (!teardown) refuseLoadedUnits(ctx, path);
  refuseLeftovers(path, leftovers(homeOf(ctx), projects.filter(Boolean)), { evenIfPaused: resume !== null });
  const fx = await m5Engine(ctx, { production });
  try {
    if (resume) {
      const res = await fx.engine.post(`/v1/projects/${resume}/resume`, {});
      if (![200, 204, 409].includes(res.status)) notEstablished(path, 'the project could not be resumed', { status: res.status, text: res.text });
    }
    return await fn(fx);
  } finally {
    for (const p of projects.filter(Boolean)) await fx.engine.post(`/v1/projects/${p}/pause`, {}).catch(() => null);
    await fx.engine.stop();
  }
}

// ---- Sean's commands, and the rehearsal's ---------------------------------------------------

export const cliLine = (home, args) => `SURETY_HOME=${home} ${process.execPath} ${CLI} ${args.map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')}`;

// A command Sean types. Printed with what it is; in a rehearsal the harness
// runs it itself, after printing it, and returns what it printed. Outside one
// it returns null: the caller waits for its effect in the store.
export function seanTypes(ctx, home, args, what) {
  if (ctx.rehearsal) {
    tellSean(ctx, `SURETY REAL LANE REHEARSAL: the harness runs Sean's command itself (SURETY_REAL_REHEARSAL=1): ${what}\n  ${cliLine(home, args)}`);
    const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, SURETY_HOME: home } });
    const out = { status: done.status, stdout: (done.stdout ?? '').slice(0, 8000), stderr: (done.stderr ?? '').slice(0, 4000) };
    if (done.status !== 0) throw new Error(`rehearsal: Sean's command failed (${what}): ${cliLine(home, args)} → ${done.status} ${out.stderr} ${out.stdout}`);
    return out;
  }
  tellSean(ctx, [`SURETY REAL LANE: waiting for Sean's own command (the test will not run it): ${what}`, 'In another terminal:', `  ${cliLine(home, args)}`, `This test waits ${ctx.waitMinutes} minutes for its effect, then stops with nothing further started.`].join('\n'));
  return null;
}

// Sean instructs the driver to act for him (BS5 §12; E138 item 2): the
// driver records the instruction's words and the act in state.json and
// `observed/`, and the report says so plainly.
export function recordInstruction(ctx, row, { words, act }) {
  observe(ctx, row, `instruction_${Date.now()}`, { acted_by: 'driver', on_instruction: words, act });
}

// Poll a store read (no tick) until it answers, on the monotonic clock.
export async function pollUntil(probe, { timeoutMs, everyMs = 5_000, what }) {
  const until = performance.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() > until) throw new Error(`no ${what} within ${Math.round(timeoutMs / 60_000)} minutes; nothing further was started`);
    await sleep(everyMs);
  }
}

const openDecisions = (home, project) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY rowid`, project).map((d) => ({ ...d, options: json(d.options), manifest: json(d.dependency_manifest ?? null) }));
const answerPath = (project, d) => `/v1/projects/${project}/decisions/${d.id}/answer`;
const curlLine = (fx, project, d, option) =>
  `curl -sS -H "X-Surety-Token: $(cat ${join(fx.home, 'api.token')})" -H 'Content-Type: application/json' -X POST http://127.0.0.1:${fx.port}${answerPath(project, d)} -d '{"option": "${option}", "preview_hash": "${d.preview_hash}"}'`;

// Tick the project until `done` answers, the owner's decisions of `expect`
// on the way printed for Sean (or, in a rehearsal, answered by the harness
// with `answer(d)`, default `approve`, after printing). A decision of another
// kind is printed for Sean too; in a rehearsal it is "not established".
// Returns {value, shown}.
export async function drive(ctx, fx, project, done, { expect = [], answer = () => 'approve', what, timeoutMs = STEP_HOURS * HOURS, everyMs }) {
  const shown = [];
  const seen = new Set();
  const started = performance.now();
  const every = everyMs ?? (ctx.rehearsal ? 3_000 : 15_000);
  for (;;) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return { value, shown };
    for (const d of openDecisions(fx.home, project)) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const option = answer(d);
      const options = (d.options ?? []).map((o) => `${o.key}${(o.blockers ?? []).length > 0 ? ` (blocked: ${(o.blockers ?? []).join(', ')})` : ''}`);
      shown.push({ kind: d.kind, id: d.id, options, at: new Date().toISOString() });
      if (ctx.rehearsal) {
        if (!expect.includes(d.kind)) notEstablished(what, `an unexpected decision ${d.kind} ${d.id} (${options.join(', ')})`);
        tellSean(ctx, `SURETY REAL LANE REHEARSAL: the harness answers ${d.kind} ${d.id} itself with "${option}" (SURETY_REAL_REHEARSAL=1).`);
        const res = await fx.engine.post(answerPath(project, d), { option, preview_hash: d.preview_hash });
        if (res.status !== 200) notEstablished(what, `answering ${d.kind} ${d.id} with ${option} was refused`, { status: res.status, text: res.text });
      } else {
        tellSean(
          ctx,
          [
            `SURETY REAL LANE: waiting for Sean's answer (the test will not answer it): ${what}.`,
            `Decision ${d.kind} ${d.id} (preview ${d.preview_hash})${expect.includes(d.kind) ? '' : ' (not one this step expects: read it before answering)'}; options: ${options.join(', ')}.`,
            `The full preview: GET /v1/projects/${project}/decisions on http://127.0.0.1:${fx.port}.`,
            ...(d.options ?? []).map((o) => `  ${o.key}: ${curlLine(fx, project, d, o.key)}`),
          ].join('\n'),
        );
      }
    }
    if (performance.now() - started > timeoutMs) throw new Error(`${what}: not reached within ${Math.round(timeoutMs / 60_000)} minutes (open decisions: ${JSON.stringify(openDecisions(fx.home, project).map((d) => [d.kind, d.id]))}); nothing further was started`);
    await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
    await sleep(every);
  }
}

// ---- reading the journey's records ------------------------------------------------------------

export const plansOf = (home, project) => rows(home, 'SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY rowid', project);
export const activePlanOf = (home, project, phase) => plansOf(home, project).find((p) => p.phase_number === phase && (p.active === 1 || p.active === true)) ?? null;
export const specVersions = (home, project) => rows(home, 'SELECT "id", "version", "approved_by" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"', project);
export const candidatesOf = (home, project) => rows(home, 'SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"', project);
export const sessionRuns = (home, project, role) => rows(home, `SELECT * FROM "runs" WHERE "project" = ? AND "kind" = 'session' AND "role" = ? ORDER BY "seq"`, project, role);
export const runsOfProject = (home, project) => rows(home, 'SELECT "id", "kind", "role", "work_item", "state", "outcome", "reason_class", "model_requested" FROM "runs" WHERE "project" = ? ORDER BY "seq"', project);
export const workOfProject = (home, project, kind) => rows(home, 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', project, kind);
export const ledgerOfProject = (home, project) => rows(home, 'SELECT * FROM "ledger_rows" WHERE "project" = ? AND "corrects" IS NULL ORDER BY rowid', project);
export const resultsOfProject = (home, project) => rows(home, 'SELECT * FROM "check_results" WHERE "project" = ? ORDER BY rowid', project);
export const deploymentRequestsOf = (home, project) => rows(home, 'SELECT * FROM "deployment_requests" WHERE "project" = ? ORDER BY rowid', project);
export const evaluationsOf = (home, project, kind) => rows(home, 'SELECT * FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = ? ORDER BY rowid', project, kind).map((e) => ({ ...e, reasons: json(e.reasons) }));
export const stagesOf = (home, project) => rows(home, 'SELECT * FROM "stages" WHERE "project" = ? ORDER BY rowid', project);

// The owner's acts as the store records them (`humanActsOf`'s reading,
// SEAM.md §375): each decision consumed by a human answer, each change
// request the owner submitted.
export function humanActs(home, project) {
  const acts = [];
  for (const e of eventsOfType(home, 'decision.consumed')) {
    if (e.subject?.project !== project) continue;
    const d = one(home, 'SELECT * FROM "decisions" WHERE "id" = ?', e.subject.decision);
    const a = json(d?.answer);
    if (a?.actor === 'human') acts.push({ kind: d.kind, id: d.id, option: a.option, seq: e.seq });
  }
  for (const e of eventsOfType(home, 'spec.change_requested')) if (e.subject?.project === project && e.payload?.source === 'owner') acts.push({ kind: 'spec_change_request', id: e.subject.spec_change_request, option: 'submit', seq: e.seq });
  return acts.sort((a, b) => a.seq - b.seq);
}

export async function readPace(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}/pace`);
  return { status: res.status, body: res.body ?? null };
}

// ---- the attempts and the activation: two entries in the one home (E146 item 3) -------------

// Opus in session_headless mode (the continuation canary among its canaries;
// it serves the sessions and any Opus one-shot), Sonnet in one_shot_headless
// mode (three canaries). Each its own step, paid at most once per run
// directory; the projects keep `role_memory_max` at its default, the
// profile the entries are qualified at.
export const QUALIFY = Object.freeze([
  { step: 'm5_attempt_opus', name: 'opus', model: MODELS.sessions, mode: 'session_headless', session: true },
  { step: 'm5_attempt_sonnet', name: 'sonnet', model: MODELS.one_shots, mode: 'one_shot_headless', session: false },
]);
const entryFor = (home, ctx, q) => trustEntries(home).find((e) => e.backend === 'claude' && e.status === 'active' && e.binary_sha256 === ctx.binarySha256 && e.model === q.model && (!q.session || e.session_qualified)) ?? null;
const FINAL = ['succeeded', 'failed', 'invalidated'];

export async function m5Attempt(ctx, row, q) {
  return realStep(ctx, q.step, () =>
    onEngine(ctx, `${row} ${q.step}`, { production: true }, async (fx) => {
      const have = entryFor(fx.home, ctx, q);
      if (have) return { path: 'already_active', entry: have.id };
      const info = await fx.engine.engineInfo();
      const fixtureProject = info.qualification_fixture_project;
      await fx.engine.post(`/v1/projects/${fixtureProject}/policy`, realPolicy(REAL.dayVerifiedUsd.qualification)).catch(() => null);
      const body = { backend: REAL.backend, mode: q.mode, model: q.model, candidate_egress: [...ctx.candidateEgress], canary_deadlines: q.session ? { ...REAL.canaryDeadlines, continuation: 600 } : { ...REAL.canaryDeadlines }, auth_mode: ctx.authMode };
      const res = await fx.engine.post('/v1/trust/qualify', body);
      if (res.status !== 201) notEstablished(q.step, 'the qualification was not proposed', { status: res.status, text: res.text });
      const attempt = res.body.qualification_attempt?.id ?? res.body.attempt?.id;
      const d = rows(fx.home, `SELECT * FROM "decisions" WHERE "kind" = 'qualification_approval' AND "subject_id" = ? AND "status" = 'open'`, attempt)[0];
      if (!d) notEstablished(q.step, 'no qualification_approval is open for the attempt', { attempt });
      const line = `curl -sS -H "X-Surety-Token: $(cat ${join(fx.home, 'api.token')})" -H 'Content-Type: application/json' -X POST http://127.0.0.1:${fx.port}/v1/decisions/${d.id}/answer -d '{"option": "approve", "preview_hash": "${d.preview_hash}"}'`;
      if (ctx.rehearsal) {
        tellSean(ctx, `SURETY REAL LANE REHEARSAL: the harness answers qualification_approval for ${q.name} itself.`);
        await fx.engine.post(`/v1/decisions/${d.id}/answer`, { option: 'approve', preview_hash: d.preview_hash });
      } else tellSean(ctx, [`SURETY REAL LANE: waiting for Sean's answer: the qualification attempt for Claude Code on ${q.model} in ${q.mode} mode, paid.`, `  approve: ${line}`, `This test waits ${ctx.waitMinutes} minutes.`].join('\n'));
      const done = await pollUntil(
        async () => {
          await fx.engine.post(`/v1/projects/${fixtureProject}/tick`, {}).catch(() => null);
          const a = attemptOf(fx.home, attempt);
          return a && FINAL.includes(a.status) ? a : undefined;
        },
        { timeoutMs: ctx.waitMinutes * 60_000 + 60 * 60_000, everyMs: 10_000, what: `the ${q.name} attempt to finish` },
      );
      const collected = collectAttempt(fx.home, attempt);
      observe(ctx, row, `attempt_${q.name}`, collected);
      if (done.status !== 'succeeded' && !ctx.rehearsal) notEstablished(q.step, `the attempt ended ${done.status}`, collected.canaries ?? null);
      // A rehearsal's attempt cannot pass the provider-tunnel control (SEAM.md §171): recorded, never a halt.
      return { path: 'attempt', attempt, status: done.status, entry: done.trust_entry ?? null, rehearsal_expected: ctx.rehearsal && done.status !== 'succeeded' ? `rehearsal: the attempt ended ${done.status}` : null };
    }),
  );
}
export const m5Attempts = async (ctx, row) => ({ opus: await m5Attempt(ctx, row, QUALIFY[0]), sonnet: await m5Attempt(ctx, row, QUALIFY[1]) });

// The rehearsal's fake in its script form, with the rehearsal's content
// embedded: what the fixture entries run (SEAM.md §§171, 456).
export function rehearsalScript(ctx, content) {
  const dir = join(ctx.runDir, 'rehearsal');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fakes = readFileSync(new URL('../standin/package-fakes.cjs', import.meta.url), 'utf8');
  const fake = readFileSync(new URL('../standin/rehearsal-claude.cjs', import.meta.url), 'utf8');
  const text = `// SURETY REHEARSAL FAKE CLAUDE, with the package-driven fakes and the rehearsal's content (M5; SEAM.md §456).\nvar SURETY_REHEARSAL_CONTENT = ${JSON.stringify(content)};\n${fakes}\n${fake}`;
  const path = join(dir, 'rehearsal-claude-m5.cjs');
  writeFileSync(path, text, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

export async function m5Activation(ctx, row, content) {
  return realStep(ctx, 'm5_activation', () =>
    onEngine(ctx, `${row} m5_activation`, {}, async (fx) => {
      const out = {};
      for (const q of QUALIFY) {
        const have = entryFor(fx.home, ctx, q);
        if (have) {
          out[q.name] = { entry: have.id, already: true };
          continue;
        }
        if (ctx.rehearsal) {
          if (ctx.authMode !== 'api_key') throw new Error('rehearsal: the journey runs on fixture entries, which record the api_key mode only; rehearse with SURETY_REAL_AUTH_MODE=api_key and a made-up key');
          const script = rehearsalScript(ctx, content);
          const res = await fx.engine.post('/v1/harness/fixtures/trust-entry', { backend: REAL.backend, status: 'active', binary: { path: script, sha256: createHash('sha256').update(readFileSync(script)).digest('hex') }, model: q.model, session_qualified: q.session, egress_hosts: [...ctx.candidateEgress] });
          if (res.status !== 201) throw new Error(`rehearsal: the fixture entry for ${q.name} was not installed (${res.status} ${res.text})`);
          out[q.name] = { entry: res.body.trust_entry.id, rehearsal_fixture: true };
          continue;
        }
        const attempt = stepValue(ctx, q.step);
        const entryId = attempt?.entry;
        if (!entryId) notEstablished('m5_activation', `no entry was written for ${q.name}`, attempt);
        const d = rows(fx.home, `SELECT * FROM "decisions" WHERE "kind" = 'trust_activation' AND "subject_id" = ? ORDER BY rowid`, entryId).at(-1);
        tellSean(ctx, [`SURETY REAL LANE: waiting for Sean's answer: the activation of the ${q.model} entry ${entryId}. Activating launches nothing.`, `  approve: curl -sS -H "X-Surety-Token: $(cat ${join(fx.home, 'api.token')})" -H 'Content-Type: application/json' -X POST http://127.0.0.1:${fx.port}/v1/decisions/${d.id}/answer -d '{"option": "approve", "preview_hash": "${d.preview_hash}"}'`].join('\n'));
        await pollUntil(() => entryFor(fx.home, ctx, q), { timeoutMs: ctx.waitMinutes * 60_000, what: `the activation of ${entryId}` });
        out[q.name] = { entry: entryId };
      }
      observe(ctx, row, 'activation', out);
      return out;
    }),
  );
}

// ---- the project's setup (the runner's, through the owner's routes) ---------------------------

// The roles on the real backend with Q6's models, the day limit and the
// journey's keys, through the owner's route (POST …/policy); a loosening of
// `alpha_deploy` (manual to on_phase_complete) is a widening the owner
// confirms (E143 item 1): the route answers 409 `confirm_required` with a
// `policy_widening` decision, which Sean answers (printed) and the rehearsal
// answers itself. `role_memory_max` is left at its default (the entries'
// profile).
export async function projectPolicy(ctx, fx, project, { widen = {}, ...extra } = {}) {
  const change = { ...realPolicy(REAL.dayVerifiedUsd.pathOne), ...ROLE_MODELS, backend_builder: 'claude', backend_verifier: 'claude', backend_reviewer: 'claude', backend_architect: 'claude', backend_spec_writer: 'claude', backend_vision: 'claude', ...extra };
  const res = await fx.engine.post(`/v1/projects/${project}/policy`, change);
  if (res.status !== 200) notEstablished('the project\'s policy', 'the owner\'s policy change was refused', { status: res.status, text: res.text });
  const out = { change, status: res.status, widened: null };
  if (Object.keys(widen).length > 0) {
    const w = await fx.engine.post(`/v1/projects/${project}/policy`, widen);
    if (w.status !== 200 && !(w.status === 409 && w.body?.code === 'confirm_required')) notEstablished('the project\'s policy', 'the widening was refused', { status: w.status, text: w.text });
    if (w.status === 409) {
      await drive(ctx, fx, project, async () => {
        const r = await fx.engine.get(`/v1/projects/${project}/policy`);
        return Object.entries(widen).every(([k, v]) => r.body?.effective?.[k] === v) ? true : undefined;
      }, { expect: ['policy_widening'], what: `the widening of ${Object.keys(widen).join(', ')} (E143 item 1)`, timeoutMs: ctx.waitMinutes * 60_000 });
    }
    out.widened = widen;
  }
  return out;
}

// The owner's configuration of `alpha` (PUT …/environments/alpha/config):
// the engine's own node by path and hash, `node server.mjs`, a free port, the
// one secret by reference, which its checks may also receive.
export async function configureAlpha(fx, project) {
  const content = configContent({ adapter_version: LOCAL_SERVICE_VERSION, port: await freePort(), start: [RUNTIME.path, 'server.mjs'], secrets: { [SECRET_VAR]: SECRET_REF }, check_secrets: [SECRET_REF] });
  const res = await fx.engine.request('PUT', `/v1/projects/${project}/environments/alpha/config`, { body: content });
  if (![200, 201].includes(res.status)) notEstablished('alpha', 'the owner\'s configuration of alpha was refused', { status: res.status, text: res.text });
  return { environment: res.body.environment, config: res.body.config, content };
}

// Sean's `surety qualify-adapter local_service` (no model; costs nothing).
export async function qualifyStep(ctx, row, name, project) {
  return realStep(ctx, name, () =>
    onEngine(ctx, `${row} ${name}`, { projects: [project] }, async (fx) => {
      const configured = await configureAlpha(fx, project);
      const before = new Set(adapterQualifications(fx.home).map((r) => r.id));
      const runsBefore = new Set(qualificationRuns(fx.home).map((r) => r.id));
      const cli = seanTypes(ctx, fx.home, ['qualify-adapter', 'local_service'], "the adapter's qualification (D4 §2.6): no model, nothing paid");
      const got = await pollUntil(() => adapterQualifications(fx.home).find((r) => !before.has(r.id) && r.status === 'current'), { timeoutMs: ctx.waitMinutes * 60_000, what: "Sean's qualify-adapter to qualify the adapter" });
      const out = { by: ctx.rehearsal ? 'the rehearsal harness (never evidence)' : "Sean's command", cli, row: { id: got.id, status: got.status, adapter: got.adapter, cases: got.cases }, runs: qualificationRuns(fx.home).filter((r) => !runsBefore.has(r.id)).map((r) => ({ id: r.id, status: r.status })), environment: configured.environment?.id ?? null, left: unitsOfRunHome(ctx, name) };
      observe(ctx, row, name, out);
      return out;
    }),
  );
}

// ---- the teardown (BS5 §12; M4's form) --------------------------------------------------------

export async function teardownStep(ctx, row, name, project, given = null) {
  return realStep(ctx, name, async () => {
    const home = homeOf(ctx);
    const body = async (fx) => {
      const envRow = one(fx.home, 'SELECT "id", "name" FROM "environments" WHERE "project" = ? AND "name" = ?', project, 'alpha') ?? null;
      const ofEnv = (kind) => (envRow ? operationsOf(fx.home, project, kind).filter((o) => o.target?.environment === envRow.id) : []);
      const deploys = ofEnv('deploy');
      const loadedBefore = unitsOfRunHome(ctx, name);
      const out = { environment: envRow?.id ?? null, deploys: deploys.map((o) => o.id), loaded_before: loadedBefore, request: null, applied: null };
      if (envRow && (deploys.length > 0 || loadedBefore.length > 0)) {
        const preempt = deploys.length > 0 && !deploys.at(-1).finalized_at;
        const earlier = new Set(ofEnv('teardown').map((o) => o.id));
        const res = await fx.engine.post(`/v1/projects/${project}/environments/alpha/teardown`, preempt ? { preempt: true } : {});
        out.request = { status: res.status, preempt, code: res.body?.code ?? null };
        if (res.status >= 200 && res.status < 300) {
          const done = await pollUntil(
            async () => {
              await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
              const t = ofEnv('teardown').find((o) => !earlier.has(o.id) && o.finalized_at);
              if (!t) return undefined;
              const latest = attemptsOf(fx.home, t.id).at(-1);
              return latest && ['succeeded', 'reconciled_succeeded', 'failed', 'reconciled_absent'].includes(latest.status) ? { op: t, attempt: latest } : undefined;
            },
            { timeoutMs: 600_000, everyMs: 5_000, what: 'the teardown of alpha to be finalized' },
          ).catch((err) => ({ error: err.message }));
          if (done.op) {
            out.attempt = { id: done.attempt.id, status: done.attempt.status, last_read: done.attempt.reconciliation_reads?.at(-1)?.result ?? null };
            out.applied = ['succeeded', 'reconciled_succeeded'].includes(done.attempt.status) && out.attempt.last_read === 'applied';
          } else out.applied = false;
        } else out.applied = false;
      }
      out.left = { units: unitsOfRunHome(ctx, name), cgroups: cgroupsNamed(runHomePrefix(ctx)), run_files: envRow ? (() => { try { return readdirSync(join(home, 'run'), { recursive: true }).map(String).filter((n) => n.includes(envRow.id)); } catch { return []; } })() : [] };
      out.journal_search = intendedUnits(home).map((unit) => {
        const j = journalOf(unit);
        return { unit, status: j.status, hits: holdsAny(j.text, { token: ctx.keyValue }).length };
      });
      observe(ctx, row, name, out);
      const clean = out.left.units.length === 0 && out.left.cgroups.length === 0 && out.left.run_files.length === 0;
      if (!clean || out.applied === false) {
        tellSean(ctx, ["SURETY REAL LANE: the teardown was not applied, or something of this run home's prefix is left. Nothing is cleaned by the test, and nothing by pattern.", ...out.left.units.map((u) => `  unit    ${u}`), ...out.left.cgroups.map((c) => `  cgroup  ${c}`), ...out.left.run_files.map((f) => `  file    ${join(home, 'run', f)}`), "To stop a unit yourself, by its exact name: systemctl --user stop -- <name>. The run directory is halted; SURETY_REAL_RERUN=" + name + ' asks the engine again.'].join('\n'));
        throw new Error(`${name}: ${out.applied === false ? 'the teardown was not applied' : 'applied'}; left ${JSON.stringify(out.left)}`);
      }
      return out;
    };
    if (given) return body(given);
    return onEngine(ctx, `${row} ${name}`, { projects: [project], resume: project, teardown: true }, body);
  });
}

// The service on the host while it runs (read only): each unit of the run
// home's prefix, its properties, the token searched for in them (counts).
export function hostWhileRunning(ctx) {
  const units = unitsOfRunHome(ctx, 'the host read');
  return units.map((unit) => {
    const props = unitShow(unit, ['LoadState', 'ActiveState', 'MainPID', 'ControlGroup', 'Delegate']);
    const all = unitShow(unit, null);
    return { unit, props, token_hits: holdsAny(JSON.stringify(all ?? ''), { token: ctx.keyValue }).length };
  });
}

// The token in no file of the run directory, no git object of the
// journey's repositories (searched in memory, never printed).
export function tokenSearch(ctx, repos) {
  const hits = secretHits(ctx.keyValue, { roots: [ctx.runDir], repos: repos.filter((r) => r && existsSync(r)) });
  return { roots: [ctx.runDir], repos, hits: hits.length, where: hits.map((h) => h.replace(ctx.keyValue, '[the key]')) };
}

// ==== M443: idea to Alpha ======================================================================

const tallyName = 'm5-real-tally';

export async function m5aCreate(ctx) {
  return realStep(ctx, 'm5a_create', () =>
    onEngine(ctx, 'M443 m5a_create', {}, async (fx) => {
      const repo = join(ctx.runDir, 'repos', 'tally');
      if (!existsSync(join(repo, '.git'))) {
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        writeFileSync(join(repo, 'README.md'), '# Tally\n');
        execFileSync('git', ['-C', repo, 'add', '-A']);
        execFileSync('git', ['-C', repo, '-c', 'user.name=Sean', '-c', 'user.email=sean@example.invalid', 'commit', '-q', '-m', 'the repository Tally starts from']);
        execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
      }
      // The idea: Sean's own brief if he gives one (SURETY_REAL_IDEA_FILE), else the reference brief (labelled).
      const ideaFile = process.env.SURETY_REAL_IDEA_FILE;
      const idea = ideaFile ? readFileSync(ideaFile, 'utf8') : IDEA_BRIEF;
      const res = await fx.engine.post('/v1/projects', { name: tallyName, tier: 'T2', dev_repo_path: repo, integration_branch: 'main', idea });
      if (res.status !== 201) notEstablished('m5a_create', 'the project was not created', { status: res.status, text: res.text });
      const project = res.body.project?.id ?? res.body.id;
      const policy = await projectPolicy(ctx, fx, project, { phase_size: { min: 1, max: 5 }, widen: { alpha_deploy: 'on_phase_complete' } });
      await fx.engine.post(`/v1/projects/${project}/pause`, {});
      const out = { project, repo, idea_from: ideaFile ? `Sean's ${ideaFile}` : 'the reference brief (harness/journey/reference.mjs IDEA_BRIEF)', policy } ;
      observe(ctx, 'M443', 'create', out);
      return out;
    }),
  );
}

// A session Sean drives from the CLI the runner prints; in a rehearsal the
// harness types the owner's words itself. Waits for `done` (the store).
async function sessionStep(ctx, fx, project, role, { words, what, expect, answer, done }) {
  const before = new Set(sessionRuns(fx.home, project, role).map((r) => r.id));
  if (ctx.rehearsal) {
    const opened = seanTypes(ctx, fx.home, ['session', 'open', '--project', project, '--role', role], `open the ${role} session`);
    const run = JSON.parse(opened.stdout).run?.id;
    const file = join(ctx.runDir, 'rehearsal', `${role}-${run}.md`);
    mkdirSync(join(ctx.runDir, 'rehearsal'), { recursive: true });
    writeFileSync(file, words);
    seanTypes(ctx, fx.home, ['session', 'say', run, '--project', project, '--file', file, '--wait-minutes', '30'], `say to the ${role}`);
    seanTypes(ctx, fx.home, ['session', 'save', run, '--project', project], `save the ${role}'s work`);
    seanTypes(ctx, fx.home, ['session', 'close', run, '--project', project], `close the ${role} session`);
  } else {
    tellSean(
      ctx,
      [
        `SURETY REAL LANE: your ${role} session (${what}). In another terminal, as often as you like (the test waits for the approval):`,
        `  ${cliLine(fx.home, ['session', 'open', '--project', project, '--role', role])}`,
        `  ${cliLine(fx.home, ['session', 'say', '<run>', '--project', project, '--text', '<what you say>'])}`,
        `  ${cliLine(fx.home, ['session', 'show', '<run>', '--project', project])}`,
        `  ${cliLine(fx.home, ['session', 'save', '<run>', '--project', project])}`,
        `  ${cliLine(fx.home, ['session', 'close', '<run>', '--project', project])}`,
        'Closing raises the decision your product calls for; the test then prints it for your answer.',
      ].join('\n'),
    );
  }
  const driven = await drive(ctx, fx, project, done, { expect, answer, what });
  const runs = sessionRuns(fx.home, project, role).filter((r) => !before.has(r.id));
  return { ...driven, runs: runs.map((r) => ({ id: r.id, outcome: r.outcome, reason_class: r.reason_class, model_requested: r.model_requested })) };
}

export async function m5aVision(ctx) {
  return realStep(ctx, 'm5a_vision', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    const choice = process.env.SURETY_REAL_VISION ?? 'skip';
    if (choice === 'skip' || ctx.rehearsal) {
      const out = { skipped: true, by: ctx.rehearsal ? 'the rehearsal' : 'SURETY_REAL_VISION=skip (D6 §1 step 2: the project was created with the brief)' };
      observe(ctx, 'M443', 'vision', out);
      return out;
    }
    return onEngine(ctx, 'M443 m5a_vision', { projects: [project], resume: project }, async (fx) => {
      const before = rows(fx.home, `SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'baseline.idea_recorded'`)[0].n;
      const s = await sessionStep(ctx, fx, project, 'vision', { what: 'the idea record', expect: ['idea_accept'], done: () => (rows(fx.home, `SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'baseline.idea_recorded'`)[0].n > before ? true : undefined) });
      observe(ctx, 'M443', 'vision', s);
      return s;
    });
  });
}

export async function m5aSpec(ctx) {
  return realStep(ctx, 'm5a_spec', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    return onEngine(ctx, 'M443 m5a_spec', { projects: [project], resume: project }, async (fx) => {
      const s = await sessionStep(ctx, fx, project, 'spec_writer', { what: 'the specification', words: ownerSays('Write the specification from the accepted idea, at the standard tier, two phases.', 'rehearsal-owner', tallyBrief()), expect: ['spec_approval'], done: () => specVersions(fx.home, project)[0] });
      const out = { ...s, spec: specVersions(fx.home, project) };
      observe(ctx, 'M443', 'spec', out);
      return out;
    });
  });
}

export async function m5aArchitecture(ctx) {
  return realStep(ctx, 'm5a_architecture', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    return onEngine(ctx, 'M443 m5a_architecture', { projects: [project], resume: project }, async (fx) => {
      const s = await sessionStep(ctx, fx, project, 'architect', { what: 'the architecture and the first plan', words: ownerSays('Design it from the approved specification and plan phase 1.', 'rehearsal-architecture', TALLY_ARCHITECTURE), expect: ['architecture_approval', 'plan_approval'], done: () => { const p = activePlanOf(fx.home, project, 1); return p?.published_at ? p : undefined; } });
      const out = { ...s, plan: { id: s.value.id, generation: s.value.generation } };
      observe(ctx, 'M443', 'architecture', out);
      return out;
    });
  });
}

const CORRECTIONS = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'];

export async function m5aPhase1(ctx) {
  return realStep(ctx, 'm5a_phase1', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    return onEngine(ctx, 'M443 m5a_phase1', { projects: [project], resume: project }, async (fx) => {
      const d = await drive(ctx, fx, project, () => { const one_ = activePlanOf(fx.home, project, 1); const two = activePlanOf(fx.home, project, 2); return one_?.completed_at && two?.published_at ? { phase1: one_.id, phase2: two.id } : undefined; }, { expect: [...CORRECTIONS, 'plan_approval'], what: 'phase 1 built, verified and complete, and phase 2 planned by the replan' });
      const out = { ...d, stages: stagesOf(fx.home, project).map((s) => ({ number: s.number, status: s.status })), runs: runsOfProject(fx.home, project) };
      observe(ctx, 'M443', 'phase1', out);
      return out;
    });
  });
}

export async function m5aChange(ctx) {
  return realStep(ctx, 'm5a_change', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    return onEngine(ctx, 'M443 m5a_change', { projects: [project], resume: project }, async (fx) => {
      const file = join(ctx.runDir, 'change-request.md');
      if (!existsSync(file)) writeFileSync(file, process.env.SURETY_REAL_CHANGE_FILE ? readFileSync(process.env.SURETY_REAL_CHANGE_FILE, 'utf8') : TALLY_CHANGE_TEXT);
      const cli = seanTypes(ctx, fx.home, ['spec', 'change-request', '--project', project, '--file', file], `the specification change (write your own in ${file} first, or keep the reference CR-1 there)`);
      const d = await drive(
        ctx,
        fx,
        project,
        () => {
          if (!specVersions(fx.home, project).some((v) => v.version === 2)) return undefined;
          const open = workOfProject(fx.home, project, 'check_correction').filter((w) => !['complete', 'cancelled'].includes(w.status));
          return open.length === 0 && workOfProject(fx.home, project, 'check_correction').length > 0 ? true : undefined;
        },
        { expect: ['spec_change', ...CORRECTIONS, 'plan_approval'], what: 'the change approved, its invalidation and its correction done' },
      );
      const out = { cli, ...d, spec: specVersions(fx.home, project), requests: rows(fx.home, 'SELECT "id", "seq", "status" FROM "spec_change_requests" WHERE "project" = ?', project) };
      observe(ctx, 'M443', 'change', out);
      return out;
    });
  });
}

export const m5aQualify = (ctx) => qualifyStep(ctx, 'M443', 'm5a_qualify', stepValue(ctx, 'm5a_create').project);

export async function m5aPhase2(ctx) {
  return realStep(ctx, 'm5a_phase2', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    return onEngine(ctx, 'M443 m5a_phase2', { projects: [project], resume: project }, async (fx) => {
      const d = await drive(ctx, fx, project, () => activePlanOf(fx.home, project, 2)?.completed_at ?? undefined, { expect: [...CORRECTIONS, 'plan_approval'], what: 'phase 2 built, verified and complete' });
      const out = { ...d, stages: stagesOf(fx.home, project).map((s) => ({ number: s.number, status: s.status })) };
      observe(ctx, 'M443', 'phase2', out);
      return out;
    });
  });
}

// Alpha under policy (K9, B14): the engine's request at phase 2's
// completion, the deployment, the verification, `alpha_deployed`; the host
// read while the service runs; the teardown in `finally`.
export async function m5aAlpha(ctx) {
  return realStep(ctx, 'm5a_alpha', async () => {
    const { project } = stepValue(ctx, 'm5a_create');
    refuseLoadedUnits(ctx, 'M443 m5a_alpha');
    const fx = await m5Engine(ctx);
    let out = null;
    try {
      await fx.engine.post(`/v1/projects/${project}/resume`, {});
      const d = await drive(ctx, fx, project, () => candidatesOf(fx.home, project).find((c) => c.progress === 'alpha_deployed'), { expect: [], what: "Alpha requested under policy, deployed and verified (alpha_deployed)", timeoutMs: 2 * HOURS });
      out = { candidate: { id: d.value.id, progress: d.value.progress }, requests: deploymentRequestsOf(fx.home, project).map((r) => ({ id: r.id, requested_by: r.requested_by, status: r.status, request_key: json(r.request_key) })), alpha_authorize: evaluationsOf(fx.home, project, 'alpha_authorize').at(-1) ?? null, alpha_complete: evaluationsOf(fx.home, project, 'alpha_complete').at(-1) ?? null, host: hostWhileRunning(ctx), shown: d.shown };
      observe(ctx, 'M443', 'alpha', out);
      return out;
    } finally {
      try {
        await teardownStep(ctx, 'M443', 'm5a_teardown', project, fx);
      } finally {
        await fx.engine.post(`/v1/projects/${project}/pause`, {}).catch(() => null);
        await fx.engine.stop();
      }
    }
  });
}

export const m5aTeardown = (ctx) => teardownStep(ctx, 'M443', 'm5a_teardown', stepValue(ctx, 'm5a_create').project);

// What the report keeps of M443 (BS5 §12): the pace read, the human acts, the ledger.
export async function m5aRecords(ctx) {
  const { project, repo } = stepValue(ctx, 'm5a_create');
  return onEngine(ctx, 'M443 records', { projects: [project], teardown: true }, async (fx) => {
    const pace = await readPace(fx, project);
    writeFileSync(join(ctx.runDir, 'observed', 'pace-M443.json'), `${JSON.stringify(pace.body, null, 2)}\n`, { mode: 0o600 });
    const out = { pace_status: pace.status, acts: humanActs(fx.home, project), ledger: ledgerOfProject(fx.home, project).map((l) => ({ run: l.run, model_requested: l.model_requested, model_observed: l.model_observed, cost_status: l.cost_status, cost_usd: l.cost_usd })), results: resultsOfProject(fx.home, project).map((r) => ({ id: r.id, execution: r.execution, runner_id: r.runner_id })), token: tokenSearch(ctx, [repo]) };
    observe(ctx, 'M443', 'records', out);
    return out;
  });
}

// ==== M444: the retrofit journey ===============================================================

const sumsName = 'm5-real-sums';
// The M4 real run's repository (E141 item 3; E144 item 1): copied, its
// recorded head checked against M4's state.json, one recorded preparation
// commit removing the Surety records; reconstruction from the records (here,
// the retrofit fixture's repository, labelled) the stated fallback, and the
// rehearsal's source.
export const M4_RUN_DIR = join(homedir(), 'surety-m4-real-20261012');

function adoptedSource(ctx) {
  const target = join(ctx.runDir, 'repos', 'sums');
  if (existsSync(join(target, '.git'))) return JSON.parse(readFileSync(join(ctx.runDir, 'repos', 'sums.json'), 'utf8'));
  mkdirSync(join(ctx.runDir, 'repos'), { recursive: true });
  let out;
  const m4 = (() => {
    try {
      return JSON.parse(readFileSync(join(M4_RUN_DIR, 'state.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const recorded = m4?.steps?.m4_build?.value?.revision ?? null;
  const from = m4?.steps?.m4_checks?.value?.repo ?? null;
  if (!ctx.rehearsal && recorded && from && existsSync(from)) {
    execFileSync('git', ['clone', '-q', '--no-local', '--branch', 'main', from, target]);
    const head = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== recorded) notEstablished('m5r_adopt', `the M4 repository's head ${head} is not the recorded ${recorded}`);
    execFileSync('git', ['-C', target, 'rm', '-rq', '--ignore-unmatch', '.surety']);
    execFileSync('git', ['-C', target, '-c', 'user.name=Surety real lane', '-c', 'user.email=surety@example.invalid', 'commit', '-q', '-m', 'M5 retrofit preparation: remove the Surety records of the M4 run (E144 item 1)']);
    out = { source: 'the M4 real run\'s Builder repository', from, recorded_head: recorded, prepared: execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  } else {
    const made = makeAdoptedRepo(target);
    out = { source: ctx.rehearsal ? 'the retrofit fixture repository (the rehearsal\'s; never evidence)' : 'reconstruction: the retrofit fixture repository, labelled (the M4 repository or its record was not found)', from: null, recorded_head: recorded, prepared: made.head };
  }
  execFileSync('git', ['-C', target, 'checkout', '-q', '--detach']);
  out.repo = target;
  writeFileSync(join(ctx.runDir, 'repos', 'sums.json'), JSON.stringify(out));
  return out;
}

export async function m5rAdopt(ctx) {
  return realStep(ctx, 'm5r_adopt', () =>
    onEngine(ctx, 'M444 m5r_adopt', {}, async (fx) => {
      const source = adoptedSource(ctx);
      const before = new Set(rows(fx.home, 'SELECT "id" FROM "projects"').map((r) => r.id));
      const cli = seanTypes(ctx, fx.home, ['project', 'adopt', sumsName, '--repo', source.repo, '--branch', 'main', '--tier', 'T1'], 'the adoption of the repository');
      const project = (await pollUntil(() => rows(fx.home, 'SELECT "id" FROM "projects" WHERE "name" = ?', sumsName).find((r) => !before.has(r.id)), { timeoutMs: ctx.waitMinutes * 60_000, what: 'the adopted project' })).id;
      await projectPolicy(ctx, fx, project, { phase_size: { min: 1, max: 5 } });
      const d = await drive(ctx, fx, project, () => rows(fx.home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'adoption_mode' AND "status" = 'consumed'`, project)[0], { expect: ['adoption_mode'], answer: () => 'full', what: 'the adoption mode (full, D6 §8.5)' });
      const p = one(fx.home, 'SELECT "adoption" FROM "projects" WHERE "id" = ?', project);
      const out = { project, source, cli, adoption: json(p?.adoption), mode: json(d.value.answer)?.option ?? null, shown: d.shown };
      observe(ctx, 'M444', 'adopt', out);
      return out;
    }),
  );
}

export async function m5rSpec(ctx) {
  return realStep(ctx, 'm5r_spec', async () => {
    const { project } = stepValue(ctx, 'm5r_adopt');
    return onEngine(ctx, 'M444 m5r_spec', { projects: [project], resume: project }, async (fx) => {
      const s = await sessionStep(ctx, fx, project, 'spec_writer', {
        what: 'the specification of the repository as it is, with the claims table; then your answer to each requirement_confirm (confirm, defect or withdraw) and the approval',
        words: ownerSays('Describe the repository as it is: every behaviour a requirement, the README\'s claims in section 12.', 'rehearsal-owner', sumsBrief()),
        expect: ['requirement_confirm', 'spec_approval'],
        answer: (d) => (d.kind === 'requirement_confirm' ? (SUMS_ANSWERS[json(d.dependency_manifest)?.key ?? d.manifest?.key] ?? 'confirm') : 'approve'),
        done: () => specVersions(fx.home, project)[0],
      });
      const claims = rows(fx.home, 'SELECT c.* FROM "spec_claims" c JOIN "spec_revisions" s ON s."id" = c."spec_revision" WHERE s."project" = ?', project);
      const confirms = decisionsOfKind(fx.home, project, 'requirement_confirm').map((d) => ({ id: d.id, key: d.manifest?.key ?? null, status: d.status, answer: d.answer ?? null }));
      const out = { ...s, claims, confirms, requirements: rows(fx.home, 'SELECT "key", "status", "origin", "defect", "reverse_engineered", "confirmed_by" FROM "requirements" WHERE "project" = ? ORDER BY "key"', project) };
      observe(ctx, 'M444', 'spec', out);
      return out;
    });
  });
}

export async function m5rArchitecture(ctx) {
  return realStep(ctx, 'm5r_architecture', async () => {
    const { project } = stepValue(ctx, 'm5r_adopt');
    return onEngine(ctx, 'M444 m5r_architecture', { projects: [project], resume: project }, async (fx) => {
      const s = await sessionStep(ctx, fx, project, 'architect', { what: 'the architecture as it is and the conformance plan', words: ownerSays('Reconstruct the architecture from the code and plan the conformance phase.', 'rehearsal-architecture', sumsArchitecture()), expect: ['architecture_approval', 'plan_approval'], done: () => { const p = activePlanOf(fx.home, project, 1); return p?.published_at ? p : undefined; } });
      const out = { ...s, conformance_stages: stagesOf(fx.home, project).filter((x) => x.conformance === 1).map((x) => ({ id: x.id, number: x.number, implements: json(x.implements), conformance_state: x.conformance_state ?? null, source_revision: x.source_revision ?? null })) };
      observe(ctx, 'M444', 'architecture', out);
      return out;
    });
  });
}

export async function m5rConformance(ctx) {
  return realStep(ctx, 'm5r_conformance', async () => {
    const { project } = stepValue(ctx, 'm5r_adopt');
    return onEngine(ctx, 'M444 m5r_conformance', { projects: [project], resume: project }, async (fx) => {
      const d = await drive(ctx, fx, project, () => { const p = activePlanOf(fx.home, project, 1); const st = stagesOf(fx.home, project).find((x) => x.conformance === 1); return p?.completed_at || ['conformed', 'blocked'].includes(st?.conformance_state) ? { plan: p?.id, state: st?.conformance_state ?? null } : undefined; }, { expect: [...CORRECTIONS], what: 'the conformance phase: the authoring with adoption, the conformance stage against A, phase verification' });
      const proposals = rows(fx.home, 'SELECT "id", "status", "classified_change_kind" FROM "protected_proposals" WHERE "project" = ? ORDER BY "seq"', project);
      const out = { ...d, proposals, stages: stagesOf(fx.home, project).map((s) => ({ number: s.number, status: s.status, conformance: s.conformance, conformance_state: s.conformance_state ?? null, source_revision: s.source_revision ?? null })), builds: workOfProject(fx.home, project, 'stage_build').length, candidates: candidatesOf(fx.home, project).map((c) => ({ id: c.id, seq: c.seq, revision: c.revision, progress: c.progress })) };
      observe(ctx, 'M444', 'conformance', out);
      return out;
    });
  });
}

export const m5rQualify = (ctx) => qualifyStep(ctx, 'M444', 'm5r_qualify', stepValue(ctx, 'm5r_adopt').project);

// Sean's `surety deploy` of c-1 (D6 §8.1 step 6; `manual`): the deployment,
// the verification, `alpha_deployed`, the barrier open; the host read; the
// teardown in `finally`.
export async function m5rDeploy(ctx) {
  return realStep(ctx, 'm5r_deploy', async () => {
    const { project } = stepValue(ctx, 'm5r_adopt');
    refuseLoadedUnits(ctx, 'M444 m5r_deploy');
    const fx = await m5Engine(ctx);
    try {
      await fx.engine.post(`/v1/projects/${project}/resume`, {});
      const c1 = candidatesOf(fx.home, project)[0];
      if (!c1) notEstablished('m5r_deploy', 'no candidate c-1');
      const cli = seanTypes(ctx, fx.home, ['deploy', c1.id, '--env', 'alpha', '--project', project], `the deployment of c-1 (${c1.id}), whose application source is A, to alpha`);
      const d = await drive(ctx, fx, project, () => candidatesOf(fx.home, project).find((c) => c.id === c1.id && c.progress === 'alpha_deployed'), { expect: [], what: 'c-1 alpha_deployed', timeoutMs: 2 * HOURS });
      const out = { cli, candidate: c1.id, progress: d.value.progress, alpha_complete: evaluationsOf(fx.home, project, 'alpha_complete').at(-1) ?? null, replans_before_complete: workOfProject(fx.home, project, 'replan').map((w) => ({ id: w.id, created_at: w.created_at })), host: hostWhileRunning(ctx) };
      observe(ctx, 'M444', 'deploy', out);
      return out;
    } finally {
      try {
        await teardownStep(ctx, 'M444', 'm5r_teardown', project, fx);
      } finally {
        await fx.engine.post(`/v1/projects/${project}/pause`, {}).catch(() => null);
        await fx.engine.stop();
      }
    }
  });
}

export const m5rTeardown = (ctx) => teardownStep(ctx, 'M444', 'm5r_teardown', stepValue(ctx, 'm5r_adopt').project);

export async function m5rReplan(ctx) {
  return realStep(ctx, 'm5r_replan', async () => {
    const { project } = stepValue(ctx, 'm5r_adopt');
    return onEngine(ctx, 'M444 m5r_replan', { projects: [project], resume: project }, async (fx) => {
      const d = await drive(ctx, fx, project, () => { const p = activePlanOf(fx.home, project, 2); return p?.published_at ? p : undefined; }, { expect: ['plan_approval'], what: 'the change-phase replan after alpha_complete, phase 2 published' });
      const out = { plan: { id: d.value.id, routing: d.value.routing }, replans: workOfProject(fx.home, project, 'replan').map((w) => ({ id: w.id, created_at: w.created_at, status: w.status })), alpha_complete: evaluationsOf(fx.home, project, 'alpha_complete').map((e) => ({ id: e.id, outcome: e.outcome, created_at: e.created_at })), shown: d.shown };
      observe(ctx, 'M444', 'replan', out);
      return out;
    });
  });
}

export async function m5rPhase2(ctx) {
  return realStep(ctx, 'm5r_phase2', async () => {
    const { project } = stepValue(ctx, 'm5r_adopt');
    return onEngine(ctx, 'M444 m5r_phase2', { projects: [project], resume: project }, async (fx) => {
      const plan = activePlanOf(fx.home, project, 2);
      const d = await drive(ctx, fx, project, () => { const st = stagesOf(fx.home, project).filter((s) => s.phase_plan === plan?.id); return st.length > 0 && st.every((s) => s.status === 'verified') ? st : undefined; }, { expect: [...CORRECTIONS, 'plan_approval'], what: 'phase 2\'s stage built by a real Builder and verified' });
      const out = { stages: d.value.map((s) => ({ number: s.number, status: s.status })), builds: runsOfProject(fx.home, project).filter((r) => r.role === 'builder'), shown: d.shown };
      observe(ctx, 'M444', 'phase2', out);
      return out;
    });
  });
}

export async function m5rRecords(ctx) {
  const { project, source } = stepValue(ctx, 'm5r_adopt');
  return onEngine(ctx, 'M444 records', { projects: [project], teardown: true }, async (fx) => {
    const pace = await readPace(fx, project);
    writeFileSync(join(ctx.runDir, 'observed', 'pace-M444.json'), `${JSON.stringify(pace.body, null, 2)}\n`, { mode: 0o600 });
    const out = { pace_status: pace.status, acts: humanActs(fx.home, project), ledger: ledgerOfProject(fx.home, project).map((l) => ({ run: l.run, model_requested: l.model_requested, cost_status: l.cost_status, cost_usd: l.cost_usd })), results: resultsOfProject(fx.home, project).map((r) => ({ id: r.id, execution: r.execution, runner_id: r.runner_id })), token: tokenSearch(ctx, [source.repo]) };
    observe(ctx, 'M444', 'records', out);
    return out;
  });
}

export { SUMS_CLAIMS, SUMS_REQUIREMENTS, block };
