// Slice 35's planning cases (M425 to M430; SEAM.md §§406 to 414): plans at
// the first Architect close, replans by work kind with the artifacts they
// change, the readers of the plan check's columns of migration 0027, and the
// pumps that stop at a routed, refused or published replan. Kernel lane: the
// scripted backend, the scripted check boundary; nothing acts on a process
// but the test's own engine and its scripted roles.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { answer, decision, decisionsOfKind } from '../decisions.mjs';
import { recordFile } from '../records.mjs';
import { refOid } from '../repos.mjs';
import { step } from '../scripted.mjs';
import { closeSession } from '../sessions.mjs';
import { withStore } from '../store.mjs';
import {
  ROUTED_KINDS,
  TALLY_PHASE_SIZE,
  architectSession,
  journeyContext,
  journeyScripts,
  specRevisions,
  createWithIdea,
  eventsAbout,
  phasePlansOf,
  planOfPhase,
  recordOf,
  runsOfProject,
  specSession,
  visionSession,
  workOf,
} from './drive.mjs';
import { ADR_KEY, ROADMAP_JSON, STAGES, phasePlanMd } from './reference.mjs';
import { postChange, pumpNoIdle } from './review31b.mjs';
import { runningClassifier, setEngineConfig } from '../checks/classifier.mjs';
import { scriptedEngine, tick, waitForIdle } from '../runs.mjs';
import { script } from '../scripted.mjs';

