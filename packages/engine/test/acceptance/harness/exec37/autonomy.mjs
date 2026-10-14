// Slice 37's readers and pumps for the autonomy profiles (M436), the
// superseded phase sign-off (M429 (d)) and the policy's unexpected
// preparation error (M407; carried item (i)). Kernel lane: the scripted
// backend, the scripted check boundary (§190) and the scripted deployment
// adapter (§247). Nothing here acts on a unit or a process but the test's
// own engine. SEAM.md §429
//
// Ordering is by insertion (`seq`, rowid), never by a wall-clock timestamp:
// the workstation's clock steps back about 1 s every 31 s (the slice-36
// ruling).

import { recordExit } from '../checks/selection.mjs';
import { answer } from '../decisions.mjs';
import { ROUTED_KINDS, openDecisions, queuedExecutions } from '../journey/drive.mjs';
import { tick } from '../runs.mjs';
import { withStore } from '../store.mjs';

const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));



// The project's last decision `seq` (decisions are numbered per project in
// insertion order).
export const decisionSeq = (home, project) => withStore(home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "decisions" WHERE "project" = ?').get(project).n);

// Every decision of the project raised after decision `sinceSeq`, parsed.
export const decisionsSince = (home, project, sinceSeq = 0) =>
  rows(home, 'SELECT * FROM "decisions" WHERE "project" = ? AND "seq" > ? ORDER BY "seq"', project, sinceSeq).map((d) => ({
    ...d,
    options: json(d.options),
    dependency_manifest: json(d.dependency_manifest),
    blocked_while_open: json(d.blocked_while_open),
    answer: json(d.answer),
  }));

// The chaining boundaries of the project: `blocker` decisions whose preview
// names the cause `max_chained_roles` (D1-34; SEAM §40 and queue.ts's form).
export const boundaryDecisions = (home, project, sinceSeq = 0) =>
  decisionsSince(home, project, sinceSeq).filter((d) => d.kind === 'blocker' && d.dependency_manifest?.cause === 'max_chained_roles');

export const workRow = (home, id) => {
  const w = withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(id));
  return w ? { ...w, subject: json(w.subject), blocker: json(w.blocker), depends_on: json(w.depends_on) } : w;
};
// `work_items.chain_origin` † (SEAM §429): the trigger identity of the
// chain's first item, {trigger_source, trigger_id, trigger_generation}.
export const chainOriginOf = (home, id) => {
  const w = withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(id));
  return w && 'chain_origin' in w ? json(w.chain_origin) : undefined;
};
export const originOf = (source, id, generation = 1) => ({ trigger_source: source, trigger_id: id, trigger_generation: generation });

// Ticks without waiting for runs to end, as review31b's `pumpNoIdle`, but
// records the exit of a queued execution only when `record(x)` says so (a
// post-deploy check withheld), and lets `each()` act between rounds (a held
// Reviewer of a proposal released). `answerKinds`: the routed kinds answered
// as the owner, with `approve` where offered.
export async function pumpSome(fx, ctx, done, { max = 80, what = 'the expected state', exits = () => 0, record = () => true, answerKinds = ROUTED_KINDS, each = async () => {} } = {}) {
  ctx.humanActs ??= [];
  for (let i = 0; i < max; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    await each();
    for (const x of queuedExecutions(fx.home, ctx.project)) {
      if (!record(x)) continue;
      const now = withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "check_executions" WHERE "id" = ?').get(x.id));
      if (now?.status === 'queued') await recordExit(fx.engine, x.id, exits(x)).catch(() => null);
    }
    for (const d of openDecisions(fx.home, ctx.project)) {
      if (!answerKinds.includes(d.kind)) continue;
      const option = d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key;
      const res = await answer(fx.engine, ctx.project, d, option);
      ctx.humanActs.push({ kind: d.kind, id: d.id, option, status: res.status });
    }
    await tick(fx.engine, ctx.project, { rounds: 1 });
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not reached within ${max} rounds`);
}

// The launches of a work kind in launch order (the role program's log).
export const launchesOfKind = (fx, kind) => fx.scripted.launches({ work_kind: kind });
export const holding = (fx, launch) => Boolean(launch) && fx.scripted.eventsOf(launch.pid, 'holding').length > 0;

export const stageRows = (home, project) =>
  rows(home, 'SELECT s.*, p."generation" AS "plan_generation", p."phase_number" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE s."project" = ? ORDER BY s.rowid', project).map((s) => ({
    ...s,
    validation: json(s.validation),
    depends_on: json(s.depends_on),
  }));
export const stageWork = (home, project, stageId) =>
  rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' ORDER BY "seq"`, project)
    .map((w) => ({ ...w, subject: json(w.subject) }))
    .find((w) => w.subject?.stage === stageId);
export const ledgerByRun = (home, project) => {
  const out = new Map();
  for (const r of rows(home, 'SELECT "run" FROM "ledger_rows" WHERE "project" = ?', project)) out.set(r.run, (out.get(r.run) ?? 0) + 1);
  return out;
};
export const candidatesOf = (home, project) => rows(home, 'SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"', project);
