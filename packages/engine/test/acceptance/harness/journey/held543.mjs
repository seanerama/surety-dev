// Slice 39's held replan (M543; SEAM.md §474): an early replacement of
// phase 2 (D6 §5.7) whose plan check's dependency clause (D6 §5.3 item 3,
// §5.8) reads phase 1's required check `accept-r1` on the newest candidate,
// stage 3's, where the test keeps that one execution back. The rest of the
// journey is plan35's, M426 (a)'s fixture: phase 1 complete, phase 2
// published, stage 3 integrated and nominated, stage 4's Builder failing
// until it parks with a blocker offering `replan`, answered by the owner.
// Kernel lane: the scripted backend and the scripted check boundary
// (SEAM.md §190); nothing acts on a process but the test's own engine and
// its scripted roles.

import assert from 'node:assert/strict';

import { decisionsOn } from '../decisions.mjs';
import { executionRow } from '../checks/fixtures.mjs';
import { recordExitUnlessSuperseded } from '../checks/selection.mjs';
import { tick, waitForIdle } from '../runs.mjs';
import { script } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { ROUTED_KINDS, builderScript, nextPhasePublished, openDecisions, phaseCompleted, planOfPhase, queuedExecutions, workOf } from './drive.mjs';
import { answer, journey35, openPlanApprovals, planCheckRows, replan35, replanRunsOf } from './plan35.mjs';

// The hold reason M543 pins (SEAM.md §474).
export const HOLD_REASON = 'prerequisite_results';
export const KEPT_KEY = 'accept-r1';
export const DEPENDENCY = 'PLAN_DEPENDENCY_INCOMPLETE';

const ANSWERED = ROUTED_KINDS.filter((k) => k !== 'plan_approval');

// The journey's pump (drive.mjs's, kernel lane) that records every queued
// execution but those `keep` names, and answers the routed kinds but
// `plan_approval` (an outcome the cases read). Returns what `done` answers.
export async function pumpKeeping(fx, project, done, { max = 40, keep = () => false, exits = () => 0, what = 'the expected state' } = {}) {
  for (let i = 0; i < max; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    await waitForIdle(fx.home, project);
    for (const x of queuedExecutions(fx.home, project)) {
      if (keep(x)) continue;
      if (executionRow(fx.home, x.id)?.status !== 'queued') continue;
      await recordExitUnlessSuperseded(fx, x.id, exits(x));
    }
    for (const d of openDecisions(fx.home, project)) {
      if (!ANSWERED.includes(d.kind)) continue;
      const option = d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key;
      await fx.engine.post(`/v1/projects/${project}/decisions/${d.id}/answer`, { option, preview_hash: d.preview_hash });
    }
    await tick(fx.engine, project, { rounds: 1 });
  }
  throw new Error(`${what}: not reached within ${max} ticks`);
}

