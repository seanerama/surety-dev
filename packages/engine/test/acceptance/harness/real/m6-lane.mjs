// The real lane of M6 (slice 46; rows M519 and M535; BS6 §12, §4.1 rules
// 21 to 26; E156 Q5, Q6; SEAM.md §§541 to 543). PAID, by Sean's command
// only (the driver's under his standing delegation, E144 item 2), on his
// subscription token, each file run ALONE with `node --test` after `npm run
// build`, never with `run-tests.mjs --lane real` (which runs every earlier
// milestone's paid files too). Sean's steps are
// docs/acceptance/reports/M6-real-lane/README.md.
//
// M5's lane as it ended (harness/real/m5-lane.mjs, imported, not copied):
// M2's preflight (refusing, before anything starts, without
// SURETY_REAL_RUN_DIR, the credential's reference, the pinned binary and
// the file's own confirmation), `state.json`, steps run at most once,
// halts, reruns by step (`SURETY_REAL_RERUN=<step>` clears that step and
// those after it in the file's order), one run directory and one engine home
// (`<run dir>/home`, at most 56 bytes, E134), the token by path only (never
// on a command line, in a record, a unit property, a transcript or a chat),
// every step's project paused and its runs drained before its engine stops,
// a rerun refused while a unit of the run home's prefix is loaded, the
// teardown in the deployment's `finally`. The attempts (Opus
// `session_headless` with the continuation canary, Sonnet
// `one_shot_headless`) are paid once per run directory: M519 and M535 share
// one, and M535 runs only after M519 (E156 Q5).
//
// M6 ADDS:
//   - the Designer: `design: both`, `model_designer` Opus, its session's own
//     budget (`designer_session_budget_billable_tokens` 3 000 000), the
//     preview through the relay, the batched approval, the review at Alpha;
//   - the order (two placements BS6 §12's list leaves open, as M5's
//     objection 065 placed M5's): `m6?_qualify` before `m6?_design`,
//     because the preview needs a qualified `local_service` adapter (A.6
//     `design_preview_unavailable` `adapter_unqualified`) and Alpha under
//     `on_phase_complete` needs one at the phase's completion; and the build,
//     the asset change (M535), Alpha and the review in one engine, so that a
//     deployment is never split across two engines and Alpha still serves
//     when the review's engine fetches it; the teardown in its `finally`;
//   - RULE 25 at every step's end (BS6 §4.1 rule 25; M519 (h), M535 (j)): a
//     step is not judged passed while a question raised before its end is
//     open, but for the kinds it names as handed to the next step (each
//     recorded); and an engine-driven wait fails at once, naming the state,
//     when the project has nothing runnable, nothing in flight and nothing
//     asked short of the step's end. As amended by Sean (E162 item 1;
//     SEAM.md §547): every design-held stage must be accounted for (an open
//     question, an owner-opened Designer session, engine work, an unexpired
//     deferral; harness/design/holds.mjs), and a step that ends in an
//     intentional wait (a deferral, a Designer session open on a held
//     stage) is recorded `waiting` (lane.mjs StepWaiting), never `done`,
//     never passed: a deferral is never success; a `fix` the engine can no
//     longer move (no run, check, verification, due gate or repair for it
//     on any unsuperseded candidate holding it) is `stuck`, neither runnable
//     nor in flight, and fails the stall check and the review's end at once,
//     named (objection 209, F33; SEAM.md §561);
//   - WHO PERFORMED EACH OWNER ACT (rule 26; E156 Q6; SEAM.md §542): every
//     act the store records as the owner's (a decision answered by the
//     `human` actor, an owner turn in a session, an owner command) is
//     written to `observed/acts-<row>.json` with its performer, from
//     evidence beyond the store's actor: Sean's own entry in
//     `observed/owner-acts.jsonl` (docs/acceptance/reports/M6-real-lane/
//     owner-act.mjs, his terminal only) makes it `sean`; the driver's entry
//     in `observed/driver-acts.jsonl` (driver-act.mjs, Sean's words quoted)
//     makes it `driver`; neither, `unknown`; under the rehearsal switch
//     `rehearsal`. M535's four central acts must be `sean`;
//   - M519's findings and M535's start condition (E156 Q5; SEAM.md §543).
//
// SAFETY (BS6 §4.1 rules 1, 2, 7, 8, 11, 15, 19 to 26). Nothing here creates,
// stops, restarts or resets a unit, signals a process or writes to a
// cgroup: every unit (Alpha's and the preview's) is the engine's, under the
// run home's own prefix, made and removed through its adapter. The host is
// only read. The preview and Alpha are seen by Sean in his own browser
// through the relay; nothing here opens a browser, renders a mockup or
// decodes an image (rules 21, 22): under the rehearsal the harness reads the
// relay's served bytes over HTTP, as bytes.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { CLI, REPO_ROOT } from '../engine.mjs';
import { withStore } from '../store.mjs';
import { holdsAny } from '../deploy/host.mjs';
import { REAL, StepWaiting, loadState, observe, realPreflight, stepValue, tellSean } from './lane.mjs';
import { describeHolds, designHoldAccounts } from '../design/holds.mjs';
import {
  HOME_MAX_BYTES,
  MODELS,
  alphaOnce,
  candidatesOf,
  checkHome,
  cliLine,
  deploymentRequestsOf,
  evaluationsOf,
  hostWhileRunning,
  humanActs,
  ideaName,
  ledgerOfProject,
  m5Activation,
  m5Attempts,
  markRunKind,
  onEngine,
  pollUntil,
  projectPolicy,
  qualifyStep,
  readPace,
  refuseIfStopped,
  resultsOfProject,
  seanTypes,
  sessionRuns,
  specVersions,
  stagesOf,
  step,
  teardownStep,
  tokenSearch,
  unitsOfRunHome,
  activePlanOf,
} from './m5-lane.mjs';
import { DESIGNER_WORDS, OWNER_LOGO_SVG, REVIEW_WORDS, m6Content, ownerSays, pantryArchitecture, pantryBrief, rehearsalIdea } from './m6-content.mjs';

export { HOME_MAX_BYTES, MODELS };

// ---- what Sean decided (E156 Q5, Q6), and the runs' shape -----------------------------------

export const ROLE_MODELS_M6 = Object.freeze({
  model_vision: MODELS.sessions,
  model_spec_writer: MODELS.sessions,
  model_architect: MODELS.sessions,
  model_designer: MODELS.sessions,
  model_builder: MODELS.one_shots,
  model_verifier: MODELS.one_shots,
  model_reviewer: MODELS.one_shots,
});
// The caps (BS6 §12; E156 Q5): 2 000 000 billable tokens a run, the day
// bound on unknown usage twice that (E151 item 3), each Designer session
// 3 000 000 (A.7's trial default, stated), and the projects' day limits.
export const M6_BUDGET = Object.freeze({ budget_run_billable_tokens: 2_000_000, budget_day_unknown_tokens: 4_000_000, designer_session_budget_billable_tokens: 3_000_000, M519_day_usd: 40, M535_day_usd: 50 });
// Each file's own confirmation (consent to one is never read as consent to the other, or to M2 to M5's).
export const CONFIRM_PHRASE_M519 = 'I accept the M6 real run M519 (design before build and at Alpha, web) on my Claude subscription, a guess of 10 to 18 USD, capped at 2000000 tokens a run, 3000000 a Designer session and 40 USD a day';
export const CONFIRM_PHRASE_M535 = 'I accept the M6 real run M535 (web and a labelled android simulation, a held logo) on my Claude subscription, a guess of 15 to 25 USD, capped at 2000000 tokens a run, 3000000 a Designer session and 50 USD a day';

// The steps in the order they run (BS6 §12's names; the qualification before
// the design and the build to the review in one engine: see the header).
// The attempts' inner steps (M5's names) follow `m6_attempt`, so a rerun of
// it clears them too.
const COMMON = ['m6_attempt', 'm5_attempt_opus', 'm5_attempt_sonnet', 'm6_activation', 'm5_activation'];
export const M519_STEPS = Object.freeze([...COMMON, 'm6w_create', 'm6w_spec', 'm6w_architecture', 'm6w_qualify', 'm6w_design', 'm6w_build', 'm6w_alpha', 'm6w_review', 'm6w_teardown']);
export const M535_STEPS = Object.freeze([...COMMON, 'm6x_create', 'm6x_spec', 'm6x_architecture', 'm6x_qualify', 'm6x_design', 'm6x_build', 'm6x_asset', 'm6x_alpha', 'm6x_review', 'm6x_teardown']);
// The steps M535's start condition reads of M519 (the journey's own; the attempts are shared).
export const M519_JOURNEY_STEPS = Object.freeze(M519_STEPS.filter((s) => s.startsWith('m6w_')));
const STEPS = { M519: M519_STEPS, M535: M535_STEPS };
const PREFIX = { M519: 'm6w', M535: 'm6x' };
export const stepName = (row, s) => `${PREFIX[row]}_${s}`;

// M535's four central owner acts, Sean's own (E156 Q6).
export const CENTRAL_ACTS = Object.freeze(['designer_feedback', 'preview_inspection', 'combined_approval', 'review_confirmation']);
const CORRECTIONS = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'];
const HOURS = 3_600_000;

// The kinds each judged step hands to the next step at its end (BS6 §4.1
// rule 25 as amended, E162 item 1; SEAM.md §541): every other open question
// fails the step. Read by the steps below and by the kernel lane's cases.
// The Alpha step hands over `finding_disposition` too (finding F29 of the
// M535 Waterlog continuation; SEAM.md §559): Alpha deployed under policy
// can end the step at its first poll, leaving no window to answer one
// inside it, so it is carried, recorded open, to the review, the last owner
// checkpoint, which hands over nothing and does not end while one is open.
export const HANDOVER = Object.freeze({
  spec: Object.freeze([]),
  architecture: Object.freeze(['design_due', ...CORRECTIONS]),
  design: Object.freeze([...CORRECTIONS, 'plan_approval', 'finding_disposition']),
  alpha: Object.freeze(['design_due', 'finding_disposition']),
  review: Object.freeze([]),
});
const ACT_RECORD_MINUTES = () => Number(process.env.SURETY_REAL_ACT_RECORD_MINUTES ?? 15);

const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const one = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p));
export const homeOfRun = (ctx) => join(ctx.runDir, 'home');
const notEstablished = (path, what, detail) => {
  throw new Error(`${path} not established: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 900)})`}`);
};

// ---- what a run can cost, before anything starts (BS6 §12) ---------------------------------

export function costStatement(row) {
  return [
    `SURETY REAL LANE, M6 (row ${row}): what this run can cost, before anything starts.`,
    row === 'M519'
      ? 'A guess, not a promise (E156 Q5): perhaps 10 to 18 USD. V1 (the same brief, no Designer) was 8.61 USD; a Designer session on Opus of several turns adds perhaps 1 to 4 USD per target per session, and the review at Alpha is a second Designer session.'
      : 'A guess, not a promise (E156 Q5): perhaps 15 to 25 USD: two targets drawn, the asset-only approval\'s `asset_updated` fix and its checks, the review at Alpha.',
    '  The qualification attempts, once per run directory and per model: Opus with the continuation canary, Sonnet; under 0.50 USD (M519 pays them; M535 in the same run directory reuses them).',
    `At most: each run (a session is one run) is bounded by ${M6_BUDGET.budget_run_billable_tokens} billable tokens, each Designer session by ${M6_BUDGET.designer_session_budget_billable_tokens}; the project's day limit of ${row === 'M519' ? M6_BUDGET.M519_day_usd : M6_BUDGET.M535_day_usd} USD in estimates stops it earlier (a UTC day), and its day bound on unknown usage is ${M6_BUDGET.budget_day_unknown_tokens} tokens. The widenings are yours to confirm (policy_widening). The only hard maximum is your subscription's own usage limits.`,
    'An estimate, not a cap and not an authorization. Nothing paid starts before your qualification_approval and trust_activation.',
  ].join('\n');
}
const shown = new Set();
function showCost(ctx, row) {
  if (shown.has(row)) return;
  shown.add(row);
  process.stderr.write(`\n${'='.repeat(78)}\n${costStatement(row)}\n${'='.repeat(78)}\n`);
  observe(ctx, row, 'cost_statement', costStatement(row));
}

// ---- the revision, the rehearsal's record, M535's start condition (SEAM.md §543) -------------

export function checkoutRevision() {
  const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  return { head, dirty: dirty.length > 0 ? dirty.split('\n').slice(0, 20) : [] };
}
const isAncestor = (commit, of) => spawnSync('git', ['-C', REPO_ROOT, 'merge-base', '--is-ancestor', commit, of]).status === 0;

// The rehearsal of a file passed on this revision (BS6 §12 "Before each run";
// rule 18): written by a passing rehearsal's last case, read by the paid run.
export function markRehearsalPassed(ctx, row) {
  if (!ctx.rehearsal) return null;
  const rev = checkoutRevision();
  const record = { file: row, revision: rev.head, dirty: rev.dirty.length > 0, at: new Date().toISOString(), run_dir: ctx.runDir };
  writeFileSync(join(ctx.runDir, 'rehearsal-passed.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

// The findings of M519 (finding.mjs), folded: [{id, step, what, workaround, at, resolved?: {commit, at}}].
export function findingsOf(runDir) {
  const file = join(runDir, 'observed', 'findings-M519.jsonl');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = new Map();
  for (const e of lines) {
    if (e.op === 'add') out.set(e.id, { id: e.id, step: e.step, what: e.what, workaround: e.workaround ?? null, at: e.at, resolved: null });
    else if (e.op === 'resolve' && out.has(e.id)) out.get(e.id).resolved = { commit: e.commit, at: e.at };
  }
  return [...out.values()];
}

// When each step of a run directory last started (the step wrapper's record):
// a workaround recorded after a step's last start stands against that run of it.
const startsFile = (runDir) => join(runDir, 'observed', 'step-starts.json');
const readStarts = (runDir) => (existsSync(startsFile(runDir)) ? JSON.parse(readFileSync(startsFile(runDir), 'utf8')) : {});

// Whether each of a row's steps passed, and passed without a workaround (E156 Q5).
export function stepVerdicts(runDir, steps) {
  const state = existsSync(join(runDir, 'state.json')) ? JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')) : { steps: {} };
  const starts = readStarts(runDir);
  const findings = findingsOf(runDir);
  return steps.map((name) => {
    const s = state.steps?.[name] ?? null;
    const since = starts[name] ?? '';
    const workaround = findings.find((f) => f.step === name && f.workaround && f.at >= since) ?? (s?.workaround ? { id: s.workaround.finding, workaround: s.workaround.what } : null);
    const done = s?.status === 'done';
    return { step: name, status: s?.status ?? 'not_run', passed: done && !workaround, workaround: workaround ? { finding: workaround.id, what: workaround.workaround } : null };
  });
}

// M535 (k): refused, before any engine or paid step, unless M519's
// state.json records every journey step passed with none passed only by a
// workaround, every M519 finding is resolved by a commit this checkout
// contains, M535's dress rehearsal passed on this exact revision, and the
// checkout is clean. Under the rehearsal itself the M519 part is not
// applied (recorded so); the paid M519 needs its own rehearsal passed.
export function startCondition(ctx, row) {
  const rev = checkoutRevision();
  const problems = [];
  const out = { revision: rev.head, rehearsal: ctx.rehearsal };
  if (!ctx.rehearsal && rev.dirty.length > 0) problems.push(`the checkout has uncommitted changes to tracked files (${rev.dirty.join('; ')}): run from a clean checkout of the revision the rehearsal passed on`);
  if (!ctx.rehearsal) {
    const rdir = process.env[`SURETY_${row}_REHEARSAL_DIR`];
    if (!rdir) problems.push(`SURETY_${row}_REHEARSAL_DIR must name the run directory of ${row}'s dress rehearsal on this revision (BS6 §12)`);
    else {
      const file = join(rdir, 'rehearsal-passed.json');
      const rec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      if (!rec) problems.push(`${file} does not exist: ${row}'s dress rehearsal has not passed there`);
      else if (rec.file !== row) problems.push(`${file} records a rehearsal of ${rec.file}, not ${row}`);
      else if (rec.revision !== rev.head) problems.push(`${row}'s rehearsal passed on ${rec.revision}, and this checkout is ${rev.head}`);
      else if (rec.dirty) problems.push(`${row}'s rehearsal ran on a checkout with uncommitted changes`);
      out.rehearsal_record = rec;
    }
  }
  if (row === 'M535') {
    if (ctx.rehearsal) out.m519 = 'not applied: a rehearsal (never evidence)';
    else {
      const m519Dir = process.env.SURETY_M519_RUN_DIR ?? ctx.runDir;
      const verdicts = stepVerdicts(m519Dir, M519_JOURNEY_STEPS);
      const notPassed = verdicts.filter((v) => !v.passed);
      if (notPassed.length > 0) problems.push(`M519 (${m519Dir}) has steps not passed: ${notPassed.map((v) => `${v.step} ${v.status}${v.workaround ? ` (passed only by the workaround of ${v.workaround.finding})` : ''}`).join(', ')}`);
      const findings = findingsOf(m519Dir);
      for (const f of findings) {
        if (!f.resolved) problems.push(`M519's finding ${f.id} (${f.step}: ${f.what}) is not resolved`);
        else if (!isAncestor(f.resolved.commit, rev.head)) problems.push(`M519's finding ${f.id} is resolved by ${f.resolved.commit}, which this checkout (${rev.head}) does not contain`);
      }
      out.m519 = { run_dir: m519Dir, steps: verdicts, findings };
    }
  }
  if (problems.length > 0) throw new Error(`${row} refused before anything started (E156 Q5; BS6 §12):\n- ${problems.join('\n- ')}\nNothing was started.`);
  return out;
}