const text = (v) => (typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

export const ADR_PATH = `.surety/adrs/${ADR_KEY}.md`;
export const ROADMAP_PATH = '.surety/roadmap/roadmap.json';
export const MODULES_PATH = '.surety/architecture/modules.json';
export const ARCHITECTURE_PATH = '.surety/architecture/architecture.md';

// ---- the first close ------------------------------------------------------------------------

// The reference project at `spec_ready`: created with the idea, the Vision
// and Spec Writer sessions answered. `policy`: the owner's policy at
// creation (Tally's phase size unless given).
export async function specReady(fx, { policy = {}, tier, spec } = {}) {
  const p = await createWithIdea(fx, { ...(tier ? { tier } : {}), policy: { phase_size: TALLY_PHASE_SIZE, ...policy } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, spec === undefined ? {} : { second: spec });
  return p;
}

// One Architect session whose products are the reference project's with
// `over` and `plan` (see `architectFiles`), closed and left unanswered. A
// refused close is then closed with `refuse`, so the next attempt can open
// its own session. Returns {res, check, refusals, decisions}.
export async function firstClose(fx, p, { over = {}, plan, stages, specVersion = 1, roadmapVersion = 1, architectureVersion = 1 } = {}) {
  const revision = refOid(p.repo.path, p.repo.ref);
  const plan_ = plan ?? phaseOnePlan({ revision, stages, spec_version: specVersion, roadmap_version: roadmapVersion, architecture_version: architectureVersion });
  const refusedBefore = eventsAbout(fx.home, 'baseline.plan_refused', p.id).length;
  const arch = await architectSession(fx, p.id, p.repo, { answer: 'none', over, plan: plan_ });
  if (arch.closeRes.status !== 200) await closeSession(fx, p.id, arch.run.id, { refuse: true });
  return {
    res: arch.closeRes,
    arch,
    check: planCheckRows(fx.home, p.id).at(-1) ?? null,
    refusals: eventsAbout(fx.home, 'baseline.plan_refused', p.id).slice(refusedBefore),
    decisions: arch.decisions,
  };
}

export function phaseOnePlan({ revision, stages = STAGES[1], spec_version = 1, architecture_version = 1, roadmap_version = 1, conformance = 'within_baseline' } = {}) {
  return { phase: 1, prepared_against: { spec_version, architecture_version, roadmap_version, revision }, stages, conformance };
}

// Stage `n` of a phase's stages with `change` merged into it (`validation` merged too).
export const stagesWith = (phase, changes) =>
  STAGES[phase].map((s) => {
    const c = changes[s.number];
    if (!c) return s;
    return { ...s, ...c, ...(c.validation ? { validation: { ...s.validation, ...c.validation } } : {}) };
  });

// ---- the plan check (migration 0027; SEAM.md §407) ----------------------------------------

export const planCheckRows = (home, project) =>
  rows(home, 'SELECT * FROM "plan_checks" WHERE "project" = ? ORDER BY rowid', project).map((c) => ({
    ...c,
    reasons: json(c.reasons) ?? [],
    changes_architecture: json(c.changes_architecture),
    changes_adrs: json(c.changes_adrs),
    changes_roadmap: json(c.changes_roadmap),
    uncertain: json(c.uncertain) ?? null,
    declared: json(c.declared) ?? null,
  }));
export const codesOf = (check) => (check?.reasons ?? []).map((r) => r.code);
export const subjectsOf = (check, code) => (check?.reasons ?? []).filter((r) => r.code === code).flatMap((r) => r.subjects ?? []);
// The text of the check's diff record (each changed artifact's approved and proposed content).
export function diffText(home, check) {
  if (!check?.diff) return null;
  const row = recordOf(home, check.diff);
  assert.ok(row, `the plan check's diff ${check.diff} is a record`);
  return readFileSync(recordFile(home, row), 'utf8');
}
// The 422 `plan_refused` of a close, its subject as text.
export const refusalText = (res) => JSON.stringify(res?.body?.subject ?? {});

// ---- replans by work kind ---------------------------------------------------------------------

// A replan of phase 2 (the default) that writes `files` beside its plan
// (a string is written as given, anything else as JSON), with the result
// `result` (the declarations, `findings`). The plan is prepared against the
// versions given and the run's head. `before` steps run first (a dump), `hold`
// holds before the result.
export function replan35({ phase = 2, spec_version = 1, architecture_version = 1, roadmap_version = 1, stages = STAGES[phase], files = {}, result = {}, before = [], hold = false, conformance = 'within_baseline' } = {}) {
  const plan = { phase, prepared_against: { spec_version, architecture_version, roadmap_version, revision: '__HEAD__' }, stages, conformance };
  return {
    steps: [
      ...before,
      ...Object.entries(files).map(([path, content]) => (content === null ? step.delete(path) : step.write(path, text(content)))),
      { write: { path: `.surety/phases/phase-${phase}.json`, content: text(plan), substitute_head: true } },
      step.write(`.surety/phases/phase-${phase}.md`, phasePlanMd(phase)),
      ...(hold ? [step.hold('gate', { heartbeat_ms: 250 })] : []),
      step.result({ status: 'completed', summary: `phase ${phase} planned`, plan: `phase-${phase}`, conformance, adrs_changed: [], ...result }),
    ],
  };
}

// The roadmap as a revision writes it: `version`, `architecture_version` and the phases given.
export const roadmapWith = ({ version = 2, architecture_version = 1, phases = ROADMAP_JSON.phases } = {}) => ({ ...ROADMAP_JSON, version, architecture_version, phases });
export const phaseOf = (n) => ROADMAP_JSON.phases.find((p) => p.number === n);

// ---- outcomes ------------------------------------------------------------------------------

export const replanItems = (home, project) => workOf(home, project, 'replan');
export function replanRunsOf(home, project) {
  const items = new Set(replanItems(home, project).map((w) => w.id));
  return runsOfProject(home, project).filter((r) => items.has(r.work_item));
}
export const openPlanApprovals = (home, project) => decisionsOfKind(home, project, 'plan_approval').filter((d) => d.status === 'open');

// Pump (answering the routed kinds but `plan_approval`) until the next
// replan outcome after `seen` ({runs, approvals}): a replan run that ended
// other than `completed`, an open `plan_approval` not seen before, or the
// phase's plan published. Returns {failed} | {approval} | {published}.
export async function nextReplanOutcome(fx, ctx, phase, seen, { max = 400, answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval') } = {}) {
  const project = ctx.project;
  // A run that ended `completed` and, ten rounds later, has published or
  // raised nothing is an outcome too ({silent}), so a case fails at once
  // naming it rather than at the pump's bound.
  const quiet = new Map();
  const out = await pumpNoIdle(
    fx,
    ctx,
    () => {
      for (const r of replanRunsOf(fx.home, project).filter((x) => x.state === 'ended' && x.outcome === 'completed' && !seen.runs.has(x.id))) {
        quiet.set(r.id, (quiet.get(r.id) ?? 0) + 1);
        if (quiet.get(r.id) > 10) return { silent: r };
      }
      // A refusal is reported before what its repair went on to produce.
      const failed = replanRunsOf(fx.home, project).find((r) => r.state === 'ended' && r.outcome !== 'completed' && !seen.runs.has(r.id));
      if (failed) return { failed };
      const published = planOfPhase(fx.home, project, phase).find((x) => x.published_at && !seen.published?.has(x.id));
      if (published) return { published, run: replanRunsOf(fx.home, project).filter((x) => x.state === 'ended' && x.outcome === 'completed' && !seen.runs.has(x.id)).at(-1) ?? null };
      const approval = openPlanApprovals(fx.home, project).find((d) => !seen.approvals.has(d.id));
      if (approval) return { approval, run: replanRunsOf(fx.home, project).filter((x) => x.state === 'ended' && x.outcome === 'completed' && !seen.runs.has(x.id)).at(-1) ?? null };
      return undefined;
    },
    { what: `the next outcome of phase ${phase}'s replan`, max, answerKinds },
  ).catch((err) => {
    // What holds it: the replan work, its runs, the open decisions, the spec versions.
    const state = {
      replan: replanItems(fx.home, project).map((w) => [w.status, w.trigger_source, w.trigger_generation]),
      runs: replanRunsOf(fx.home, project).map((r) => [r.state, r.outcome, r.reason_class, r.reason_text]),
      decisions: rows(fx.home, `SELECT "kind", "status" FROM "decisions" WHERE "project" = ? AND "status" = 'open'`, project).map((d) => d.kind),
      spec: specRevisions(fx.home, project).map((r) => r.version),
      plans: phasePlansOf(fx.home, project).map((x) => [x.phase_number, x.generation, x.status, x.published_at ? 'published' : null]),
    };
    throw new Error(`${err.message}; state ${JSON.stringify(state)}`);
  });
  if (out.failed) seen.runs.add(out.failed.id);
  if (out.silent) seen.runs.add(out.silent.id);
  if (out.approval) seen.approvals.add(out.approval.id);
  if (out.run) seen.runs.add(out.run.id);
  if (out.published) (seen.published ??= new Set()).add(out.published.id);
  return out;
}
// A cumulative record of the outcomes a case has handled (nothing seen at first).
export const outcomes = (published = []) => ({ runs: new Set(), approvals: new Set(), published: new Set(published) });
export const seenNow = (home, project) => ({
  runs: new Set(replanRunsOf(home, project).map((r) => r.id)),
  approvals: new Set(decisionsOfKind(home, project, 'plan_approval').map((d) => d.id)),
  published: new Set(phasePlansOf(home, project).filter((x) => x.published_at).map((x) => x.id)),
});

// The plan check a routed approval binds (its manifest's `plan_check`), or the latest.
export function checkOfApproval(home, project, row) {
  const id = decision(home, row.id)?.manifest?.plan_check ?? null;
  const all = planCheckRows(home, project);
  return all.find((c) => c.id === id) ?? all.at(-1) ?? null;
}

// `reject` with a note (the answer's `note`, D1 §10.3).
export const rejectWithNote = (fx, project, row, note) =>
  fx.engine.post(`/v1/projects/${project}/decisions/${row.id}/answer`, { option: 'reject', preview_hash: row.preview_hash, note });
export { answer };

// Nothing of a routed proposal published: no plan of `phase`, the
// architecture and roadmap versions as they were.
export function unpublished(home, project, phase) {
  return {
    plans: planOfPhase(home, project, phase).filter((x) => x.published_at).length,
    architecture: rows(home, 'SELECT "version" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version"', project).map((r) => r.version),
    roadmap: rows(home, 'SELECT "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version"', project).map((r) => r.version),
  };
}

// ---- the journey with its first products varied -----------------------------------------------

// As `journeyProject` (review31b.mjs), with the first Architect session's
// products varied by `over` and the policy by `policy`: the reference
// project at `developing` on the scripted backend, the classifier
// `authoritative`, under `autonomy: phase`, the journey's scripts by kind.
export async function journey35(t, { tier = 'T2', policy = {}, over = {}, spec, stages } = {}) {
  const fx = await scriptedEngine(t);
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  await fx.start();
  journeyScripts(fx);
  const p = await createWithIdea(fx, { tier, policy: { autonomy: 'phase', alpha_deploy: 'manual', phase_size: TALLY_PHASE_SIZE, ...policy } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, spec === undefined ? {} : { second: spec });
  // `stages`: phase 1's stages (the plan prepared against the head the session opens at).
  const plan = stages === undefined ? undefined : phaseOnePlan({ revision: refOid(p.repo.path, p.repo.ref), stages });
  const arch = await architectSession(fx, p.id, p.repo, { over, ...(plan === undefined ? {} : { plan }) });
  const ctx = journeyContext(fx, p, { tier });
  return { fx, p, ctx, plan: arch.published };
}

// The owner's change request carried to its approval as `version` (the
// Spec Writer's run writes `text`), as M449 does; whatever the approval
// registered ends at once (the default script), so a session can open next.
export async function approvedChange(fx, p, text_, version, changes) {
  fx.scripted.defaultScript(script.complete());
  fx.scripted.kindScript('spec_change', { steps: [step.write('.surety/spec/spec.md', text_), step.result({ status: 'completed', summary: 'the change', changes })] });
  const ctx = journeyContext(fx, p);
  await postChange(fx, ctx, 'The owner\'s change.');
  const approved = await pumpNoIdle(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === version), { what: `spec version ${version}`, answerKinds: ['spec_change'] });
  await tick(fx.engine, p.id, { rounds: 2 });
  await waitForIdle(fx.home, p.id);
  return approved;
}

// Phase `n` carried to completion with every routed decision answered but
// `plan_approval` (which the journey's pump would answer, so a replan that
// follows the completion is never approved by it).
export const phaseCompleteNoPlanAnswer = (fx, ctx, n = 1, { max = 600 } = {}) =>
  pumpNoIdle(fx, ctx, () => planOfPhase(fx.home, ctx.project, n).find((x) => (x.active === 1 || x.active === true) && x.completed_at), {
    what: `phase ${n} to complete`,
    max,
    answerKinds: ROUTED_KINDS.filter((k) => k !== 'plan_approval'),
  });

// After a refused replan run: its item takes its automatic repair, or (when
// the repairs are spent) parks with a blocker, which is answered `retry` so
// the next scripted launch runs. Returns 'repair' or 'retry'.
export async function afterRefusal(fx, ctx, failedRun, { answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval') } = {}) {
  const project = ctx.project;
  const how = await pumpNoIdle(
    fx,
    ctx,
    () => {
      const blocker = rows(fx.home, `SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`, failedRun.work_item)[0];
      if (blocker) return { blocker: decision(fx.home, blocker.id) };
      const later = replanRunsOf(fx.home, project).find((r) => r.work_item === failedRun.work_item && r.id !== failedRun.id && r.id > failedRun.id);
      return later ? { repair: later } : undefined;
    },
    { what: 'the refused replan repaired or parked', max: 20, answerKinds },
  );
  if (how.repair) return 'repair';
  const res = await answer(fx.engine, project, how.blocker, 'retry');
  assert.equal(res.status, 200, `the owner answers the replan's blocker retry (→ ${res.status} ${res.text})`);
  return 'retry';
}
