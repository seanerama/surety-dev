// Slice 36's specification-change cases (M431 to M434; SEAM.md §§416 to
// 424): the specifications the Spec Writer's one-shot proposes, each one
// change against the reference project's version 1; the readers of a
// request, its side ref, its impact record and the obligations; the pumps
// that stop at a proposal, a failed request or a held execution. Kernel lane:
// the scripted backend and the scripted check boundary (§190); nothing here
// starts a process but the test's own engine and its scripted roles, and the
// `surety` CLI against that engine's own home.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { recordExit } from '../checks/selection.mjs';
import { executionRow } from '../checks/fixtures.mjs';
import { answer, decision, decisionsOn } from '../decisions.mjs';
import { CLI } from '../engine.mjs';
import { roleThat } from '../gitruns.mjs';
import { recordFile, recordRow } from '../records.mjs';
import { gitQuiet, refOid } from '../repos.mjs';
import { addWork, runsOf, tick, waitForIdle } from '../runs.mjs';
import { step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { ROUTED_KINDS, builderScript, candidatesOfProject, openDecisions, planOfPhase, queuedExecutions, runsOfProject, stagesOfPlan, workOf } from './drive.mjs';
import { journey35 } from './plan35.mjs';
import { ADR_KEY, REQUIREMENTS, adrText, specText } from './reference.mjs';
import { pumpNoIdle } from './review31b.mjs';
import { script } from '../scripted.mjs';

export const SPEC_PATH = '.surety/spec/spec.md';
export const sideRef = (seq) => `refs/surety/spec-change/${seq}`;
const req = (key) => REQUIREMENTS.find((r) => r.key === key);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// ---- the proposed specifications (version 2 of Tally's; TPL's shape) ---------------------------------

const v2 = (requirements, change, { index } = {}) =>
  specText({ version: 2, requirements, ...(index ? { index } : {}), changeLog: [{ version: 2, date: '2026-10-13', change, by: 'Sean' }] });
const withKeys = (changes) => REQUIREMENTS.map((r) => (changes[r.key] ? { ...r, ...changes[r.key] } : r));

// R5, the added requirement of M432 (a) and M434: phase hint 2 in the
// index, one criterion, in `service`.
export const R5 = Object.freeze({
  key: 'R5',
  title: 'Count the refusals',
  phase: 2,
  module: 'service',
  statement: 'A user reads how many /sum requests the service refused since it started.',
  criteria: [{ id: 'R5.1', text: 'Given the service has refused one /sum request since it started, when a client requests GET /stats, then the JSON body has "refused": 1.' }],
});
export const R3_1_TEXT = 'Given a fresh tally, when `count()` of `makeTally()` in `src/tally.mjs` is called three times, then `total()` returns the number 3, not a string.';
export const R3_STATEMENT = 'The library counts each sum served since the process started, one at a time, with no persistence.';
export const AREA = 'secrets_credentials';

// R4 (and its module `service` in §6) given the area `area` in place of none.
function withAreaOnR4(spec, area) {
  const heading = spec.indexOf('### R4. ');
  const line = '**Sensitive areas:** none';
  const at = spec.indexOf(line, heading);
  assert.ok(heading > 0 && at > heading, 'the fixture is live: R4 has its subsection');
  let out = `${spec.slice(0, at)}**Sensitive areas:** ${area}${spec.slice(at + line.length)}`;
  const row = `| R4 | ${req('R4').title} | 2 | none |`;
  assert.ok(out.includes(row), 'the fixture is live: R4 has its index row');
  out = out.replace(row, `| R4 | ${req('R4').title} | 2 | ${area} |`);
  const module = '| service | `server.mjs` | none |';
  assert.ok(out.includes(module), 'the fixture is live: §6 lists service');
  return out.replace(module, `| service | \`server.mjs\` | ${area} |`);
}

export const SPEC_CHANGES = Object.freeze({
  // M432 (a): R5 added, R2 withdrawn, R3.1's text changed, an area added to R4.
  a: withAreaOnR4(
    v2([req('R1'), { ...req('R3'), criteria: [{ id: 'R3.1', text: R3_1_TEXT }] }, req('R4'), R5], 'R5 added; R2 withdrawn; R3.1 names the type; R4 handles a secret'),
    AREA,
  ),
  // M432 (b): R2's criteria reordered, every text unchanged.
  reordered: v2(withKeys({ R2: { criteria: [...req('R2').criteria].reverse() } }), 'R2\'s criteria reordered'),
  // M432 (c): R3's statement only, every ID unchanged.
  r3Statement: v2(withKeys({ R3: { statement: R3_STATEMENT } }), 'R3\'s statement sharpened'),
  // M432 (d): an index row whose phase is not a number (R2's); R3's statement changed beside it.
  indexUnparsable: v2(withKeys({ R3: { statement: R3_STATEMENT } }), 'R3\'s statement sharpened').replace(`| R2 | ${req('R2').title} | 1 | none |`, `| R2 | ${req('R2').title} | one | none |`),
  // M431 (e): R2.2 renumbered R2.3, its text unchanged.
  renumbered: v2(withKeys({ R2: { criteria: [req('R2').criteria[0], { id: 'R2.3', text: req('R2').criteria[1].text }] } }), 'R2.2 renumbered'),
  // M431 (d), (f): R1.1 reworded (phase 1's lib criterion).
  r1Reworded: v2(withKeys({ R1: { criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5.' }] } }), 'R1.1 names the type'),
  // M431 (f): what a hand-moved side ref would carry instead.
  moved: v2(withKeys({ R1: { statement: 'The library sums two numbers, and also subtracts them.' } }), 'not the proposal'),
  // M433: R2.1 and R2.2 reworded (accept-r2 covers both, integration R2.2).
  r2Both: v2(
    withKeys({
      R2: {
        criteria: [
          { id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with content type application/json and the JSON body {"sum": 5}.' },
          { id: 'R2.2', text: 'Given the service is running, when a client requests GET /sum?a=x&b=3, then it answers 400 with content type application/json.' },
        ],
      },
    }),
    'R2.1 and R2.2 name the content type',
  ),
});

// The Spec Writer's one-shot writing `text` with the result's `changes`.
export const changeScript = (text, changes = [{ key: 'R1', kind: 'criteria_changed', reason: 'the owner\'s change' }], { hold = false, extra = [] } = {}) =>
  hold
    ? { steps: [step.write(SPEC_PATH, text), ...extra, step.hold('gate', { heartbeat_ms: 250 }), step.result({ status: 'completed', summary: 'the change', changes })] }
    : roleThat([step.write(SPEC_PATH, text), ...extra], { summary: 'the change', changes });

// ---- the CLI (`surety spec change-request`; D1 §11.4; SEAM.md §416) --------------------------------

export function surety(fx, args) {
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SURETY_HOME: fx.home } });
  let body;
  try {
    body = JSON.parse(done.stdout);
  } catch {
    body = undefined;
  }
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '', body };
}

// ---- readers ---------------------------------------------------------------------------------------

export const requestRow = (home, id) => one(home, 'SELECT * FROM "spec_change_requests" WHERE "id" = ?', id);
export const requestsOf = (home, project) => rows(home, 'SELECT * FROM "spec_change_requests" WHERE "project" = ? ORDER BY "seq"', project);
export const registryRow = (home, project, ref) => one(home, 'SELECT * FROM "ref_registry" WHERE "project" = ? AND "ref" = ?', project, ref);
export const specAt = (repo, rev) => {
  try {
    return gitQuiet(repo, ['show', `${rev}:${SPEC_PATH}`]);
  } catch {
    return null;
  }
};
export const blobAt = (repo, rev) => {
  try {
    return gitQuiet(repo, ['rev-parse', `${rev}:${SPEC_PATH}`]);
  } catch {
    return null;
  }
};
export const changeDecisions = (home, request) => decisionsOn(home, 'spec_change', request);
export const openChangeDecision = (home, request) => changeDecisions(home, request).find((d) => d.status === 'open') ?? null;

// The impact as the engine recorded it (D6 §4.4; A.3 `spec_impact`; SEAM.md
// §418): the request's `impact` record, kind `spec_impact`, its content.
export function impactRecordOf(home, request) {
  const r = requestRow(home, request);
  assert.ok(r?.impact, `the request ${request} names its impact record (${JSON.stringify(r)})`);
  const row = recordRow(home, r.impact);
  assert.ok(row, `the impact ${r.impact} is a record`);
  return { row, value: JSON.parse(readFileSync(recordFile(home, row), 'utf8')) };
}
export const impactOf = (home, request) => impactRecordOf(home, request).value;

// The impact's lists by class, as sets of what they name (SEAM.md §418).
export const impactRequirements = (impact) => Object.fromEntries((impact.requirements ?? []).map((q) => [q.key, [...q.changes].sort()]));
export function impactCheckKeys(impact) {
  const c = impact.checks ?? {};
  return [...new Set([...(c.obligations ?? []), ...(c.criterion_unknown ?? [])].map((x) => x.key))].sort();
}

// ---- pumps -----------------------------------------------------------------------------------------

// Ticks, recording queued executions' exits except those `hold(x)` keeps
// queued, answering the open decisions of `answerKinds` (approve, else the
// first option), until `done` answers; at most `max` rounds. Waits for the
// project's runs to end only when `idle` (a held role is a live run).
export async function pumpHolding(fx, ctx, done, { max = 80, what = 'the expected state', hold = () => false, exits = () => 0, answerKinds = [], idle = false } = {}) {
  ctx.humanActs ??= [];
  for (let i = 0; i < max; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    if (idle) await waitForIdle(fx.home, ctx.project);
    for (const x of queuedExecutions(fx.home, ctx.project)) {
      if (hold(x)) continue;
      if (executionRow(fx.home, x.id)?.status !== 'queued') continue;
      await recordExit(fx.engine, x.id, exits(x)).catch(() => null);
    }
    for (const d of openDecisions(fx.home, ctx.project)) {
      if (!answerKinds.includes(d.kind)) continue;
      const option = d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key;
      const res = await answer(fx.engine, ctx.project, d, option);
      ctx.humanActs.push({ kind: d.kind, id: d.id, option, status: res.status });
    }
    await tick(fx.engine, ctx.project, { rounds: 1 });
    if (idle) await waitForIdle(fx.home, ctx.project);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not reached within ${max} rounds`);
}

// The request carried until it is `proposed` with an open `spec_change`
// decision, or until it is `failed`. Returns {request, decision}.
export async function untilProposedOrFailed(fx, ctx, id, opts = {}) {
  return pumpHolding(
    fx,
    ctx,
    () => {
      const r = requestRow(fx.home, id);
      if (r?.status === 'failed') return { request: r, decision: null };
      const d = r?.status === 'proposed' ? openChangeDecision(fx.home, id) : null;
      return d ? { request: r, decision: decision(fx.home, d.id) } : undefined;
    },
    { what: `request ${id} proposed or failed`, ...opts },
  );
}

// POST …/spec/change-requests {text} with the Spec Writer scripted to write
// `spec`; carried to the proposal (or the failure). Returns {request, decision}.
export async function propose(fx, ctx, spec, changes, opts = {}) {
  fx.scripted.kindScript('spec_change', changeScript(spec, changes));
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text: opts.text ?? 'The owner\'s change.' });
  assert.equal(res.status, 201, `POST …/spec/change-requests (→ ${res.status} ${res.text})`);
  return untilProposedOrFailed(fx, ctx, res.body.request.id, opts);
}

// The owner rejects the proposal; the request is settled `rejected`.
export async function rejectProposal(fx, ctx, d) {
  const res = await answer(fx.engine, ctx.project, d, 'reject');
  assert.equal(res.status, 200, `the owner rejects spec_change ${d.id} (→ ${res.status} ${res.text})`);
  await tick(fx.engine, ctx.project, { rounds: 1 });
}

// Runs of a work item, oldest first.
export const runsOfItem = (home, item) => rows(home, 'SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"', item);

// ---- phase 2 at rest (M432 (a) to (c), (e); M433 (b), (d), (e); M434) ------------------------------

// ADR-001 citing R2 in its text (D6 §4.4's textual class).
export const ADR_CITING_R2 = adrText({ decision: 'The service uses Node\'s own `http` module and no dependency; R2\'s routes answer JSON.' });
export const ADR_PATH = `.surety/adrs/${ADR_KEY}.md`;
const active = (x) => x.active === 1 || x.active === true;

// The reference project carried by the journey's own path into phase 2 and
// left at rest: phase 1 complete, phase 2 published and authored, stage 3
// built, integrated and verified, stage 4's Builder failing at once so its
// work parks after its repairs with its blocker unanswered; no run
// live and no execution queued. ADR-001 cites R2. Returns {fx, p, ctx,
// plan2, stage3, stage4, candidate3}.
export async function phaseTwoAtRest(t, { policy = {} } = {}) {
  const { fx, p, ctx } = await journey35(t, { over: { [ADR_PATH]: ADR_CITING_R2 }, policy: { repair_attempts_max: 0, ...policy } });
  fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2), builderScript(3), script.crash(), script.crash(), script.crash(), script.crash()]);
  const home = fx.home;
  const state = await pumpNoIdle(
    fx,
    ctx,
    () => {
      const plan2 = planOfPhase(home, p.id, 2).find(active);
      if (!plan2) return undefined;
      const stages = stagesOfPlan(home, plan2.id);
      const stage3 = stages.find((s) => s.number === 3);
      const stage4 = stages.find((s) => s.number === 4);
      const build4 = workOf(home, p.id, 'stage_build').find((w) => w.subject?.stage === stage4?.id);
      const live = runsOfProject(home, p.id).filter((r) => r.state !== 'ended');
      if (stage3?.status !== 'verified' || build4?.status !== 'parked' || live.length > 0 || queuedExecutions(home, p.id).length > 0) return undefined;
      return { plan2, stage3, stage4, build4 };
    },
    { what: 'phase 2 at rest: stage 3 verified, stage 4 parked, nothing live', max: 800, answerKinds: ROUTED_KINDS },
  );
  // Stage 3's candidate: the latest nominated, stage 4 having integrated nothing.
  const candidate3 = candidatesOfProject(home, p.id).at(-1);
  return { fx, p, ctx, ...state, candidate3 };
}

// ---- acts while a role is held (no wait for idle) ----------------------------------------------------

// Findings a Reviewer's run reports on `candidate` (a work item the harness
// adds, SEAM.md §77's fixture work), its end awaited without waiting for the
// project's other runs. Returns the finding rows it recorded.
export async function findingsOn(fx, ctx, candidate, findings) {
  const before = rows(fx.home, 'SELECT "id" FROM "findings" WHERE "project" = ?', ctx.project).map((f) => f.id);
  const item = await addWork(fx.engine, ctx.project, 'review', { subject: { candidate } });
  fx.scripted.script(item, [roleThat([], { findings })]);
  const run = await pumpHolding(fx, ctx, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { what: 'the Reviewer\'s run reporting findings', ...ctx.holdOpts });
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the Reviewer's run was accepted (${run.reason_text})`);
  return rows(fx.home, 'SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"', ctx.project).filter((f) => !before.includes(f.id));
}

// The next open `spec_change` decision about `request` other than `prev`.
export const nextOpenChange = (fx, ctx, request, prev, opts = {}) =>
  pumpHolding(fx, ctx, () => {
    const d = changeDecisions(fx.home, request).find((x) => x.status === 'open' && x.id !== prev.id);
    return d ? decision(fx.home, d.id) : undefined;
  }, { what: `the next generation of spec_change about ${request}`, max: 12, ...ctx.holdOpts, ...opts });

// A role that writes `files`, holds at `gate`, then reports `result`.
export const holding = (files = {}, result = {}) => ({
  steps: [...Object.entries(files).map(([path, text]) => step.write(path, text)), step.hold('gate', { heartbeat_ms: 250 }), step.result({ status: 'completed', summary: 'held, then done', ...result })],
});
// Whether the latest launch of `kind` (or the launch at `index`) is holding.
export function launchHolding(fx, kind, index) {
  const all = fx.scripted.launches({ work_kind: kind });
  const launch = index === undefined ? all.at(-1) : all[index];
  return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? launch : undefined;
}

export { ROUTED_KINDS, json, refOid };