// ---- the preflight ----------------------------------------------------------------------------

export function m6Preflight(row) {
  const ctx = realPreflight({ confirm: row === 'M519' ? CONFIRM_PHRASE_M519 : CONFIRM_PHRASE_M535, order: STEPS[row] });
  checkHome(ctx);
  markRunKind(ctx);
  ctx.startCondition = startCondition(ctx, row);
  observe(ctx, row, 'start_condition', ctx.startCondition);
  showCost(ctx, row);
  return ctx;
}

// ---- steps: their start recorded, their end judged by rule 25 ---------------------------------

// A step of the M6 lane: M5's `step` (state.json, halts, reruns) with its
// start time recorded (for the findings' workarounds and the acts' evidence)
// and the events' sequence at its start (for the acts it observed).
//
// Every attempt of the step is kept too (M519 finding F3; the driver's
// ruling of 2026-10-18; SEAM.md §551): `observed/step-attempts.json`,
// {step: [{at, seq, ended_at, ended_seq}]}, the events' sequence read from
// the run home's store at the attempt's start and end, so that the step's
// act record covers every attempt from the first (`actWindow`), while
// `step-starts.json` keeps the last start for the judgements of the
// attempt itself (the workarounds, `stepVerdicts`).
export function m6Step(ctx, name, fn) {
  return step(ctx, name, async () => {
    const starts = readStarts(ctx.runDir);
    const before = starts[name] ?? null;
    starts[name] = new Date().toISOString();
    mkdirSync(join(ctx.runDir, 'observed'), { recursive: true, mode: 0o700 });
    writeFileSync(startsFile(ctx.runDir), `${JSON.stringify(starts, null, 2)}\n`, { mode: 0o600 });
    const attempts = readAttempts(ctx.runDir);
    // A run directory from before the attempts were kept: the step ran before, and only its last start was kept.
    attempts[name] = [...(attempts[name] ?? (before ? [unkeptAttempts(ctx, name)] : [])), { at: starts[name], seq: seqOfRun(ctx) }];
    writeAttempts(ctx.runDir, attempts);
    try {
      return await fn({ startedAt: starts[name] });
    } finally {
      const now = readAttempts(ctx.runDir);
      const last = now[name]?.at(-1);
      if (last?.at === starts[name]) {
        last.ended_at = new Date().toISOString();
        last.ended_seq = seqOfRun(ctx);
        writeAttempts(ctx.runDir, now);
      }
    }
  });
}
const maxSeq = (home) => one(home, 'SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').n;

// ---- every attempt of a step (M519 F3; SEAM.md §551) -------------------------------------------

const attemptsFile = (runDir) => join(runDir, 'observed', 'step-attempts.json');
export const readAttempts = (runDir) => (existsSync(attemptsFile(runDir)) ? JSON.parse(readFileSync(attemptsFile(runDir), 'utf8')) : {});
function writeAttempts(runDir, attempts) {
  mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
  writeFileSync(attemptsFile(runDir), `${JSON.stringify(attempts, null, 2)}\n`, { mode: 0o600 });
}
// The run home's last event, read directly (an engine running or not); null when it cannot be read.
function seqOfRun(ctx) {
  try {
    return existsSync(join(homeOfRun(ctx), 'store.db')) ? maxSeq(homeOfRun(ctx)) : null;
  } catch {
    return null;
  }
}
// The last event at or before an instant (the engine's clock, ISO-8601 UTC with milliseconds).
const seqAt = (home, at) => one(home, 'SELECT COALESCE(MAX("seq"), 0) AS n FROM "events" WHERE "at" <= ?', at).n;

// The earlier attempts of a step in a run directory from before the attempts
// were kept: taken to begin where the step before it in the file's order
// ended (its `at` in state.json), the only bound such a directory keeps, and
// to end where the next kept attempt began; unknown when no step before it
// has a recorded end. Never assumed.
function unkeptAttempts(ctx, name) {
  const order = Object.values(STEPS).find((o) => o.includes(name)) ?? [];
  const st = loadState(ctx).steps ?? {};
  const prev = order.slice(0, Math.max(0, order.indexOf(name))).reverse().find((s) => st[s]?.status === 'done' && st[s]?.at);
  return prev
    ? { at: st[prev].at, seq: null, basis: `inferred: this step's earlier attempts were made before their starts were kept (M519 F3); taken to begin where ${prev} ended (state.json)` }
    : { at: null, seq: null, basis: "unknown: this step's earlier attempts were made before their starts were kept (M519 F3), and no step before it has a recorded end" };
}

// Each attempt as a range of the events' sequence, (from, to]: from its
// start's sequence (or the last event at its start), to its end's (or the
// next attempt's start; open for the last attempt without an end). An
// attempt whose start is unknown has `from` null.
function attemptRanges(home, list) {
  return list.map((a, i) => {
    const next = list[i + 1] ?? null;
    const from = a.seq ?? (a.at ? seqAt(home, a.at) : null);
    const to = a.ended_seq ?? (a.ended_at ? seqAt(home, a.ended_at) : next ? next.seq ?? (next.at ? seqAt(home, next.at) : null) : null);
    return { from, to, at: a.at ?? null, ended_at: a.ended_at ?? next?.at ?? null, ...(a.basis ? { basis: a.basis } : {}) };
  });
}
const inRanges = (ranges, seq) => ranges.some((r) => seq > r.from && (r.to === null || r.to === undefined || seq <= r.to));

// What a step's act record covers (the driver's ruling, M519 F3): every
// attempt of the step from its first start, the store's acts in each
// attempt's range and their performers from the entries made at or after
// the first start. A first run (one attempt) keeps exactly the window its
// step passes (`sinceSeq` and `since` at this attempt's start), as before.
// Only what the act record covers changes: each step's own judgements
// (rule 25, its wait conditions, the workarounds) keep the attempt's own.
export function actWindow(ctx, name, home, { sinceSeq, since }) {
  const list = readAttempts(ctx.runDir)[name] ?? [];
  const current = { from: sinceSeq, to: null, at: since, ended_at: null };
  // m6Step keeps this attempt last, before the step runs.
  const earlier = list.length > 1 && list.at(-1).at === since ? attemptRanges(home, list).slice(0, -1) : [];
  const known = earlier.filter((r) => r.from !== null);
  return { ranges: [...known, current], since: known[0]?.at ?? since, earlier: known, unknown: earlier.filter((r) => r.from === null) };
}
const windowNote = (w) => ({
  attempts: w.ranges.map((r) => ({ from_seq: r.from, to_seq: r.to, at: r.at, ended_at: r.ended_at, ...(r.basis ? { basis: r.basis } : {}) })),
  performers_since: w.since,
  ...(w.unknown.length > 0 ? { unknown: w.unknown.map((r) => r.basis) } : {}),
});

const openDecisions = (home, project) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY rowid`, project).map((d) => ({ ...d, options: json(d.options), evidence: json(d.evidence ?? null) }));

// A `fix` the engine can no longer move (objection 209; findings F19, F26
// and F33 of the M535 Waterlog recovery attempt; Sean's ruling of
// 2026-10-23, errata E179 item 8; SEAM.md §561). Rule 25's "runnable" is
// what the engine can dispatch or is carrying, and "in flight" what it is
// doing; a `verifying` fix is moved only by a run of it, a check execution,
// a verification or review of a candidate holding it, a gate evaluation
// reading its finding, or a repair of a failed named check (D3 §2.10,
// §2.11). With none of these on any unsuperseded candidate holding it (by
// ancestry, E43) it is neither runnable nor in flight: it is listed
// `stuck`, never `runnable`, and a project with nothing else running,
// queued or asked is a silent stall naming it (BS6 §4.1 rule 25; E162 item
// 1: pending engine work accounts, and none is pending). Which gates are
// due and which repair is due are decided by the engine's own predicates,
// as E178 asks the engine's `milestoneUnmet`: `dueStageGates` and
// `heldByAncestry` of the compiled `store/transitions/gates.js` and
// `checkOutputsFor` and `currentCandidate` of `store/transitions/repair.js`
// beside the CLI (pure reads), over a read-only handle. Unknown is never
// stuck: predicates that cannot be loaded or throw leave the fix counted
// runnable, marked `judged: "unknown"`. Only `fix` items are judged so; a
// verifying `stage_build` is also completed by its phase's completion (plan/
// phase.ts), which no pure engine predicate answers, and is counted as before.
const loadEngine = (rel, names) =>
  import(pathToFileURL(join(dirname(CLI), ...rel)).href).then(
    (m) => (names.every((n) => typeof m[n] === 'function') ? m : null),
    () => null,
  );
const ENGINE_GATES = await loadEngine(['store', 'transitions', 'gates.js'], ['dueStageGates', 'heldByAncestry']);
const ENGINE_REPAIR = await loadEngine(['store', 'transitions', 'repair.js'], ['checkOutputsFor', 'currentCandidate']);
const PENDING_EXECUTION = Object.freeze(['queued', 'materializing', 'running', 'collecting']);
const STUCK_WHY = 'no run, no pending check execution, no pending verification or review, no due gate and no repair due on any unsuperseded candidate holding it: nothing the engine does will move it';

// One verifying fix: { state: 'in_flight', by } | { state: 'stuck', entry } | { state: 'unknown' }.
function fixJudgement(db, w, dueOf) {
  if (ENGINE_GATES === null || ENGINE_REPAIR === null) return { state: 'unknown' };
  try {
    if (db.prepare(`SELECT 1 FROM "runs" WHERE "work_item" = ? AND "state" <> 'ended' LIMIT 1`).get(w.id)) return { state: 'in_flight', by: 'run' };
    const unsuperseded = db.prepare(`SELECT * FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq"`).all(w.project);
    const holders = unsuperseded.filter((c) => ENGINE_GATES.heldByAncestry(db, c).includes(w.id)).map((c) => c.id);
    for (const c of holders) {
      if (db.prepare(`SELECT 1 FROM "check_executions" WHERE "candidate" = ? AND "status" IN (${PENDING_EXECUTION.map(() => '?').join(', ')}) LIMIT 1`).get(c, ...PENDING_EXECUTION)) return { state: 'in_flight', by: 'check_execution' };
      const open = db
        .prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" IN ('verification', 'review', 'phase_verification') AND json_extract("subject", '$.candidate') = ? AND "status" NOT IN ('complete', 'cancelled') LIMIT 1`)
        .get(w.project, c);
      if (open) return { state: 'in_flight', by: 'verification' };
    }
    if (dueOf().some((g) => holders.includes(g.candidate))) return { state: 'in_flight', by: 'gate_due' };
    const failed = ENGINE_REPAIR.checkOutputsFor(db, w) ?? [];
    if (failed.length > 0) {
      const current = ENGINE_REPAIR.currentCandidate(db, w);
      const taken = json(w.check_repair ?? null);
      if (!(taken && current && taken.candidate === current.id && taken.generation === w.trigger_generation)) return { state: 'in_flight', by: 'repair_due' };
    }
    const own = db.prepare(`SELECT c."id", c."superseded_by" FROM "candidates" c, json_each(c."held_work") h WHERE c."project" = ? AND h."value" = ? ORDER BY c."seq"`).all(w.project, w.id);
    return { state: 'stuck', entry: { id: w.id, kind: w.kind, status: w.status, finding: json(w.subject)?.finding ?? null, held_by: holders, own_candidates: own.map((c) => ({ id: c.id, superseded_by: c.superseded_by })), why: STUCK_WHY } };
  } catch {
    return { state: 'unknown' };
  }
}