// The journey to the owner's `replan` answer on stage 4's blocker, with
// phase 1's `accept-r1` on stage 3's candidate kept back (`exits` decides
// it otherwise: a code records it). Returns {fx, p, ctx, bound, kept, item}:
// phase 1's completion candidate, the kept execution, and the replan item.
export async function toReplacement(t, { keptExit = null } = {}) {
  const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 1 } });
  fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2), builderScript(3), script.crash(), script.crash(), script.crash()]);
  fx.scripted.kindScript('replan', [replan35({}), replan35({}), replan35({}), replan35({}), replan35({})]);
  const done = await phaseCompleted(fx, ctx, 1);
  await nextPhasePublished(fx, ctx, 2);
  const bound = done.completion_binding?.candidate;
  assert.ok(bound, 'the fixture is live: phase 1 completed on a bound candidate');
  const isKept = (x) => x.key === KEPT_KEY && x.candidate !== bound;
  const stage4 = () => workOf(fx.home, p.id, 'stage_build').find((w) => w.subject?.stage && w.status === 'parked');
  const parked = await pumpKeeping(
    fx,
    p.id,
    () => {
      const w = stage4();
      return w && decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open');
    },
    { keep: (x) => keptExit === null && isKept(x), exits: (x) => (isKept(x) ? keptExit : 0), what: 'stage 4 parked with its blocker', max: 160 },
  );
  const kept = withStore(fx.home, (db) =>
    db.prepare(`SELECT x."id", x."candidate", x."status", c."key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."project" = ? AND c."key" = ? AND x."candidate" <> ? ORDER BY x."execution_seq" DESC LIMIT 1`).get(p.id, KEPT_KEY, bound),
  );
  assert.ok(kept, `the fixture is live: ${KEPT_KEY} registered on a phase-2 candidate`);
  const newest = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(p.id));
  assert.equal(newest?.id, kept.candidate, 'the fixture is live: the kept execution is on the newest candidate, which the dependency clause reads');
  assert.ok(parked.options.some((o) => o.key === 'replan'), `the parked stage's blocker offers replan (${JSON.stringify(parked.options.map((o) => o.key))})`);
  const before = new Set(workOf(fx.home, p.id, 'replan').map((w) => w.id));
  return {
    fx,
    p,
    ctx,
    bound,
    kept,
    phase2: planOfPhase(fx.home, p.id, 2).filter((x) => x.published_at).map((x) => x.id),
    // The owner answers `replan`; returns the replan item it registered.
    async replan() {
      const res = await answer(fx.engine, p.id, parked, 'replan');
      assert.equal(res.status, 200, `the owner answers replan (→ ${res.status} ${res.text})`);
      const items = workOf(fx.home, p.id, 'replan').filter((w) => !before.has(w.id));
      assert.equal(items.length, 1, `one replan item registered by the answer (${JSON.stringify(items.map((w) => [w.id, w.status]))})`);
      return items[0];
    },
  };
}

// ---- readers ---------------------------------------------------------------------------------

export const itemRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(id));
export const intervalsOf = (home, id) => JSON.parse(itemRow(home, id)?.held_intervals ?? '[]');
export const openInterval = (home, id) => {
  const last = intervalsOf(home, id).at(-1);
  return last && last.to === undefined ? last : null;
};
export const runsOfItem = (home, project, item) => replanRunsOf(home, project).filter((r) => r.work_item === item);
export const failedRuns = (home, project, item) => runsOfItem(home, project, item).filter((r) => r.state === 'ended' && r.outcome !== 'completed');
export const dependencyRefusals = (home, project) => planCheckRows(home, project).filter((c) => c.outcome === 'refused' && (c.reasons ?? []).some((r) => r.code === DEPENDENCY));
export const openBlockers = (home, item) => decisionsOn(home, 'blocker', item).filter((d) => d.status === 'open');
// A `pending` entry naming the execution (key and execution id).
export const names = (interval, execution) => Array.isArray(interval?.pending) && interval.pending.some((x) => x?.key === KEPT_KEY && x?.execution === execution);

// The replan's outcome while the test keeps the execution as it is: held on
// the pinned reason, a run of the item ended other than completed, a
// blocker on it, or the replacement published or routed.
export function outcomeOf(fx, p, item, phase2) {
  const open = openInterval(fx.home, item.id);
  if (open?.reason === HOLD_REASON) return { held: open };
  const failed = failedRuns(fx.home, p.id, item.id)[0];
  if (failed) return { failed };
  const blocker = openBlockers(fx.home, item.id)[0];
  if (blocker) return { blocker };
  const published = planOfPhase(fx.home, p.id, 2).find((x) => x.published_at && !phase2.includes(x.id));
  if (published) return { published };
  const approval = openPlanApprovals(fx.home, p.id)[0];
  if (approval) return { approval };
  return undefined;
}

export const show = (v) => JSON.stringify(v, (k, x) => (k === 'held' ? undefined : x));
export const describeOutcome = (o) =>
  o.failed ? `refused: run ${o.failed.id} ${o.failed.outcome}/${o.failed.reason_class}: ${o.failed.reason_text}` : o.blocker ? `a blocker ${o.blocker.id}: ${o.blocker.question}` : o.published ? `published ${o.published.id}` : o.approval ? `routed ${o.approval.id}` : `held ${JSON.stringify(o.held)}`;
