// The autonomy profile (D6 §6.5; K3; N02; E139 Q3): where the chaining
// boundary of D1 §8.1 step 8 falls. `step`, as D1-34 built it: a decision
// after every role run (work a run's outcome created waits for the owner's
// `continue`). `stage`: the chain Builder → checks → Verifier → Reviewer →
// repairs runs unattended, and the boundary falls before the next stage's
// Builder. `phase`, the default: every stage of the open plan, the phase
// verification and the replan run unattended; the boundary falls only
// where the foundations route a decision, which is not here.
//
// Under every profile `max_chained_roles` is a hard bound on inherited chain
// depth (default 24), a fresh plan-stage trigger beginning a new chain; it
// is not a budget (N02). Pure over the store: a read, no write.

import type { Database } from 'better-sqlite3';

import { projectOptions, projectPolicy } from '../store/transitions/settings.js';
import type { WorkRow } from '../store/transitions/work.js';

// The kinds whose dispatch begins a stage's or a phase's chain.
const STAGE_START = ['stage_build', 'conformance', 'replan', 'check_authoring'];

export function autonomyOf(db: Database, project: string): 'step' | 'stage' | 'phase' {
  const a = (projectOptions(db, project) as unknown as { autonomy?: unknown }).autonomy;
  return a === 'step' || a === 'stage' || a === 'phase' ? a : 'phase';
}

// Whether `item` is at the boundary now. An item the owner continued past a
// boundary (`boundary_passed_at`, set by the blocker's `continue`) is not
// held at the same boundary again.
export function boundaryFalls(db: Database, item: WorkRow): boolean {
  const policy = projectPolicy(db, item.project);
  // The depth cap, under every profile (N02).
  if (item.chain + 1 > policy.max_chained_roles!) return true;
  const passed = (item as WorkRow & { boundary_passed_at?: string | null }).boundary_passed_at ?? null;
  if (passed !== null) return false;
  const profile = autonomyOf(db, item.project);
  if (profile === 'phase') return false;
  if (profile === 'step') return item.chain >= 1;
  // `stage`: the first stage's Builder starts; every later stage start
  // waits for the owner once a stage's chain has run in this project.
  if (!STAGE_START.includes(item.kind)) return false;
  // A stage that depends on another is that stage's next stage: its
  // dependency's chain has begun (its Builder ran, for its stage code to be
  // integrated), whether or not that run has recorded its end. Under D6 K1
  // and K2 the dependent stage is eligible, and dispatched, as soon as the
  // integration is finalized, which is before the Builder's run.ended (M436
  // (b)). Independent stages are neither's next stage (SEAM.md §429).
  if (item.kind === 'stage_build') {
    const stage = (JSON.parse(item.subject) as { stage?: string }).stage;
    const deps = stage ? (db.prepare('SELECT "depends_on" FROM "stages" WHERE "id" = ?').get(stage) as { depends_on: string | null } | undefined) : undefined;
    const ids = deps?.depends_on ? (JSON.parse(deps.depends_on) as string[]) : [];
    const begun = ids.some((dep) =>
      db.prepare(`SELECT 1 FROM "stages" s JOIN "runs" r ON r."work_item" = s."work_item" WHERE s."id" = ? LIMIT 1`).get(dep) !== undefined,
    );
    if (begun) return true;
  }
  const ran = db
    .prepare(
      `SELECT 1 FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item"
       WHERE r."project" = ? AND r."state" = 'ended' AND w."kind" IN ('stage_build', 'fix', 'verification', 'review', 'conformance') AND w."id" <> ? LIMIT 1`,
    )
    .get(item.project, item.id);
  return ran !== undefined;
}