// The listed items with every stuck fix taken out (and listed apart), and
// every fix that cannot be judged marked.
function judgeVerifyingFixes(home, project, list) {
  const fixes = list.filter((w) => w.kind === 'fix' && w.status === 'verifying');
  if (fixes.length === 0) return { runnable: list, stuck: [] };
  return withStore(home, (db) => {
    let due = null;
    const dueOf = () => (due ??= ENGINE_GATES.dueStageGates(db, { project }));
    const stuck = [];
    const unknown = new Set();
    for (const f of fixes) {
      const w = db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(f.id);
      const j = w ? fixJudgement(db, w, dueOf) : { state: 'unknown' };
      if (j.state === 'stuck') stuck.push(j.entry);
      else if (j.state === 'unknown') unknown.add(f.id);
    }
    const out = new Set(stuck.map((x) => x.id));
    return { runnable: list.filter((w) => !out.has(w.id)).map((w) => (unknown.has(w.id) ? { ...w, judged: 'unknown' } : w)), stuck };
  });
}
const describeStuck = (stuck) =>
  (stuck ?? [])
    .map((x) => `${x.kind} ${x.id} ${x.status}${x.finding ? ` (finding ${x.finding})` : ''}, held by ${x.held_by.length > 0 ? x.held_by.join(', ') : 'no unsuperseded candidate'}${x.own_candidates.some((c) => c.superseded_by) ? `, its candidate ${x.own_candidates.filter((c) => c.superseded_by).map((c) => `${c.id} superseded by ${c.superseded_by}`).join(', ')}` : ''}: ${x.why}`)
    .join('; ');

// What the project has in flight or runnable (rule 25's three questions),
// and what accounts for each design-held stage with the intentional waits
// running (E162 item 1; harness/design/holds.mjs). `nowMs` the engine's time.
// `stuck`: the verifying fixes the engine can no longer move (SEAM.md §561),
// never in `runnable`.
export function activity(home, project, { nowMs = Date.now() } = {}) {
  const live = rows(home, `SELECT "id", "kind", "role", "state", "session_state" FROM "runs" WHERE "project" = ? AND "state" <> 'ended'`, project).filter((r) => !(r.kind === 'session' && r.session_state === 'open_idle'));
  const executions = rows(home, `SELECT "id", "key", "status" FROM "check_executions" WHERE "project" = ? AND "status" IN ('queued', 'materializing', 'running', 'collecting')`, project);
  // A work item held for its design is not runnable: it waits on the design,
  // and what accounts for its hold is judged below (E162 item 1).
  const listed = rows(home, `SELECT "id", "kind", "status" FROM "work_items" WHERE "project" = ? AND "status" IN ('eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying') AND ("held" IS NULL OR "held" NOT IN ('design_pending', 'design_stale'))`, project);
  const { runnable, stuck } = judgeVerifyingFixes(home, project, listed);
  const operations = rows(home, `SELECT "id", "kind" FROM "operations" WHERE "project" = ? AND "finalized_at" IS NULL`, project);
  const held = rows(home, `SELECT "id", "kind", "status", "held" FROM "work_items" WHERE "project" = ? AND "status" IN ('held', 'parked', 'awaiting_decision')`, project);
  const asked = openDecisions(home, project).map((d) => ({ id: d.id, kind: d.kind }));
  const design = designHoldAccounts(home, project, { nowMs });
  return { live, executions, runnable, operations, held, asked, design, stuck };
}
const silent = (a) => a.live.length === 0 && a.executions.length === 0 && a.runnable.length === 0 && a.operations.length === 0 && a.asked.length === 0;

// The review step's end condition (its `done`; SEAM.md §561), one judge per
// step, kept across its polls. The review ends when it is confirmed and
// nothing runs, is queued or is asked (an E179-acknowledged question
// excepted, SEAM.md §560), as before; but a fix the engine can no longer
// move (`stuck`) is never an end: with nothing else running, queued or asked
// it is a silent stall, failed at the third such poll in a row (each after a
// tick, driveM6's rounds) naming it, never waited out to the deadline and
// never judged ended. What the step judges after its end (rule 25's
// questions, the acts and their performers, M535 (l)) is unchanged.
export function reviewEndJudge(name) {
  let quiet = 0;
  return (a, { confirmed, excepted = new Set() }) => {
    const asked = a.asked.filter((x) => !excepted.has(x.id));
    const idle = asked.length === 0 && a.live.length === 0 && a.runnable.length === 0 && a.executions.length === 0;
    if (idle && (a.stuck ?? []).length > 0) {
      quiet += 1;
      if (quiet >= 3) throw new Error(`${name}: a silent stall (BS6 §4.1 rule 25): nothing runnable, nothing in flight, nothing asked, and work the engine can no longer move: ${describeStuck(a.stuck)}`);
      return false;
    }
    quiet = 0;
    return Boolean(confirmed) && idle;
  };
}

// A project with nothing running, runnable or asked (rule 25; E162 item 1):
// `waiting` when an intentional wait on the owner runs (a deferral he chose,
// his Designer session open while a stage is held), which is reported as
// waiting and never as a pass; else `silent`, a stall. `busy` otherwise.
export function quietState(a) {
  if (!silent(a)) return { state: 'busy' };
  // The engine's own tick-driven work on a hold (the session an `open` asked
  // for, the inventory's derivation) is in flight.
  if (a.design.holds.some((h) => h.accounts.some((x) => ['designer_session_opening', 'inventory_derivation'].includes(x.work)))) return { state: 'busy' };
  if (a.design.waits.length > 0) return { state: 'waiting', waits: a.design.waits };
  return { state: 'silent' };
}
const describeWaits = (waits) => waits.map((w) => (w.cause === 'deferral' ? `the owner's deferral ${w.decision} until ${w.until}` : `the owner's Designer session ${w.run} open (${w.session_state})`)).join('; ');

// What a handed-over question is about (F29; SEAM.md §559): its finding as
// the store holds it, or its subject's type and id; a finding the store
// does not hold is said so, never left out.
function handedSubject(home, d) {
  if (d.subject_type === 'design_finding') {
    const f = one(home, 'SELECT "id", "category", "severity", "message", "interface", "requirement", "status" FROM "design_findings" WHERE "id" = ?', d.subject_id);
    return f ? { type: 'design_finding', ...f } : { type: 'design_finding', id: d.subject_id, unknown: 'no design_findings row' };
  }
  if (d.subject_type === 'finding') {
    const f = one(home, 'SELECT "id", "category", "effective_severity" AS "severity", "message", "check", "criterion", "status", "disposition" FROM "findings" WHERE "id" = ?', d.subject_id);
    return f ? { type: 'finding', ...f } : { type: 'finding', id: d.subject_id, unknown: 'no findings row' };
  }
  return { type: d.subject_type, id: d.subject_id };
}

// The record of one question a step hands over: open and not answered, with
// its options and what it is about; the harness answers nothing.
const handedEntry = (home, name, to) => (d) => ({
  kind: d.kind,
  id: d.id,
  status: d.status,
  answered: d.answer !== null && d.answer !== undefined,
  scope: d.scope,
  raised_at: d.raised_at,
  options: (d.options ?? []).map((o) => o.key),
  subject: handedSubject(home, d),
  ...(to ? { handed_to: to } : {}),
  note: `open at ${name}'s end and not answered: handed to ${to ?? 'the next step'} (BS6 §4.1 rule 25 as amended); the harness answers nothing, and nothing it names is resolved, dispositioned or verified by the handover`,
});
const describeHanded = (h) => `${h.kind} ${h.id} (${h.scope}${h.subject?.category ? `; ${h.subject.type} ${h.subject.id} ${h.subject.category}${h.subject.requirement ? ` ${h.subject.requirement}` : ''}${h.subject.interface ? ` ${h.subject.interface}` : ''}: ${JSON.stringify(h.subject.message ?? '')}` : ''}); options: ${h.options.join(', ') || 'none'}`;

// ---- E179: an owner-acknowledged question open at the review's end -----------------------------

// Errata E179 (Sean's decision of 2026-10-22, items 2 to 4; SEAM.md §560).
// For the M535 continuation's recovery only, and for the two questions it
// names (the Designer's requirement_conflict dispositions on R10 and R7,
// `change_spec` their only option), an open `finding_disposition` may stay
// open at the review's end and the run's end if, and only if, Sean has
// acknowledged it by his own record (owner-act.mjs `question_acknowledged`,
// in his terminal), naming the decision, its requirement, its implications
// and its deferred follow-up, dated after the question was raised, and the
// question holds no gate. It is recorded open and acknowledged, never
// resolved, accepted or verified; every other open question fails the step
// as before; the run so completed is "completed under E179", not M519 (h) /
// M535 (j) as written, and is not clean. `ctx.e179Scope` (the decisions in
// scope) is set by the kernel lane's cases only; a real run's is E179's.
export const E179 = Object.freeze({
  ref: 'E179',
  kind: 'finding_disposition',
  act: 'question_acknowledged',
  decisions: Object.freeze(['dec_01M5G1R5MT93JTCC54ZGRWZVEA', 'dec_01M5G1R5MVP7DRKJBPKRG233GK']),
});
const namesKey = (text, key) => new RegExp(`(^|[^A-Za-z0-9_.])${key.replace(/\./g, '\\.')}([^0-9.]|\\.(?![0-9])|$)`).test(String(text ?? ''));
// What a question holds while open: its `blocked_while_open` (D1 A), any non-empty member a gate it holds.
const holdsOf = (raw) => {
  let v = null;
  try {
    v = json(raw);
  } catch {
    return [{ unreadable: String(raw) }];
  }
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.length > 0 ? [v] : [];
  if (typeof v === 'object') return Object.entries(v).filter(([, x]) => (Array.isArray(x) ? x.length > 0 : x !== null && x !== undefined && x !== false && x !== '')).map(([k, x]) => ({ [k]: x }));
  return [v];
};
// The owner's own acknowledgement entries: owner-act.mjs's, in his terminal; never the driver's.
const acknowledgementsOf = (ctx) => ownerEntries(ctx.runDir).filter((e) => e.act === E179.act && e.entered_via === 'owner-act.mjs' && e.tty === true);

// Which open questions the owner has acknowledged under E179, and each
// acknowledgement refused with its reason. `open` the open decisions read.
export function e179Exception(ctx, home, open) {
  const scope = ctx.e179Scope ?? E179.decisions;
  const entries = acknowledgementsOf(ctx);
  const acknowledged = [];
  const refused = [];
  for (const d of open) {
    const naming = entries.filter((e) => e.decision === d.id || String(e.words ?? '').includes(d.id));
    if (naming.length === 0) continue;
    const refuse = (reason) => refused.push({ kind: d.kind, id: d.id, reason });
    if (d.kind !== E179.kind) {
      refuse(`E179 covers an open finding_disposition only, never a ${d.kind}`);
      continue;
    }
    if (!scope.includes(d.id)) {
      refuse(`not one of the questions E179 names (${scope.join(', ')})`);
      continue;
    }
    const subject = handedSubject(home, d);
    const req = subject.requirement ?? null;
    if (d.subject_type !== 'design_finding' || subject.category !== 'requirement_conflict' || !req) {
      refuse(`E179 covers a Designer requirement_conflict naming a requirement; this question is about ${subject.type} ${subject.id}${subject.category ? ` (${subject.category})` : ''}`);
      continue;
    }
    const holds = holdsOf(d.blocked_while_open);
    if (holds.length > 0) {
      refuse(`it holds a gate while open (blocked_while_open ${JSON.stringify(holds)}): no acknowledgement takes it into exception`);
      continue;
    }
    if (subject.interface) {
      refuse(`its finding disputes the interface ${subject.interface}, which holds a design approval (DESIGN_INTERFACE_DISPUTED): no acknowledgement takes it into exception`);
      continue;
    }
    const why = (e) => {
      if (e.decision !== d.id || !String(e.words ?? '').includes(d.id)) return 'it does not name the decision in its decision field and its words';
      if (e.requirement !== req || !namesKey(e.words, req)) return `it does not name the question's requirement ${req} in its requirement field and its words`;
      if (!String(e.implications ?? '').trim()) return 'it states no implications';
      if (!String(e.follow_up ?? '').trim()) return 'it states no deferred follow-up';
      const at = Date.parse(e.at);
      const raised = Date.parse(d.raised_at);
      if (!Number.isFinite(at) || !Number.isFinite(raised)) return `its date or the question's cannot be read (${e.at}; raised ${d.raised_at})`;
      if (at <= raised) return `it is dated ${e.at}, not after the question was raised (${d.raised_at})`;
      return null;
    };
    const valid = naming.filter((e) => why(e) === null);
    if (valid.length === 0) {
      refuse(`no acknowledgement of it counts: ${naming.map((e) => `${e.at}: ${why(e)}`).join('; ')}`);
      continue;
    }
    const e = valid.at(-1);
    acknowledged.push({
      kind: d.kind,
      id: d.id,
      status: d.status,
      answered: d.answer !== null && d.answer !== undefined,
      scope: d.scope,
      raised_at: d.raised_at,
      options: (d.options ?? []).map((o) => o.key),
      subject,
      requirement: req,
      exception: E179.ref,
      acknowledgement: { at: e.at, decision: e.decision, requirement: e.requirement, implications: e.implications, follow_up: e.follow_up, words: e.words, entered_via: e.entered_via, user: e.user ?? null },
      verification_gap: `requirement ${req}: the Designer's requirement_conflict (${JSON.stringify(subject.message ?? '')}) is open and unrouted; ${req} is not verified against it, and no check, review or approval covers it`,
      note: `open and acknowledged by the owner under ${E179.ref}: not answered, not resolved, not dispositioned, nothing it names verified; its follow-up deferred as his record states`,
    });
  }
  return { scope, acknowledged, refused };
}

