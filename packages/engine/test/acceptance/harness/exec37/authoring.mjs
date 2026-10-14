// Slice 37's check-authoring cases (M435, M450; SEAM.md §428): the
// reference project published with its project paused, so that no
// `check_authoring` run is dispatched before a test has scripted it and armed
// its barriers; the readers of readiness, obligations and holds. Kernel lane:
// the scripted backend and the scripted check boundary; nothing acts on a
// process but the test's own engine and its scripted roles.

import assert from 'node:assert/strict';

import { runningClassifier, setEngineConfig } from '../checks/classifier.mjs';
import { answer, consume, decisionsOfKind } from '../decisions.mjs';
import { eventsOfType } from '../journal.mjs';
import { pauseProject, resumeProject, scriptedEngine, tick } from '../runs.mjs';
import { step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import {
  TALLY_PHASE_SIZE,
  architectSession,
  createWithIdea,
  journeyContext,
  journeyScripts,
  openDecisions,
  queuedExecutions,
  specSession,
  visionSession,
  workOf,
  runsOfProject,
  phasePlansOf,
  waitPublished,
} from '../journey/drive.mjs';
import { recordExit } from '../checks/selection.mjs';
import { authoringFiles } from '../journey/reference.mjs';
import { roleThat } from '../gitruns.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// The reference project at `developing` on the scripted backend, the
// classifier `authoritative`, under `autonomy: phase`, with the journey's
// scripts by kind, its first plan published while the project was paused:
// no work of the plan has been dispatched when this returns. The caller
// scripts and arms what it needs, then `go(fx, p)` resumes the project.
export async function pausedDeveloping(t, { tier = 'T2', policy = {}, spec, over = {}, config = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  await fx.start();
  journeyScripts(fx);
  const p = await createWithIdea(fx, { tier, policy: { autonomy: 'phase', alpha_deploy: 'manual', phase_size: TALLY_PHASE_SIZE, ...policy } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, spec === undefined ? {} : { second: spec });
  // The Architect's session closes on a running project (a paused one opens
  // none); the project is paused before the two approvals are answered, so
  // their publication registers the plan's work and dispatches none of it.
  const arch = await architectSession(fx, p.id, p.repo, { over, answer: 'none' });
  assert.ok(arch.decisions.architecture_approval && arch.decisions.plan_approval, `the close raised the pair (${JSON.stringify(arch.closed)})`);
  await pauseProject(fx.engine, p.id);
  for (const kind of ['architecture_approval', 'plan_approval']) await consume(fx, p.id, arch.decisions[kind], 'approve');
  arch.published = await waitPublished(fx, p.id);
  assert.ok(arch.published, 'the first plan is published while the project is paused');
  assert.deepEqual(runsOfProject(fx.home, p.id).filter((r) => r.kind !== 'session'), [], 'nothing of the plan dispatched while paused');
  const ctx = journeyContext(fx, p, { tier });
  return { fx, p, ctx, plan: arch.published };
}

export const go = (fx, p) => resumeProject(fx.engine, p.id);

// The context dump a role does first (SEAM.md §239's probe).
export const DUMP = Object.freeze({ probe: { action: 'context_dump' } });
const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));

// Phase `phase`'s authoring as the journey writes it, with `extra` result
// fields (B.7: `deferred_criteria`, `governed_changes`), `drop` paths left out,
// `add` files written beside, and `before` steps first.
export function authoringWith(phase, { extra = {}, drop = [], add = {}, before = [], changeKind } = {}) {
  const files = { ...authoringFiles(phase), ...add };
  for (const path of drop) delete files[path];
  const s = roleThat(writes(files), {
    proposal: { rationale: `The Verifier authors phase ${phase}'s checks.`, requested_change_kind: changeKind ?? (phase === 1 ? 'unclassifiable' : 'tightening') },
    ...extra,
  });
  return { steps: [...before, ...s.steps] };
}

// ---- readers ---------------------------------------------------------------------------

export const planRow = (home, id) => phasePlansOf(home, rows(home, 'SELECT "project" FROM "phase_plans" WHERE "id" = ?', id)[0]?.project).find((x) => x.id === id);
export const builderRuns = (home, project) => {
  const items = new Set(workOf(home, project, 'stage_build').map((w) => w.id));
  return runsOfProject(home, project).filter((r) => items.has(r.work_item));
};
export const authoringItems = (home, project) => workOf(home, project, 'check_authoring');
export const authoringRuns = (home, project) => {
  const items = new Set(authoringItems(home, project).map((w) => w.id));
  return runsOfProject(home, project).filter((r) => items.has(r.work_item));
};
export const proposalRows = (home, project) =>
  rows(home, 'SELECT * FROM "protected_proposals" WHERE "project" = ? ORDER BY "seq"', project).map((r) => ({ ...r, fingerprint_changes: json(r.fingerprint_changes ?? null) }));
export const obligationRows = (home, project) =>
  rows(home, 'SELECT * FROM "check_obligations" WHERE "project" = ? ORDER BY rowid', project).map((o) => ({ ...o, criteria: json(o.criteria), prerequisite: json(o.prerequisite ?? null), follow_up: json(o.follow_up ?? null) }));
export const eventsOfProject = (home, type, project) => eventsOfType(home, type).filter((e) => e.subject?.project === project);
export const openOf = (home, project, kind) => decisionsOfKind(home, project, kind).filter((d) => d.status === 'open');

// One round as the journey's pump does it, with no wait for idle (a held
// role is a live run): queued executions recorded with `exits`, the decisions
// of `answerKinds` answered `approve`, one tick.
export async function round(fx, ctx, { answerKinds = [], exits = () => 0 } = {}) {
  for (const x of queuedExecutions(fx.home, ctx.project)) {
    const now = withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "check_executions" WHERE "id" = ?').get(x.id));
    if (now?.status === 'queued') await recordExit(fx.engine, x.id, exits(x)).catch(() => null);
  }
  for (const d of openDecisions(fx.home, ctx.project)) {
    if (!answerKinds.includes(d.kind)) continue;
    const option = d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key;
    const res = await answer(fx.engine, ctx.project, d, option);
    (ctx.humanActs ??= []).push({ kind: d.kind, id: d.id, option, status: res.status });
  }
  await tick(fx.engine, ctx.project, { rounds: 1 });
  await new Promise((r) => setTimeout(r, 100));
}

// Rounds until `done()` answers.
export async function until(fx, ctx, done, { max = 60, what = 'the expected state', ...opts } = {}) {
  for (let i = 0; i < max; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    await round(fx, ctx, opts);
  }
  const v = await done();
  if (v !== undefined && v !== null && v !== false) return v;
  throw new Error(`${what}: not reached within ${max} rounds`);
}