// The run's end under rule 25 and E179 (M535 (j); the records): every
// question open in the store, each acknowledged one, each acknowledgement
// refused. Never throws: `e179RunEnd` judges it.
export function e179Record(ctx, home, project) {
  const open = openDecisions(home, project);
  const ex = e179Exception(ctx, home, open);
  const ids = new Set(ex.acknowledged.map((a) => a.id));
  const unacknowledged = open.filter((d) => !ids.has(d.id)).map((d) => ({ kind: d.kind, id: d.id, refused: ex.refused.filter((r) => r.id === d.id).map((r) => r.reason) }));
  const satisfied = open.length === 0;
  return {
    ref: E179.ref,
    open: open.map((d) => ({ kind: d.kind, id: d.id })),
    open_acknowledged: ex.acknowledged,
    unacknowledged,
    refused: ex.refused,
    satisfied_as_written: satisfied,
    completed_under: !satisfied && unacknowledged.length === 0 ? E179.ref : null,
    clean: satisfied,
    statement: satisfied
      ? 'no question open at the run\'s end: M519 (h) / M535 (j) satisfied as written'
      : unacknowledged.length === 0
        ? `completed under ${E179.ref}, not as written: M519 (h) / M535 (j) ("at the end, no question open") are not satisfied; ${ex.acknowledged.map((a) => `${a.kind} ${a.id} (${a.requirement})`).join(', ')} open and acknowledged by the owner, not resolved or verified; the run is not clean`
        : `not passed: open at the run's end and not acknowledged under ${E179.ref}: ${unacknowledged.map((u) => `${u.kind} ${u.id}${u.refused.length > 0 ? ` (acknowledgement refused: ${u.refused.join('; ')})` : ''}`).join(', ')}`,
  };
}

// The run's end judged (M535 (j)): every open question acknowledged under
// E179 and listed so in the review's own value, or the judgement fails.
export function e179RunEnd(ctx, row, home, project) {
  const rec = e179Record(ctx, home, project);
  if (rec.unacknowledged.length > 0) throw new Error(`${row}: ${rec.statement} (BS6 §4.1 rule 25; ${E179.ref})`);
  const review = stepValue(ctx, stepName(row, 'review'));
  const atReview = new Set((review.rule_25?.acknowledged_open ?? []).map((a) => a.id));
  const missing = rec.open_acknowledged.filter((a) => !atReview.has(a.id));
  if (missing.length > 0) throw new Error(`${row}: open at the run's end and acknowledged, but not recorded open and acknowledged at the review's end: ${missing.map((a) => `${a.kind} ${a.id}`).join(', ')} (${E179.ref})`);
  return rec;
}

// Rule 25 at a step's end: every open question fails the step but those of
// the kinds it hands to the next step (`to`, when named), which are recorded
// open and unanswered with what they are about (F29). Every design-held
// stage must be accounted for (E162 item 1): one accounted for by nothing
// fails the step; and a step that ends in an intentional wait (an unexpired
// deferral, or a Designer session open while a stage is held) is not passed
// but recorded `waiting` (StepWaiting): a deferral is never success.
// With `exception` (the review's run context, E179), a finding_disposition
// the owner acknowledged under E179 stays open without failing the step,
// recorded in `acknowledged_open`, and the step is `completed_under` E179;
// an acknowledgement refused is named beside the question it fails.
export function ruleTwentyFive(home, project, name, { handover = [], to = null, exception = null, nowMs = Date.now() } = {}) {
  const all = openDecisions(home, project);
  const ex = exception ? e179Exception(exception, home, all) : { acknowledged: [], refused: [] };
  const excepted = new Set(ex.acknowledged.map((a) => a.id));
  const open = all.filter((d) => !excepted.has(d.id));
  const kept = open.filter((d) => !handover.includes(d.kind));
  const refusedOf = (d) => ex.refused.filter((r) => r.id === d.id).map((r) => ` (acknowledgement under ${E179.ref} refused: ${r.reason})`).join('');
  if (kept.length > 0) throw new Error(`${name} not passed: questions raised before its end are still open (BS6 §4.1 rule 25): ${kept.map((d) => `${d.kind} ${d.id}${refusedOf(d)}`).join(', ')}`);
  const design = designHoldAccounts(home, project, { nowMs });
  if (design.unaccounted.length > 0) throw new Error(`${name} not passed: design-held stages accounted for by nothing (no open question, no Designer session, no engine work, no unexpired deferral; BS6 §4.1 rule 25, E162 item 1): ${describeHolds(design)}`);
  if (design.waits.length > 0) throw new StepWaiting(`${name} not passed: it ends waiting on the owner, an intentional wait reported as waiting, never as a pass (BS6 §4.1 rule 25, E162 item 1): ${describeWaits(design.waits)}; holds: ${describeHolds(design)}`, design.waits);
  return { handed_over: open.map(handedEntry(home, name, to)), ...(exception ? { acknowledged_open: ex.acknowledged, completed_under: ex.acknowledged.length > 0 ? E179.ref : null } : {}), design_holds: design.holds.map((h) => ({ stage: h.stage, held: h.held, accounted_by: h.accounts.map((x) => ({ cause: x.cause, ...(x.work ? { work: x.work } : {}), ...(x.decision ? { decision: x.decision } : {}), next_action: x.next_action })) })) };
}

// ---- driving the project: Sean's answers, the rehearsal's, the stall check -------------------

const answerPath = (project, d) => `/v1/projects/${project}/decisions/${d.id}/answer`;
const curlBody = (fx, path, body) => `curl -sS -H "X-Surety-Token: $(cat ${join(fx.home, 'api.token')})" -H 'Content-Type: application/json' -X POST http://127.0.0.1:${fx.port}${path} -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;

// Tick the project until `done` answers. Each open decision is printed for
// Sean with its curl line (`extra(d)` adds fields to the answer, such as
// `assets_held`); under the rehearsal the harness answers it with
// `answer(d)` after printing it, and a kind not in `expect` is "not
// established". With `stall`, an engine-driven wait fails at once (three
// rounds, each after a tick) when the project has nothing runnable, nothing
// in flight and nothing asked (rule 25), naming what is held.
export async function driveM6(ctx, fx, project, done, { expect = [], answer = () => 'approve', extra = () => ({}), what, timeoutMs = 4 * HOURS, everyMs, stall = false }) {
  // A Reviewer's disposition differing from the owner's (scope reviewer_disagrees; S1, Sean's ruling of
  // 2026-10-20; SEAM.md §555) is answered `keep`, the owner's standing disposition (the driver's ruling): the
  // conservative routine answer. Every other question keeps its answer.
  const choose = (d) => (d.kind === 'finding_disposition' && d.scope === 'reviewer_disagrees' ? 'keep' : answer(d));
  const shownIds = new Set();
  const answered = [];
  const started = performance.now();
  const every = everyMs ?? (ctx.rehearsal ? 3_000 : 15_000);
  let quiet = 0;
  for (;;) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return { value, shown: [...shownIds], answered };
    const open = openDecisions(fx.home, project);
    const blockedOf = (d) => ((d.options ?? []).find((o) => o.key === choose(d))?.blockers ?? []).length > 0;
    open.sort((a, b) => Number(blockedOf(a)) - Number(blockedOf(b)));
    for (const d of open) {
      if (shownIds.has(d.id)) continue;
      const option = choose(d);
      // A kind the rehearsal leaves to the engine (`answer` null): under the
      // rehearsal the harness opens each Designer session itself, so a
      // design_due raised beside it (or beside the batch after its close) is
      // never answered `open`, which would open a second, empty session; the
      // engine closes it when a session opens or nothing it names is held.
      if (ctx.rehearsal && (option === null || option === undefined) && expect.includes(d.kind)) continue;
      const options = (d.options ?? []).map((o) => `${o.key}${(o.blockers ?? []).length > 0 ? ` (blocked: ${(o.blockers ?? []).join(', ')})` : ''}`);
      if (ctx.rehearsal && blockedOf(d) && open.some((x) => x.id !== d.id && !shownIds.has(x.id))) continue;
      shownIds.add(d.id);
      if (ctx.rehearsal) {
        if (!expect.includes(d.kind)) notEstablished(what, `an unexpected decision ${d.kind} ${d.id} (${options.join(', ')})`);
        tellSean(ctx, `SURETY REAL LANE REHEARSAL: the harness answers ${d.kind} ${d.id} itself with "${option}" (SURETY_REAL_REHEARSAL=1; recorded performer: rehearsal).`);
        const res = await fx.engine.post(answerPath(project, d), { option, preview_hash: d.preview_hash, ...extra(d) });
        if (res.status === 409 && open.some((x) => x.id !== d.id)) {
          shownIds.delete(d.id);
          continue;
        }
        if (res.status !== 200) notEstablished(what, `answering ${d.kind} ${d.id} with ${option} was refused`, { status: res.status, text: res.text });
        answered.push({ kind: d.kind, id: d.id, option, by: 'rehearsal' });
      } else {
        tellSean(
          ctx,
          [
            `SURETY REAL LANE: waiting for Sean's answer (the test will not answer it): ${what}.`,
            `Decision ${d.kind} ${d.id} (preview ${d.preview_hash})${expect.includes(d.kind) ? '' : ' (not one this step expects: read it before answering)'}; options: ${options.join(', ')}.`,
            `The full preview: GET /v1/projects/${project}/decisions on http://127.0.0.1:${fx.port}.`,
            ...(d.options ?? []).map((o) => `  ${o.key}: ${curlBody(fx, answerPath(project, d), { option: o.key, preview_hash: d.preview_hash, ...(o.key === option ? extra(d) : {}) })}`),
            `Then record who answered it: your own words with owner-act.mjs (in your terminal), or the driver's with driver-act.mjs and your instruction (README §3).`,
          ].join('\n'),
        );
      }
    }
    if (stall) {
      const a = activity(fx.home, project);
      const q = quietState(a);
      quiet = q.state === 'busy' ? 0 : quiet + 1;
      const stuck = a.stuck.length > 0 ? `; stuck (SEAM.md §561): ${describeStuck(a.stuck)}` : '';
      if (quiet >= 3 && q.state === 'waiting') throw new StepWaiting(`${what}: not reached: the project waits on the owner, an intentional wait reported as waiting, never as a pass (BS6 §4.1 rule 25, E162 item 1): ${describeWaits(q.waits)}; holds: ${describeHolds(a.design)}${stuck}`, q.waits);
      if (quiet >= 3) throw new Error(`${what}: a silent stall (BS6 §4.1 rule 25): nothing runnable, nothing in flight, nothing asked${stuck}; held: ${JSON.stringify(a.held)}; design holds: ${describeHolds(a.design) || 'none'}`);
    }
    if (performance.now() - started > timeoutMs) {
      const waits = designHoldAccounts(fx.home, project).waits;
      const why = `${what}: not reached within ${Math.round(timeoutMs / 60_000)} minutes (open decisions: ${JSON.stringify(openDecisions(fx.home, project).map((d) => [d.kind, d.id]))}); nothing further was started`;
      if (waits.length > 0) throw new StepWaiting(`${why}; the project waits on the owner, an intentional wait, never a pass (E162 item 1): ${describeWaits(waits)}`, waits);
      throw new Error(why);
    }
    await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
    await sleep(every);
  }
}

// ---- who performed each owner act (rule 26; E156 Q6; SEAM.md §542) ----------------------------

const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
export const ownerEntries = (runDir) => jsonl(join(runDir, 'observed', 'owner-acts.jsonl'));
export const driverEntries = (runDir) => jsonl(join(runDir, 'observed', 'driver-acts.jsonl'));

// The act a decision's answer is (README §3's names).
export function actOfDecision(home, d) {
  if (d.kind === 'design_approval') {
    const rev = one(home, 'SELECT "scope" FROM "design_revisions" WHERE "id" = ?', d.subject_id);
    return rev?.scope === 'asset_only' ? 'asset_approval' : 'combined_approval';
  }
  if (d.kind === 'spec_change' && d.batch_key && one(home, `SELECT 1 AS x FROM "decisions" WHERE "batch_key" = ? AND "kind" = 'design_approval'`, d.batch_key)) return 'combined_approval';
  if (d.kind === 'design_verdicts') return 'review_confirmation';
  if (CORRECTIONS.includes(d.kind)) return 'correction_approval';
  return d.kind;
}

// The owner acts the store recorded since `sinceSeq` (a sequence number, or
// the ranges of a step's attempts, `actWindow`): decisions answered by the
// `human` actor (grouped by act), owner turns in sessions, the adapter's
// qualifications (the owner's `surety qualify-adapter`, observed by its
// effect: a qualification run's row; a fixture's row has none; M519 F3, the
// design step's rerun qualified it again after the engine's build changed),
// and the acts the step names itself (an owner command observed by its effect).
export function storeActs(home, project, sinceSeq, named = []) {
  const ranges = Array.isArray(sinceSeq) ? sinceSeq : [{ from: sinceSeq, to: null }];
  const floor = Math.min(...ranges.map((r) => r.from));
  const acts = new Map();
  const add = (act, item) => {
    if (!acts.has(act)) acts.set(act, { act, items: [] });
    acts.get(act).items.push(item);
  };
  for (const e of rows(home, `SELECT * FROM "events" WHERE "type" = 'decision.consumed' AND "seq" > ? ORDER BY "seq"`, floor)) {
    if (!inRanges(ranges, e.seq)) continue;
    const subject = json(e.subject);
    if (subject?.project !== project) continue;
    const d = one(home, 'SELECT * FROM "decisions" WHERE "id" = ?', subject.decision);
    const a = json(d?.answer);
    if (a?.actor !== 'human') continue;
    add(actOfDecision(home, d), { decision: d.id, kind: d.kind, option: a.option, store_actor: a.actor, answered_at: e.at, route: answerPath(project, d) });
  }
  for (const t of rows(home, `SELECT t.*, r."role", r."id" AS "run_id" FROM "session_transcripts" t JOIN "runs" r ON r."id" = t."run" WHERE t."project" = ?`, project)) {
    const owner = (json(t.entries) ?? []).filter((x) => x.speaker === 'owner');
    if (owner.length === 0) continue;
    const firstSeq = rows(home, `SELECT "seq" FROM "events" WHERE "seq" > ? AND "subject" LIKE ? ORDER BY "seq"`, floor, `%${t.run_id}%`).find((e) => inRanges(ranges, e.seq))?.seq;
    if (firstSeq === null || firstSeq === undefined) continue;
    const review = one(home, 'SELECT "id" FROM "design_reviews" WHERE "run" = ?', t.run_id);
    const act = t.role === 'designer' ? (review ? 'review_session' : 'designer_feedback') : t.role === 'spec_writer' ? 'spec_session' : t.role === 'architect' ? 'architect_session' : `${t.role}_session`;
    add(act, { run: t.run_id, owner_turns: owner.length, store_actor: 'owner (transcript speaker)', answered_at: owner.at(-1)?.at ?? null, route: `POST /v1/projects/${project}/sessions/${t.run_id}/turns` });
  }
  for (const e of rows(home, `SELECT "seq", "at", "subject" FROM "events" WHERE "type" = 'adapter.qualified' AND "seq" > ? ORDER BY "seq"`, floor)) {
    if (!inRanges(ranges, e.seq)) continue;
    const q = one(home, 'SELECT "id", "adapter", "run" FROM "adapter_qualifications" WHERE "id" = ?', json(e.subject)?.adapter_qualification);
    if (!q?.run) continue;
    add('qualify_adapter', { qualification: q.id, adapter: q.adapter, qualification_run: q.run, store_actor: "the owner's CLI (a qualification run)", answered_at: e.at, route: `surety qualify-adapter ${q.adapter}` });
  }
  for (const n of named) add(n.act, n);
  return [...acts.values()];
}

// The performer of each act from the entries made since the step started.
export function performers(ctx, acts, since) {
  const owner = ownerEntries(ctx.runDir).filter((e) => e.at >= since);
  const driver = driverEntries(ctx.runDir).filter((e) => e.at >= since);
  return acts.map((a) => {
    // The preview inspection's relay record is on the item the step named (inspectionAct), not on the act (harness finding F7).
    const inspection = a.relay_requests !== undefined ? a : (a.items ?? []).find((i) => i.relay_requests !== undefined);
    const o = owner.filter((e) => e.act === a.act);
    const dr = driver.filter((e) => e.act === a.act);
    let performer;
    if (ctx.rehearsal) performer = 'rehearsal';
    else if (o.length > 0 && dr.length > 0) performer = 'unknown';
    else if (o.length > 0) performer = 'sean';
    else if (dr.length > 0) performer = 'driver';
    else performer = 'unknown';
    return {
      ...a,
      performer,
      evidence: {
        ...(o.length > 0 ? { owner_entry: o.at(-1) } : {}),
        ...(dr.length > 0 ? { instruction: dr.at(-1).on_instruction, driver_entry: dr.at(-1) } : {}),
        ...(o.length > 0 && dr.length > 0 ? { conflict: 'both Sean and the driver recorded this act: who performed it is unknown' } : {}),
        ...(inspection ? { relay_requests: inspection.relay_requests, relay: inspection.relay } : {}),
      },
    };
  });
}

const actsFile = (ctx, row) => join(ctx.runDir, 'observed', `acts-${row}.json`);
export const readActs = (ctx, row) => (existsSync(actsFile(ctx, row)) ? JSON.parse(readFileSync(actsFile(ctx, row), 'utf8')) : []);
// A step's acts, in place of those recorded for it before.
function writeStepActs(ctx, row, name, stamped) {
  const all = readActs(ctx, row).filter((a) => a.step !== name).concat(stamped);
  mkdirSync(join(ctx.runDir, 'observed'), { recursive: true, mode: 0o700 });
  writeFileSync(actsFile(ctx, row), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

// M519 F3, a run directory from before the attempts were kept (the driver's
// ruling of 2026-10-18; SEAM.md §551): a step done after a rerun of it (its
// name in state.json's `reruns_applied`), with no attempts kept, has an act
// record of its last attempt alone. It is rebuilt once, from the store (read
// only, the step's engine stopped) and the act entries, over every attempt:
// the earlier ones from where the step before it ended (`unkeptAttempts`),
// the last from its kept start (step-starts.json) to its end (state.json),
// so that no later step's act is taken in. No performer is waited for: an
// act without an entry is `unknown`. The attempts are then kept, so that it
// is never rebuilt again and a later rerun of the step adds to them. Returns
// the rebuilt acts, or null (nothing to rebuild, or a bound unknown: the
// record left as it was, and said so in observed/).
export function rebuildRerunActs(ctx, row, name, { project, named = () => [] }) {
  const state = loadState(ctx);
  const done = state.steps?.[name];
  if (done?.status !== 'done' || readAttempts(ctx.runDir)[name]) return null;
  const reran = (state.reruns_applied ?? []).some((k) => k.slice(k.indexOf(':') + 1).split(',').map((s) => s.trim()).includes(name));
  if (!reran) return null;
  const last = readStarts(ctx.runDir)[name] ?? null;
  const list = [unkeptAttempts(ctx, name), { at: last, seq: null, ended_at: done.at, basis: "kept: the last attempt's start (step-starts.json) and its end (state.json)" }];
  if (!list.every((a) => a.at)) {
    observe(ctx, row, `acts_not_rebuilt_${name}`, { why: last ? list[0].basis : "unknown: the last attempt's start was not kept", record: 'left as it was' });
    return null;
  }
  const home = homeOfRun(ctx);
  const ranges = attemptRanges(home, list);
  const window = { ranges, since: ranges[0].at, earlier: ranges.slice(0, -1), unknown: [] };
  const acts = storeActs(home, project, ranges, named(window));
  const stamped = performers(ctx, acts, window.since).map((a) => ({ ...a, step: name, window: { ...windowNote(window), rebuilt_at: new Date().toISOString() } }));
  const before = readActs(ctx, row).filter((a) => a.step === name).map((a) => a.act);
  writeStepActs(ctx, row, name, stamped);
  const attempts = readAttempts(ctx.runDir);
  attempts[name] = list;
  writeAttempts(ctx.runDir, attempts);
  observe(ctx, row, `acts_rebuilt_${name}`, { finding: 'F3', before, after: stamped.map((a) => ({ act: a.act, items: a.items.length, performer: a.performer })), window: windowNote(window) });
  return stamped;
}

// Harness finding F6 (errata E168), a run directory whose record predates
// the re-read after the wait (`recordActs`): the step's acts were read once,
// when its goal was reached, so an owner decision answered while it waited
// for the entries is not in its record (M535's m6x_review: the second web
// review's confirmation and the four findings it filed). A step `done` whose
// attempts are kept with their ends (`ended_seq`), and whose attempts'
// ranges hold a decision answered by the `human` actor that its record
// lacks, has its acts rebuilt from the store (read only) over those ranges,
// with the performers from the entries made since its first attempt's start.
// The acts it named itself (an owner command observed by its effect, the
// preview inspection) are kept as recorded: the store does not hold them as
// acts. No performer is waited for: an act without an entry is `unknown`.
// Once rebuilt, nothing is lacking, so it is never rebuilt again. Returns
// the rebuilt acts, or null (nothing to rebuild).
export function rebuildUnrecordedActs(ctx, row, name, { project }) {
  const list = readAttempts(ctx.runDir)[name] ?? [];
  if (loadState(ctx).steps?.[name]?.status !== 'done' || list.length === 0 || list.some((a) => a.seq === null || a.seq === undefined) || list.at(-1).ended_seq === null || list.at(-1).ended_seq === undefined) return null;
  const home = homeOfRun(ctx);
  if (!existsSync(join(home, 'store.db'))) return null;
  const ranges = attemptRanges(home, list);
  if (ranges.some((r) => r.from === null || r.to === null)) return null;
  const recorded = readActs(ctx, row).filter((a) => a.step === name);
  const has = new Set(recorded.flatMap((a) => (a.items ?? []).map((i) => i.decision).filter(Boolean)));
  const named = recorded.flatMap((a) => (a.items ?? []).filter((i) => i.act !== undefined));
  const acts = storeActs(home, project, ranges, named);
  const missing = acts.flatMap((a) => a.items.filter((i) => i.decision && !has.has(i.decision)).map((i) => `${i.kind} ${i.decision}`));
  if (missing.length === 0) return null;
  const window = { ranges, since: ranges[0].at, earlier: ranges.slice(0, -1), unknown: [] };
  const stamped = performers(ctx, acts, window.since).map((a) => ({ ...a, step: name, window: { ...windowNote(window), rebuilt_at: new Date().toISOString(), finding: 'F6' } }));
  const summary = (a) => ({ act: a.act, items: a.items.length, performer: a.performer });
  writeStepActs(ctx, row, name, stamped);
  observe(ctx, row, `acts_rebuilt_${name}`, { finding: 'F6', missing, before: recorded.map(summary), after: stamped.map(summary), window: windowNote(window) });
  return stamped;
}

// A step's acts, their evidence waited for and recorded: Sean's central acts
// (M535) up to SURETY_REAL_WAIT_MINUTES, then the step fails naming each one
// not performed by him; every other act up to SURETY_REAL_ACT_RECORD_MINUTES,
// then recorded `unknown`, never assumed Sean's. The record covers every
// attempt of the step (`actWindow`; M519 F3): a rerun replaces the step's
// acts with those of all its attempts, never with its own alone; when it
// covers more than one attempt each act carries the `window`. `named` is
// the acts the step names, or a function of the window giving them.
//
// The store's acts are read again while waiting for the entries and once
// after the wait (harness finding F6, errata E168): an owner decision
// answered while the step waited (M535's second web review, confirmed by
// Sean, and the four findings it filed, accepted by the driver) is in the
// record, over the same window through the step's end, and the performers
// are derived after that last read. An act first seen while waiting is
// waited for as the others are; one first seen after the wait has no entry
// waited for (`unknown` without one).
export async function recordActs(ctx, row, name, { home, project, sinceSeq, since, named = [], central = [] }) {
  const window = actWindow(ctx, name, home, { sinceSeq, since });
  const read = () => storeActs(home, project, window.ranges, typeof named === 'function' ? named(window) : named);
  let acts = read();
  for (const c of central) if (!acts.some((a) => a.act === c)) throw new Error(`${name}: the owner act ${c} was not observed in the store (E156 Q6)`);
  const needed = (list) => list.filter((a) => a.performer === 'unknown');
  since = window.since;
  let rec = performers(ctx, acts, since);
  if (!ctx.rehearsal && needed(rec).length > 0) {
    tellSean(
      ctx,
      [
        `SURETY REAL LANE: who performed these owner acts of ${name}? (E156 Q6; README §3)`,
        ...needed(rec).map((a) => `  ${a.act}${central.includes(a.act) ? '   <- yours, Sean, in your own terminal' : ''}`),
        `Sean, in your terminal:  node docs/acceptance/reports/M6-real-lane/owner-act.mjs ${ctx.runDir} <act>`,
        `The driver, on your instruction:  node docs/acceptance/reports/M6-real-lane/driver-act.mjs ${ctx.runDir} <act> --instruction "<Sean's words>"`,
        `Waiting ${central.length > 0 ? `${ctx.waitMinutes} minutes for the central acts and ` : ''}${ACT_RECORD_MINUTES()} minutes for the others; an act with no record is reported unknown.`,
      ].join('\n'),
    );
    const startedWait = performance.now();
    const told = new Set(needed(rec).map((a) => a.act));
    for (;;) {
      acts = read();
      rec = performers(ctx, acts, since);
      const fresh = needed(rec).filter((a) => !told.has(a.act));
      if (fresh.length > 0) {
        for (const a of fresh) told.add(a.act);
        tellSean(ctx, [`SURETY REAL LANE: owner acts of ${name} answered while waiting; who performed them? (README §3)`, ...fresh.map((a) => `  ${a.act}${central.includes(a.act) ? '   <- yours, Sean, in your own terminal' : ''}`)].join('\n'));
      }
      const missingCentral = rec.filter((a) => central.includes(a.act) && a.performer !== 'sean');
      const missingOther = needed(rec).filter((a) => !central.includes(a.act));
      const waited = (performance.now() - startedWait) / 60_000;
      if (missingCentral.length === 0 && (missingOther.length === 0 || waited >= ACT_RECORD_MINUTES())) break;
      if (missingCentral.length > 0 && waited >= ctx.waitMinutes) break;
      await sleep(10_000);
    }
  }
  // F6 (errata E168): the decisions answered while waiting, read through the step's end; the performers after it.
  acts = read();
  rec = performers(ctx, acts, since);
  const stamped = rec.map((a) => ({ ...a, step: name, ...(window.earlier.length > 0 || window.unknown.length > 0 ? { window: windowNote(window) } : {}) }));
  writeStepActs(ctx, row, name, stamped);
  if (!ctx.rehearsal) {
    const notSean = stamped.filter((a) => central.includes(a.act) && a.performer !== 'sean');
    if (notSean.length > 0) throw new Error(`${name} not passed: ${notSean.map((a) => `${a.act} (performer ${a.performer})`).join(', ')}: Sean performs it himself and records it with owner-act.mjs (E156 Q6); the store's human actor alone does not establish it`);
  }
  return stamped;
}

// ---- Sean's sessions (and the rehearsal's) ----------------------------------------------------

// A session the owner drives from the printed CLI lines; under the rehearsal
// the harness types the rehearsal's owner words itself. `mode: 'review'`
// opens it through the owner's route (POST …/sessions {role, mode}).
async function ownerSession(ctx, fx, project, role, { words, mode = null, what, expect, answer, extra, done, stall = false }) {
  if (ctx.rehearsal) {
    let run;
    if (mode) {
      const res = await fx.engine.post(`/v1/projects/${project}/sessions`, { role, mode });
      if (res.status !== 201 && res.status !== 200) notEstablished(what, `the ${role} session (${mode}) did not open`, { status: res.status, text: res.text });
      run = res.body.run?.id ?? res.body.id;
    } else {
      const opened = seanTypes(ctx, fx.home, ['session', 'open', '--project', project, '--role', role], `open the ${role} session`);
      run = JSON.parse(opened.stdout).run?.id;
    }
    mkdirSync(join(ctx.runDir, 'rehearsal'), { recursive: true });
    for (const [i, w] of words.entries()) {
      const file = join(ctx.runDir, 'rehearsal', `${role}-${run}-${i + 1}.md`);
      writeFileSync(file, w);
      seanTypes(ctx, fx.home, ['session', 'say', run, '--project', project, '--file', file, '--wait-minutes', String(ctx.waitMinutes)], `say to the ${role}`);
      seanTypes(ctx, fx.home, ['session', 'save', run, '--project', project], `save the ${role}'s work`);
    }
    seanTypes(ctx, fx.home, ['session', 'close', run, '--project', project], `close the ${role} session`);
  } else {
    tellSean(
      ctx,
      [
        `SURETY REAL LANE: your ${role} session${mode ? ` in ${mode} mode` : ''} (${what}). In another terminal, as often as you like (the test waits for its end):`,
        mode ? `  open: ${curlBody(fx, `/v1/projects/${project}/sessions`, { role, mode })}` : `  ${cliLine(fx.home, ['session', 'open', '--project', project, '--role', role])}`,
        `  ${cliLine(fx.home, ['session', 'say', '<run>', '--project', project, '--text', '<what you say>'])}`,
        `  ${cliLine(fx.home, ['session', 'show', '<run>', '--project', project])}`,
        `  ${cliLine(fx.home, ['session', 'save', '<run>', '--project', project])}`,
        `  ${cliLine(fx.home, ['session', 'close', '<run>', '--project', project])}`,
        'Closing raises the decision your product calls for; the test then prints it for your answer.',
      ].join('\n'),
    );
  }
  return driveM6(ctx, fx, project, done, { expect, answer, extra, what, timeoutMs: ctx.waitMinutes * 60_000, stall });
}

// ---- the steps --------------------------------------------------------------------------------

// The brief a paid run's project is made from (BS6 §12): M519 V1's visual
// brief, M535 the purpose-written one; a rehearsal's is its content's.
export function briefOf(ctx, row) {
  if (ctx.rehearsal) return { text: rehearsalIdea(row), from: 'the rehearsal (harness/real/m6-content.mjs)' };
  const path = row === 'M519' ? process.env.SURETY_M519_BRIEF ?? join(homedir(), 'surety-m5-physics-idea-visual.md') : process.env.SURETY_M535_BRIEF ?? join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M6-real-lane', 'm535-brief.md');
  if (!existsSync(path)) notEstablished(stepName(row, 'create'), `the brief ${path} does not exist`);
  return { text: readFileSync(path, 'utf8'), from: path };
}

const registered = (fx, project) => pollUntil(() => one(fx.home, `SELECT "id" FROM "projects" WHERE "id" = ? AND "registration_state" = 'registered'`, project), { timeoutMs: 120_000, everyMs: 1_000, what: `project ${project} to be registered` });

export async function m6Attempt(ctx, row) {
  return step(ctx, 'm6_attempt', () => m5Attempts(ctx, row));
}
export async function m6Activation(ctx, row) {
  return step(ctx, 'm6_activation', async () => m5Activation(ctx, row, ctx.rehearsal ? await m6Content(row) : null));
}

export async function m6Create(ctx, row) {
  const name = stepName(row, 'create');
  const projects = [];
  return m6Step(ctx, name, ({ startedAt }) =>
    onEngine(ctx, `${row} ${name}`, { projects }, async (fx) => {
      // The owner's acts of this step (the policy widening he confirms) recorded as every step's are (rule 26).
      const sinceSeq = maxSeq(fx.home);
      const brief = briefOf(ctx, row);
      const { slug, name: title } = ideaName(brief.text);
      const projectName = `m6-${row.toLowerCase()}-${slug}`;
      const repo = join(ctx.runDir, 'repos', `${row.toLowerCase()}-${slug}`);
      if (!existsSync(join(repo, '.git'))) {
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        writeFileSync(join(repo, 'README.md'), `# ${title}\n`);
        execFileSync('git', ['-C', repo, 'add', '-A']);
        execFileSync('git', ['-C', repo, '-c', 'user.name=Sean', '-c', 'user.email=sean@example.invalid', 'commit', '-q', '-m', 'the repository the project starts from']);
        execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
      }
      const res = await fx.engine.post('/v1/projects', { name: projectName, tier: 'T2', dev_repo_path: repo, integration_branch: 'main', idea: brief.text });
      if (res.status !== 201) notEstablished(name, 'the project was not created', { status: res.status, text: res.text });
      const project = res.body.project?.id ?? res.body.id;
      projects.push(project);
      await registered(fx, project);
      const policy = await projectPolicy(ctx, row, fx, project, {
        dayUsd: row === 'M519' ? M6_BUDGET.M519_day_usd : M6_BUDGET.M535_day_usd,
        phase_size: { min: 1, max: 5 },
        ...ROLE_MODELS_M6,
        backend_designer: 'claude',
        design: 'both',
        autonomy: 'phase',
        designer_session_budget_billable_tokens: M6_BUDGET.designer_session_budget_billable_tokens,
        widen: { alpha_deploy: 'on_phase_complete' },
      });
      const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt });
      const out = { project, name: projectName, repo, brief_from: brief.from, policy, acts };
      observe(ctx, row, 'create', out);
      return out;
    }),
  );
}

const projectOf = (ctx, row) => stepValue(ctx, stepName(row, 'create')).project;

export async function m6Spec(ctx, row) {
  const name = stepName(row, 'spec');
  const project = projectOf(ctx, row);
  return m6Step(ctx, name, ({ startedAt }) =>
    onEngine(ctx, `${row} ${name}`, { projects: [project], resume: project }, async (fx) => {
      const sinceSeq = maxSeq(fx.home);
      const targets = row === 'M519' ? '**Targets:** web' : '**Targets:** web, android and **Cross-platform:** yes';
      const s = await ownerSession(ctx, fx, project, 'spec_writer', {
        what: `the specification, with ${targets} in its header`,
        words: [ownerSays(`Write the specification from the accepted idea, at the standard tier, one phase, with ${targets}.`, 'rehearsal-owner', pantryBrief(row))],
        expect: ['spec_approval'],
        done: () => specVersions(fx.home, project)[0],
      });
      const r25 = ruleTwentyFive(fx.home, project, name, { handover: HANDOVER.spec });
      const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt });
      const out = { ...s, spec: specVersions(fx.home, project), rule_25: r25, acts };
      observe(ctx, row, 'spec', out);
      return out;
    }),
  );
}

export async function m6Architecture(ctx, row) {
  const name = stepName(row, 'architecture');
  const project = projectOf(ctx, row);
  return m6Step(ctx, name, ({ startedAt }) =>
    onEngine(ctx, `${row} ${name}`, { projects: [project], resume: project }, async (fx) => {
      const sinceSeq = maxSeq(fx.home);
      const alpha = await alphaOnce(ctx, row, fx, project);
      const s = await ownerSession(ctx, fx, project, 'architect', {
        what: 'the architecture (surfaces, targets, technologies, interface shapes) and the first plan',
        words: [ownerSays('Design it from the approved specification and plan phase 1.', 'rehearsal-architecture', pantryArchitecture(row))],
        expect: ['architecture_approval', 'plan_approval'],
        done: () => {
          const p = activePlanOf(fx.home, project, 1);
          return p?.published_at ? p : undefined;
        },
      });
      // The UI stage's hold raises design_due; the phase's authoring may ask for its toolchain: the next steps' questions.
      const r25 = ruleTwentyFive(fx.home, project, name, { handover: HANDOVER.architecture });
      const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt });
      const out = { ...s, value: { id: s.value.id, generation: s.value.generation }, setup: alpha, rule_25: r25, acts };
      observe(ctx, row, 'architecture', out);
      return out;
    }),
  );
}

// M5's qualification step (Sean's `surety qualify-adapter local_service`),
// its owner act then recorded with its performer (the engine stopped: the
// store read directly).
export async function m6Qualify(ctx, row) {
  const name = stepName(row, 'qualify');
  const project = projectOf(ctx, row);
  const value = await qualifyStep(ctx, row, name, project);
  if (!readActs(ctx, row).some((a) => a.step === name)) {
    const home = homeOfRun(ctx);
    // One qualification per run: an entry for it any time since the run directory began counts.
    await recordActs(ctx, row, name, { home, project, sinceSeq: maxSeq(home), since: '', named: [{ act: 'qualify_adapter', route: 'surety qualify-adapter local_service', store_actor: "the owner's CLI", answered_at: loadState(ctx).steps?.[name]?.at ?? null, qualification: value?.row ?? null }] });
  }
  return value;
}

// The design rows' reads.
export const designRevisionsOf = (home, project) => rows(home, 'SELECT * FROM "design_revisions" WHERE "project" = ? ORDER BY rowid', project).map((r) => ({ ...r, selection: json(r.selection), targets: json(r.targets), assets_held: json(r.assets_held) }));
export const previewsOf = (home, project) => rows(home, 'SELECT * FROM "design_previews" WHERE "project" = ? ORDER BY rowid', project).map((p) => ({ ...p, mockups: json(p.mockups) }));
const previewEnv = (home, project) => one(home, `SELECT "id" FROM "environments" WHERE "project" = ? AND "name" = 'design-preview'`, project)?.id ?? null;
export const relayEvents = (home, project, sinceSeq = 0) => {
  const env = previewEnv(home, project);
  if (!env) return [];
  return rows(home, `SELECT "seq", "at", "type", "subject", "payload" FROM "events" WHERE "type" IN ('environment.relay_opened', 'environment.relay_closed') AND "seq" > ? ORDER BY "seq"`, sinceSeq)
    .map((e) => ({ ...e, subject: json(e.subject), payload: json(e.payload) }))
    .filter((e) => e.subject?.environment === env);
};
export const effectiveOf = (home, project) => rows(home, 'SELECT * FROM "design_effective_assets" WHERE "project" = ? ORDER BY "slot", "variant"', project);
export const bindingsOf = (home, project) => rows(home, 'SELECT * FROM "asset_bindings" WHERE "project" = ? ORDER BY rowid', project);
export const readyRevision = (home, project) => designRevisionsOf(home, project).filter((r) => ['approved', 'approved_without_criteria'].includes(r.status) && r.ready_at).at(-1) ?? null;
const RELAY_UNRECORDED = Object.freeze({ unknown: 'neither the operator relay (src/deploy/service-host.ts) nor the preview server (src/design/preview/server.mts) records the requests it serves; the relay\'s openings and closings are the events below' });

// The preview inspection as the design step names it (rule 26): the
// previews, and the relay's openings and closings for `design-preview` in
// the act record's ranges (every attempt of the step, M519 F3).
export function inspectionAct(home, project, ranges) {
  const relay = relayEvents(home, project, Math.min(...ranges.map((r) => r.from))).filter((e) => inRanges(ranges, e.seq));
  return { act: 'preview_inspection', previews: previewsOf(home, project).map((p) => ({ generation: p.generation, unit: p.unit, status: p.status, deployed_at: p.deployed_at, torn_down_at: p.torn_down_at })), relay, relay_requests: RELAY_UNRECORDED, route: `POST /v1/projects/${project}/design/preview; POST /v1/projects/${project}/environments/design-preview/relay`, store_actor: "the owner's routes", answered_at: relay.find((e) => e.type === 'environment.relay_opened')?.at ?? null };
}

// GET over loopback, bytes as bytes (the rehearsal's read of the relay; rule 21: nothing rendered).
function getBytes(url, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length }));
      res.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
  });
}

// The preview inspection: Sean's preview command, his relay and his own
// browser (rule 22: never the test's); under the rehearsal the harness
// previews, opens the relay, reads the index's bytes and closes it.
async function previewInspection(ctx, fx, project, row) {
  const commands = [
    ['design', 'preview', '--project', project, '--revision', 'checkpoint'],
    ['env', 'open', 'design-preview', '--project', project],
  ];
  if (ctx.rehearsal) {
    const preview = seanTypes(ctx, fx.home, commands[0], 'the preview of the Designer\'s checkpoint');
    const url = json(preview.stdout)?.preview?.url ?? null;
    await pollUntil(() => previewsOf(fx.home, project).find((p) => p.status === 'deployed'), { timeoutMs: 15 * 60_000, everyMs: 3_000, what: 'the preview deployed' });
    seanTypes(ctx, fx.home, commands[1], 'the relay to the preview, on 127.0.0.1');
    const read = url ? await getBytes(url) : { status: null, error: 'no url' };
    seanTypes(ctx, fx.home, ['env', 'close', 'design-preview', '--project', project], 'the relay closed');
    return { by: 'rehearsal', url, index: read };
  }
  tellSean(
    ctx,
    [
      `SURETY REAL LANE: your preview inspection (${row}; E156 Q6). In another terminal:`,
      ...commands.map((c) => `  ${cliLine(fx.home, c)}`),
      '  then open the printed 127.0.0.1 address in your own browser: the web mockup, and every android mockup inside its labelled simulation frame;',
      `  ${cliLine(fx.home, ['env', 'close', 'design-preview', '--project', project])}`,
      `and record it in your words:  node docs/acceptance/reports/M6-real-lane/owner-act.mjs ${ctx.runDir} preview_inspection`,
    ].join('\n'),
  );
  return { by: 'printed for Sean' };
}

// The runner's own read of the approved design's preview (M535 (b); BS6
// §4.1 rules 21, 23, 24): not an owner act and never Sean's inspection. It
// previews the approved revision in its own home, opens its own relay on
// 127.0.0.1, reads each mockup's served bytes over HTTP (as bytes: the web
// mockup bare, a simulated one answered with the engine's frame), closes
// the relay, stops the preview, and exports the tree with SIMULATIONS.txt.
const runCli = (fx, args) => {
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 600_000, env: { ...process.env, SURETY_HOME: fx.home } });
  return { status: done.status, stdout: (done.stdout ?? '').slice(0, 8000), stderr: (done.stderr ?? '').slice(0, 4000) };
};
function getText(url, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? null, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
  });
}
export async function previewReadback(ctx, fx, project, row) {
  tellSean(ctx, `SURETY REAL LANE: the runner's own read of the approved design's preview (${row} (b); not an owner act): preview, relay on 127.0.0.1, bytes read, relay closed, preview stopped, the tree exported.`);
  const before = new Set(previewsOf(fx.home, project).map((p) => p.id));
  const out = { preview: runCli(fx, ['design', 'preview', '--project', project, '--revision', 'approved']) };
  let url = null;
  try {
    url = JSON.parse(out.preview.stdout)?.preview?.url ?? null;
  } catch {
    url = null;
  }
  out.url = url;
  try {
    const p = await pollUntil(async () => {
      await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
      return previewsOf(fx.home, project).find((x) => !before.has(x.id) && x.status === 'deployed');
    }, { timeoutMs: 15 * 60_000, everyMs: 3_000, what: "the runner's preview of the approved design deployed" });
    out.relay_open = runCli(fx, ['env', 'open', 'design-preview', '--project', project]);
    out.mockups = [];
    for (const m of p.mockups ?? []) {
      const got = url ? await getText(new URL(m.path, url).href) : { status: null, error: 'no url' };
      out.mockups.push({ path: m.path, target: m.target, preview_capability: m.preview_capability, status: got.status, type: got.type, framed: /Simulation of /.test(got.text ?? ''), sandbox: /<iframe[^>]*sandbox="allow-scripts"/.test(got.text ?? ''), bytes: (got.text ?? '').length, error: got.error ?? null });
    }
  } finally {
    out.relay_close = runCli(fx, ['env', 'close', 'design-preview', '--project', project]);
    out.stop = runCli(fx, ['design', 'preview', '--stop', '--project', project]);
    await pollUntil(async () => {
      await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
      return previewsOf(fx.home, project).every((x) => !['deployed', 'deploying'].includes(x.status)) ? true : undefined;
    }, { timeoutMs: 600_000, everyMs: 3_000, what: "the runner's preview torn down" }).catch((err) => {
      out.stop_wait = String(err?.message ?? err);
    });
    const dir = join(ctx.runDir, `export-${row}`);
    if (!existsSync(dir)) {
      out.export = runCli(fx, ['design', 'export', '--project', project, '--revision', 'approved', dir]);
      const sims = join(dir, 'SIMULATIONS.txt');
      out.simulations = existsSync(sims) ? readFileSync(sims, 'utf8') : null;
    } else out.export = { already: dir };
  }
  observe(ctx, row, 'preview_readback', out);
  return out;
}

// The design step (D7 §1 step 5): design_due answered, the Designer
// session (Sean's feedback turns), the preview inspected through the relay,
// the batched approval (M535: the logo held), the design criteria's checks
// applied, `design_ready`; the preview torn down by the approval.
export async function m6Design(ctx, row) {
  const name = stepName(row, 'design');
  const project = projectOf(ctx, row);
  const central = row === 'M535' ? ['designer_feedback', 'preview_inspection', 'combined_approval'] : [];
  const value = await m6Step(ctx, name, ({ startedAt }) =>
    onEngine(ctx, `${row} ${name}`, { projects: [project], resume: project }, async (fx) => {
      const sinceSeq = maxSeq(fx.home);
      let inspection = null;
      const extra = (d) => (row === 'M535' && d.kind === 'design_approval' ? { assets_held: ['logo'] } : {});
      // Under the rehearsal the harness opens the Designer session itself: design_due is left to the engine (driveM6).
      const answer = (d) => (d.kind === 'design_due' ? (ctx.rehearsal ? null : 'open') : 'approve');
      const expect = ['design_due', 'design_approval', 'spec_change', ...CORRECTIONS, 'plan_approval'];
      // The session; the rehearsal previews between the Designer's last save and the close.
      const s = await (async () => {
        if (ctx.rehearsal) {
          const opened = seanTypes(ctx, fx.home, ['session', 'open', '--project', project, '--role', 'designer'], 'open the Designer session');
          const run = JSON.parse(opened.stdout).run?.id;
          mkdirSync(join(ctx.runDir, 'rehearsal'), { recursive: true });
          for (const [i, w] of DESIGNER_WORDS.entries()) {
            const file = join(ctx.runDir, 'rehearsal', `designer-${run}-${i + 1}.md`);
            writeFileSync(file, w);
            seanTypes(ctx, fx.home, ['session', 'say', run, '--project', project, '--file', file, '--wait-minutes', String(ctx.waitMinutes)], 'say to the Designer');
            seanTypes(ctx, fx.home, ['session', 'save', run, '--project', project], "save the Designer's work");
            if (i === 0) inspection = await previewInspection(ctx, fx, project, row);
          }
          seanTypes(ctx, fx.home, ['session', 'close', run, '--project', project], 'close the Designer session');
        } else {
          tellSean(
            ctx,
            [
              `SURETY REAL LANE: the design (${row}). design_due names the held UI stage${row === 'M535' ? 's' : ''}; answer it \`open\` (printed below), then your Designer session, in another terminal:`,
              `  ${cliLine(fx.home, ['session', 'open', '--project', project, '--role', 'designer'])}`,
              `  ${cliLine(fx.home, ['session', 'say', '<run>', '--project', project, '--text', '<your feedback>'])}`,
              `  ${cliLine(fx.home, ['session', 'save', '<run>', '--project', project])}`,
              `  ${cliLine(fx.home, ['session', 'close', '<run>', '--project', project])}`,
              `Between a save and the close, inspect the preview (printed next). ${row === 'M535' ? 'At the combined approval, hold the logo: the curl line below carries "assets_held": ["logo"].' : ''}`,
              row === 'M535' ? `Record each of your acts in your own words: owner-act.mjs ${ctx.runDir} designer_feedback | preview_inspection | combined_approval` : '',
            ].join('\n'),
          );
          inspection = await previewInspection(ctx, fx, project, row);
        }
        return driveM6(ctx, fx, project, () => {
          const ready = readyRevision(fx.home, project);
          const previews = previewsOf(fx.home, project);
          const opened = relayEvents(fx.home, project, sinceSeq).some((e) => e.type === 'environment.relay_opened');
          return ready && previews.length > 0 && previews.every((p) => ['torn_down', 'failed'].includes(p.status)) && opened ? ready : undefined;
        }, { expect, answer, extra, what: 'the design approved, its criteria\'s checks applied (design_ready), the preview inspected through the relay and torn down', timeoutMs: ctx.waitMinutes * 60_000 });
      })();
      const relay = relayEvents(fx.home, project, sinceSeq);
      const r25 = ruleTwentyFive(fx.home, project, name, { handover: HANDOVER.design });
      const readback = row === 'M535' ? await previewReadback(ctx, fx, project, row) : null;
      const acts = await recordActs(ctx, row, name, {
        home: fx.home,
        project,
        sinceSeq,
        since: startedAt,
        central,
        // The inspection's relay events over every attempt of the step (M519 F3), not this attempt's alone.
        named: (w) => [inspectionAct(fx.home, project, w.ranges)],
      });
      const ready = s.value;
      const out = {
        ready: { id: ready.id, version: ready.version, ready_at: ready.ready_at, assets_held: ready.assets_held, selection: ready.selection },
        revisions: designRevisionsOf(fx.home, project).map((r) => ({ id: r.id, version: r.version, scope: r.scope, status: r.status, ready_at: r.ready_at, batch_key: r.batch_key, design_check: r.design_check })),
        checks: rows(fx.home, 'SELECT "id", "outcome", "reasons" FROM "design_checks" WHERE "id" IN (SELECT "design_check" FROM "design_revisions" WHERE "project" = ?)', project).map((c) => ({ ...c, reasons: json(c.reasons) })),
        previews: previewsOf(fx.home, project),
        effective: effectiveOf(fx.home, project).map((e) => ({ slot: e.slot, variant: e.variant, slot_version: e.slot_version, source: e.source, digest: e.digest })),
        held: rows(fx.home, `SELECT a."slot", a."slot_version", a."variants" FROM "design_assets" a JOIN "design_revisions" r ON r."id" = a."design_revision" WHERE r."project" = ? AND a."held" = 1`, project).map((a) => ({ ...a, variants: json(a.variants) })),
        inspection,
        readback,
        relay,
        designer_runs: sessionRuns(fx.home, project, 'designer').map((r) => ({ id: r.id, outcome: r.outcome, model_requested: r.model_requested })),
        shown: s.shown,
        rule_25: r25,
        acts,
      };
      observe(ctx, row, 'design', out);
      return out;
    }),
  );
  // A run directory from before the attempts were kept (M519 F3): the record rebuilt once over every attempt.
  rebuildRerunActs(ctx, row, name, { project, named: (w) => [inspectionAct(homeOfRun(ctx), project, w.ranges)] });
  return value;
}

// ---- the build, the asset change (M535), Alpha and the review, in one engine ------------------

const phasePlan = (home, project) => activePlanOf(home, project, 1);
const uiStages = (home, project) => {
  const plan = phasePlan(home, project);
  return plan ? rows(home, `SELECT s.* FROM "stages" s WHERE s."phase_plan" = ? AND s."status" <> 'cancelled' AND EXISTS (SELECT 1 FROM "stage_screens" ss WHERE ss."stage" = s."id")`, plan.id) : [];
};
const passed = (r) => r.exit_status === 0 && r.execution_established === 1 && r.signaled === 0 && r.deadline_hit === 0 && !r.invalidated_at;

async function buildStep(ctx, row, fx, project) {
  const name = stepName(row, 'build');
  return m6Step(ctx, name, async ({ startedAt }) => {
    const sinceSeq = maxSeq(fx.home);
    // M519: the phase built and complete. M535: the UI stages integrated
    // with their bindings recorded, before the held logo's approval.
    const done = () => {
      if (row === 'M519') return phasePlan(fx.home, project)?.completed_at ? true : undefined;
      const ui = uiStages(fx.home, project);
      const bound = new Set(bindingsOf(fx.home, project).map((b) => b.stage));
      return ui.length >= 2 && ui.every((s) => bound.has(s.id)) ? true : undefined;
    };
    const d = await driveM6(ctx, fx, project, done, { expect: [...CORRECTIONS, 'plan_approval', 'finding_disposition'], what: row === 'M519' ? 'phase 1 built, verified and complete' : 'the UI stages built with the placeholder logo and their bindings recorded', stall: true, timeoutMs: 6 * HOURS });
    const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt });
    const carried = rows(fx.home, `SELECT c.* FROM "design_package_carried" c JOIN "runs" r ON r."id" = c."run" WHERE r."project" = ?`, project).map((c) => ({ run: c.run, effective: json(c.effective) }));
    const out = {
      stages: stagesOf(fx.home, project).map((s) => ({ id: s.id, number: s.number, status: s.status })),
      holds: rows(fx.home, `SELECT "id", "kind", "held_intervals" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build'`, project).map((w) => ({ id: w.id, held_intervals: json(w.held_intervals) })),
      carried,
      bindings: bindingsOf(fx.home, project).map((b) => ({ stage: b.stage, target: b.target, slot: b.slot, variant: b.variant, path: b.path, form: b.form, source_slot_version: b.source_slot_version })),
      executions: rows(fx.home, `SELECT "id", "key", "asset_inputs", "status" FROM "check_executions" WHERE "project" = ? AND "asset_inputs" IS NOT NULL`, project).map((e) => ({ ...e, asset_inputs: json(e.asset_inputs) })),
      shown: d.shown,
      acts,
    };
    observe(ctx, row, 'build', out);
    return out;
  });
}

// M535 (e), (f): the held logo approved by an asset-only approval (Sean's
// `surety design assets submit`, or his own file by `surety design asset
// add` first), `asset_updated` work from the bindings, its integration,
// `asset_version_changed` obligations, parity passing on the new version.
async function assetStep(ctx, row, fx, project) {
  const name = stepName(row, 'asset');
  return m6Step(ctx, name, async ({ startedAt }) => {
    const sinceSeq = maxSeq(fx.home);
    const before = effectiveOf(fx.home, project).find((e) => e.slot === 'logo' && e.variant === 'full');
    let cli = null;
    if (ctx.rehearsal) {
      const file = join(ctx.runDir, 'rehearsal', 'owner-logo.svg');
      mkdirSync(join(ctx.runDir, 'rehearsal'), { recursive: true });
      writeFileSync(file, OWNER_LOGO_SVG);
      cli = { add: seanTypes(ctx, fx.home, ['design', 'asset', 'add', '--project', project, 'logo', 'full', file], 'the owner\'s own logo for the held slot'), submit: seanTypes(ctx, fx.home, ['design', 'assets', 'submit', '--project', project], 'the asset-only approval raised') };
    } else {
      tellSean(
        ctx,
        [
          'SURETY REAL LANE: the held logo (M535 (e)). Either approve the Designer\'s proposal, or supply your own file first. In another terminal:',
          `  (your own file, optional)  ${cliLine(fx.home, ['design', 'asset', 'add', '--project', project, 'logo', 'full', '<your file.svg>'])}`,
          `  ${cliLine(fx.home, ['design', 'assets', 'submit', '--project', project])}`,
          'then answer the asset-only design_approval printed below (approve, nothing held).',
        ].join('\n'),
      );
    }
    const done = () => {
      const eff = effectiveOf(fx.home, project).find((e) => e.slot === 'logo' && e.variant === 'full');
      if (!eff || eff.source !== 'approved' || (before && eff.slot_version <= before.slot_version)) return undefined;
      const fixes = rows(fx.home, `SELECT "id", "status", "subject" FROM "work_items" WHERE "project" = ? AND "kind" = 'fix'`, project).map((w) => ({ ...w, subject: json(w.subject) })).filter((w) => w.subject?.cause === 'asset_updated');
      if (fixes.length === 0 || fixes.some((w) => w.status !== 'complete')) return undefined;
      const obligations = rows(fx.home, `SELECT * FROM "check_obligations" WHERE "project" = ? AND "reason" = 'asset_version_changed'`, project);
      if (obligations.length === 0 || obligations.some((o) => !o.resolved_at)) return undefined;
      const parity = rows(fx.home, `SELECT r.*, c."key" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND r."asset_inputs" IS NOT NULL`, project).map((r) => ({ ...r, asset_inputs: json(r.asset_inputs) }));
      const onNew = parity.filter((r) => (r.asset_inputs ?? []).some((a) => a.slot === 'logo' && a.slot_version === eff.slot_version));
      return onNew.length > 0 && onNew.every(passed) ? { eff, fixes, obligations, parity: onNew } : undefined;
    };
    const d = await driveM6(ctx, fx, project, done, { expect: ['design_approval', ...CORRECTIONS, 'finding_disposition'], what: "the held logo approved; asset_updated integrated; asset_version_changed obligations; parity passing on the new slot@version", stall: true, timeoutMs: 6 * HOURS });
    // The owner's asset commands, observed by their effects (D7 A.8): `asset add` by design.asset_added, `assets submit` by its asset-only revision.
    const added = rows(fx.home, `SELECT "seq", "at", "subject", "payload" FROM "events" WHERE "type" = 'design.asset_added' AND "seq" > ? ORDER BY "seq"`, sinceSeq).filter((e) => json(e.subject)?.project === project);
    const submitted = designRevisionsOf(fx.home, project).filter((r) => r.scope === 'asset_only');
    const named = [
      ...(added.length > 0 ? [{ act: 'asset_add', route: `POST /v1/projects/${project}/design/assets (surety design asset add)`, store_actor: "the owner's CLI", answered_at: added.at(-1).at, events: added.map((e) => ({ seq: e.seq, payload: json(e.payload) })) }] : []),
      ...(submitted.length > 0 ? [{ act: 'asset_submit', route: `POST /v1/projects/${project}/design/assets/submit (surety design assets submit)`, store_actor: "the owner's CLI", answered_at: submitted.at(-1).created_at, revisions: submitted.map((r) => r.id) }] : []),
    ];
    const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt, named });
    const v = d.value;
    const out = {
      cli,
      before: before ? { slot_version: before.slot_version, source: before.source, digest: before.digest } : null,
      after: { slot_version: v.eff.slot_version, source: v.eff.source, digest: v.eff.digest },
      fixes: v.fixes.map((w) => ({ id: w.id, status: w.status, subject: w.subject })),
      obligations: v.obligations.map((o) => ({ id: o.id, key: o.key, resolved_at: o.resolved_at })),
      parity: v.parity.map((r) => ({ id: r.id, key: r.key, asset_inputs: r.asset_inputs, exit_status: r.exit_status, execution: r.execution_seq })),
      revisions: designRevisionsOf(fx.home, project).map((r) => ({ id: r.id, scope: r.scope, status: r.status })),
      acts,
    };
    observe(ctx, row, 'asset', out);
    return out;
  });
}

// Exported for the kernel lane's case of its end (M512 (k), F29).
export async function alphaStep(ctx, row, fx, project) {
  const name = stepName(row, 'alpha');
  return m6Step(ctx, name, async ({ startedAt }) => {
    const sinceSeq = maxSeq(fx.home);
    const d = await driveM6(ctx, fx, project, () => {
      const c = candidatesOf(fx.home, project).filter((x) => x.progress === 'alpha_deployed').at(-1);
      const due = openDecisions(fx.home, project).find((x) => x.kind === 'design_due');
      return c && due ? c : undefined;
    }, { expect: [...CORRECTIONS, 'plan_approval', 'finding_disposition'], what: 'phase 1 complete, Alpha requested under policy, deployed and verified (alpha_deployed); design_due (alpha_review) raised', stall: true, timeoutMs: 4 * HOURS });
    // Judged even when the step's condition held at its first poll (Alpha deployed before it started): an open
    // finding_disposition is carried to the review, recorded and printed, never dropped or answered (F29; SEAM.md §559).
    const review = stepName(row, 'review');
    const r25 = ruleTwentyFive(fx.home, project, name, { handover: HANDOVER.alpha, to: review });
    const carried = r25.handed_over.filter((h) => h.kind !== 'design_due');
    if (carried.length > 0) {
      tellSean(
        ctx,
        [
          `SURETY REAL LANE: ${name} ends with owner questions open, handed to ${review} (BS6 §4.1 rule 25; SEAM.md §559). None is answered, resolved or verified by the handover; ${review} presents each and does not end until each is answered:`,
          ...carried.map((h) => `  ${describeHanded(h)}`),
        ].join('\n'),
      );
    }
    const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt });
    const out = {
      candidate: { id: d.value.id, progress: d.value.progress },
      requests: deploymentRequestsOf(fx.home, project).map((r) => ({ id: r.id, requested_by: r.requested_by, status: r.status })),
      alpha_authorize: evaluationsOf(fx.home, project, 'alpha_authorize').at(-1) ?? null,
      alpha_complete: evaluationsOf(fx.home, project, 'alpha_complete').at(-1) ?? null,
      host: hostWhileRunning(ctx),
      rule_25: r25,
      acts,
    };
    observe(ctx, row, 'alpha', out);
    return out;
  });
}

// The review at Alpha (D7 §10): design_due answered, the review-mode
// Designer session (Sean browses the Alpha through `surety env open alpha`
// and types what he sees), its close, design_verdicts confirmed by Sean.
// Exported for the kernel lane's case of its end (M512 (k), F29).
export async function reviewStep(ctx, row, fx, project) {
  const name = stepName(row, 'review');
  const central = row === 'M535' ? ['review_confirmation'] : [];
  return m6Step(ctx, name, async ({ startedAt }) => {
    const sinceSeq = maxSeq(fx.home);
    // The questions carried in (the Alpha step's handover, F29): this review does not end while one is open (rule 25).
    const carriedIn = openDecisions(fx.home, project).filter((d) => d.kind !== 'design_due').map(handedEntry(fx.home, stepName(row, 'alpha'), name));
    if (!ctx.rehearsal && carriedIn.length > 0) tellSean(ctx, [`SURETY REAL LANE: open owner questions carried into the review (${row}); it does not end until each is answered (BS6 §4.1 rule 25; SEAM.md §559). Each is printed again with its answer lines below:`, ...carriedIn.map((h) => `  ${describeHanded(h)}`)].join('\n'));
    if (!ctx.rehearsal) tellSean(ctx, [`SURETY REAL LANE: the review at Alpha (${row}). Browse the Alpha yourself through the relay:`, `  ${cliLine(fx.home, ['env', 'open', 'alpha', '--project', project])}`, `  ${cliLine(fx.home, ['env', 'close', 'alpha', '--project', project])}`, `Answer design_due \`open\`, then the review-mode session (printed next); confirm, edit or strike the verdicts at design_verdicts.${row === 'M535' ? ` Record your confirmation: owner-act.mjs ${ctx.runDir} review_confirmation` : ''}`].join('\n'));
    // Under the rehearsal the harness opens and closes the owner's relay to Alpha itself (rule 24), reading nothing through it.
    const relay = ctx.rehearsal ? { open: seanTypes(ctx, fx.home, ['env', 'open', 'alpha', '--project', project], 'the relay to Alpha, on 127.0.0.1'), close: seanTypes(ctx, fx.home, ['env', 'close', 'alpha', '--project', project], 'the relay to Alpha closed') } : null;
    const reviewsBefore = new Set(rows(fx.home, 'SELECT "id" FROM "design_reviews" WHERE "project" = ?', project).map((r) => r.id));
    const ended = reviewEndJudge(name);
    const s = await ownerSession(ctx, fx, project, 'designer', {
      mode: 'review',
      words: [...REVIEW_WORDS],
      what: 'the review of the web Alpha (android not observed: no native runtime)',
      expect: ['design_due', 'design_verdicts', 'finding_disposition', 'design_approval', 'spec_change', ...CORRECTIONS, 'plan_approval'],
      answer: (d) => (d.kind === 'design_due' ? (ctx.rehearsal ? null : 'open') : d.kind === 'design_verdicts' ? 'confirm' : d.kind === 'finding_disposition' ? 'accept' : 'approve'),
      done: () => {
        const review = rows(fx.home, 'SELECT * FROM "design_reviews" WHERE "project" = ? ORDER BY rowid', project).filter((r) => !reviewsBefore.has(r.id)).at(-1);
        const a = activity(fx.home, project);
        // A question the owner acknowledged under E179 stays open; every other one is asked (E179; SEAM.md §560).
        const excepted = new Set(e179Exception(ctx, fx.home, openDecisions(fx.home, project)).acknowledged.map((x) => x.id));
        // A fix the engine can no longer move fails the review at once, naming it (SEAM.md §561).
        return ended(a, { confirmed: Boolean(review?.confirmation_decision), excepted }) ? review : undefined;
      },
      stall: false,
    });
    const r25 = ruleTwentyFive(fx.home, project, name, { handover: HANDOVER.review, exception: ctx });
    if (r25.acknowledged_open.length > 0) {
      tellSean(
        ctx,
        [
          `SURETY REAL LANE: ${name} ends completed under ${E179.ref}, not as M519 (h) / M535 (j) are written: these questions stay open, acknowledged by your own record, not resolved or verified; the run is not clean:`,
          ...r25.acknowledged_open.map((a) => `  ${a.kind} ${a.id} (${a.requirement}): ${a.verification_gap}`),
        ].join('\n'),
      );
    }
    const acts = await recordActs(ctx, row, name, { home: fx.home, project, sinceSeq, since: startedAt, central });
    const review = s.value;
    const design = (await fx.engine.get(`/v1/projects/${project}/design`)).body ?? null;
    const out = {
      review: { id: review.id, trigger: review.trigger, subject: json(review.subject), verdicts: json(review.verdicts), confirmed_by: review.confirmed_by, confirmation_decision: review.confirmation_decision },
      evidence: rows(fx.home, 'SELECT "id", "provenance", "target", "screen", "route", "status", "observed_on" FROM "design_evidence" WHERE "review" = ?', review.id),
      human_tests: design?.human_tests ?? null,
      relay: relay ? { opened: relay.open?.status === 0, closed: relay.close?.status === 0 } : null,
      rule_25: r25,
      acts,
    };
    observe(ctx, row, 'review', out);
    return out;
  });
}

// The teardown in the deployment's `finally`: the preview stopped through
// the owner's route if one still serves (the runner's setup, printed and
// recorded), then Alpha's teardown as M5's (`teardownStep`, applied, nothing
// of the run home's prefix left, the journal searched for the token).
async function teardownBoth(ctx, row, fx, project) {
  const live = previewsOf(fx.home, project).filter((p) => p.status === 'deployed' || p.status === 'deploying');
  if (live.length > 0) {
    tellSean(ctx, `SURETY REAL LANE: setup (the runner's, through the owner's route): the preview still serving is stopped (DELETE /v1/projects/${project}/design/preview).`);
    const res = await fx.engine.request('DELETE', `/v1/projects/${project}/design/preview`, {});
    observe(ctx, row, `preview_stop_${Date.now()}`, { status: res.status, generations: live.map((p) => p.generation) });
    await pollUntil(async () => {
      await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
      return previewsOf(fx.home, project).every((p) => !['deployed', 'deploying'].includes(p.status)) ? true : undefined;
    }, { timeoutMs: 600_000, everyMs: 5_000, what: 'the preview torn down' }).catch((err) => observe(ctx, row, `preview_stop_failed_${Date.now()}`, { error: String(err?.message ?? err) }));
  }
  return teardownStep(ctx, row, stepName(row, 'teardown'), project, fx);
}

// The build to the review in one engine (see the header): M519 build,
// alpha, review; M535 build, asset, alpha, review; the teardown in `finally`.
export async function m6BuildToReview(ctx, row) {
  const project = projectOf(ctx, row);
  const order = row === 'M519' ? ['build', 'alpha', 'review'] : ['build', 'asset', 'alpha', 'review'];
  const st = loadState(ctx).steps ?? {};
  // A record from before the re-read after the wait (harness finding F6, errata E168): each step done is rebuilt once
  // where its attempts hold an owner decision it lacks, before any judgement reads it (a judge rerun runs no step and
  // reaches here). No engine of the row runs here: the store is read directly.
  for (const s of STEPS[row].filter((x) => x.startsWith(PREFIX[row]))) if (st[s]?.status === 'done') rebuildUnrecordedActs(ctx, row, s, { project });
  const allDone = order.every((s) => st[stepName(row, s)]?.status === 'done');
  if (allDone && st[stepName(row, 'teardown')]?.status === 'done') return st[stepName(row, 'review')].value;
  // Before any engine starts or the project resumes (BS5 §12; M5's S3): a
  // halted run directory, or a step to run that failed earlier, refuses here,
  // with nothing started. (M519: after judge (c) halted the directory, each
  // later case started an engine and resumed the project before the build
  // step's own refusal.) The teardown's rerun alone (README §7) is as before.
  if (!allDone) refuseIfStopped(ctx, stepName(row, order.find((s) => st[stepName(row, s)]?.status !== 'done')));
  // Only the teardown left (its rerun, README §7): a loaded unit of the prefix is what it is for.
  return onEngine(ctx, `${row} ${stepName(row, allDone ? 'teardown' : order[0])}`, { projects: [project], resume: project, teardown: allDone }, async (fx) => {
    try {
      let last = null;
      for (const s of order) {
        if (s === 'build') last = await buildStep(ctx, row, fx, project);
        else if (s === 'asset') last = await assetStep(ctx, row, fx, project);
        else if (s === 'alpha') last = await alphaStep(ctx, row, fx, project);
        else last = await reviewStep(ctx, row, fx, project);
      }
      return last;
    } finally {
      await teardownBoth(ctx, row, fx, project);
    }
  });
}

// ---- what the report keeps (BS6 §12, §13; M540) -------------------------------------------------

// The token in no file of the run directory, no git object, no unit property
// (read while running, in `alpha`'s value), no journal output (the
// teardown's), and no session transcript record (searched in memory).
export function transcriptTokenHits(ctx, home, project) {
  if (!ctx.keyValue) return 0;
  return rows(home, 'SELECT "entries" FROM "session_transcripts" WHERE "project" = ?', project).reduce((n, t) => n + holdsAny(String(t.entries ?? ''), { token: ctx.keyValue }).length, 0);
}

export async function m6Records(ctx, row) {
  const { project, repo } = stepValue(ctx, stepName(row, 'create'));
  return onEngine(ctx, `${row} records`, { projects: [project], teardown: true }, async (fx) => {
    const pace = await readPace(fx, project);
    const design = (await fx.engine.get(`/v1/projects/${project}/design`)).body ?? null;
    mkdirSync(join(ctx.runDir, 'observed'), { recursive: true, mode: 0o700 });
    writeFileSync(join(ctx.runDir, 'observed', `pace-${row}.json`), `${JSON.stringify(pace.body, null, 2)}\n`, { mode: 0o600 });
    const out = {
      pace_status: pace.status,
      design_pace: pace.body?.design ?? null,
      design_status: design ? { revisions: designRevisionsOf(fx.home, project).map((r) => ({ id: r.id, version: r.version, scope: r.scope, status: r.status, revision: r.revision })), human_tests: design.human_tests ?? null } : null,
      human_acts: humanActs(fx.home, project),
      acts: readActs(ctx, row),
      steps: stepVerdicts(ctx.runDir, STEPS[row].filter((s) => s.startsWith(PREFIX[row]))),
      findings: row === 'M519' ? findingsOf(ctx.runDir) : null,
      ledger: ledgerOfProject(fx.home, project).map((l) => ({ run: l.run, model_requested: l.model_requested, model_observed: l.model_observed, cost_status: l.cost_status, cost_usd: l.cost_usd })),
      results: resultsOfProject(fx.home, project).map((r) => ({ id: r.id, execution_seq: r.execution_seq, runner_id: r.runner_id, execution_established: r.execution_established })),
      token: tokenSearch(ctx, [repo]),
      transcript_token_hits: transcriptTokenHits(ctx, fx.home, project),
      // The questions open at the run's end, each acknowledged under E179 or not (SEAM.md §560).
      e179: e179Record(ctx, fx.home, project),
      left: unitsOfRunHome(ctx, `${row} records`),
    };
    observe(ctx, row, 'records', out);
    return out;
  });
}

// The journey's steps in order, each at most once per run directory, up to `last`.
export async function upTo(ctx, row, last) {
  const steps = [
    ['m6_attempt', () => m6Attempt(ctx, row)],
    ['m6_activation', () => m6Activation(ctx, row)],
    [stepName(row, 'create'), () => m6Create(ctx, row)],
    [stepName(row, 'spec'), () => m6Spec(ctx, row)],
    [stepName(row, 'architecture'), () => m6Architecture(ctx, row)],
    [stepName(row, 'qualify'), () => m6Qualify(ctx, row)],
    [stepName(row, 'design'), () => m6Design(ctx, row)],
    [stepName(row, 'review'), () => m6BuildToReview(ctx, row)],
  ];
  const at = (n) => (['build', 'asset', 'alpha', 'review', 'teardown'].some((s) => n === stepName(row, s)) ? stepName(row, 'review') : n);
  for (const [name, run] of steps) {
    await run();
    if (name === at(last)) return;
  }
}

export { assert };
