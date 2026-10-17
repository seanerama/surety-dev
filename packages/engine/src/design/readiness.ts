// The third milestone (D7 §8.2; G6; SEAM.md §485): a UI stage's
// `stage_build` under `before_build` or `both` depends on `design_ready`,
// which is met once an approved design is ready (§7.5: approved, and the
// protected version covering its criteria applied, or approved without
// criteria). Unmet, the item is held `design_pending` (no ready design) or
// `design_stale` (its screens stale, §9). Asset status takes no part (§6.7).
// A waived stage (D7 §11 `waive`) and a project whose policy no longer holds
// before build are released. Pure reads.

import type { Database } from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import { designPolicyOf, holdsBeforeBuild } from './policy.js';
import { designInForce } from './stage-screens.js';

export interface DesignDueState {
  stage?: 'before_build' | 'revise' | 'alpha_review';
  note?: string;
  waived?: string[];
  // The review's subject at alpha_review (the Alpha's candidate and deployment).
  review?: Record<string, unknown>;
  // The interface inventory's commit failing, attempt after attempt (the
  // slice-40 review's m6): design_due names it rather than holding silently.
  inventory_failure?: { count: number; reason: string; at: string };
  // `open` answered (D7 §11): the design_due whose answer asked for a
  // Designer session, until the design driver has allocated it.
  open_requested?: string;
  open_mode?: 'review';
  // An `open` the design driver could not carry out, and why (the review's S2).
  open_refused?: { decision: string; reason: string; at: string };
  // A `later` answer (D7 §11; the review's S1): until when, by which
  // decision, and what it was answered on, so a new cause ends it at once.
  deferred?: { until: string; decision: string; held: string[]; stale: string[]; stage: string; rejected: number };
  // A batch refused at raise (D7 §7.4; SEAM.md §519): what differs between
  // the proposed specification's inventory and the design's.
  inventory_difference?: Record<string, unknown>;
}

export function designDueState(db: Database, project: string): DesignDueState {
  const row = db.prepare('SELECT "design_due" FROM "projects" WHERE "id" = ?').get(project) as { design_due: string | null } | undefined;
  return parseJson<DesignDueState>(row?.design_due ?? null) ?? {};
}

// The latest ready design revision of a project (by insertion), or null.
export function readyRevision(db: Database, project: string): { id: string; ready_at: string } | null {
  return (
    (db
      .prepare(`SELECT "id", "ready_at" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') AND "ready_at" IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
      .get(project) as { id: string; ready_at: string } | undefined) ?? null
  );
}

// Why `stage`'s design_ready milestone is unmet ('design_pending' or
// 'design_stale'), or null when it is met.
export function designUnmet(db: Database, stage: string): 'design_pending' | 'design_stale' | null {
  const s = db.prepare('SELECT "project" FROM "stages" WHERE "id" = ?').get(stage) as { project: string } | undefined;
  if (!s) return 'design_pending';
  if (!holdsBeforeBuild(designPolicyOf(db, s.project))) return null;
  if ((designDueState(db, s.project).waived ?? []).includes(stage)) return null;
  // The design in force (one rule for holds, bindings, staleness and
  // design_due): approved and ready, else pending.
  const { current } = designInForce(db, s.project);
  if (!current || current.ready_at === null) return 'design_pending';
  // A screen of that revision bound to this stage and stale (§9).
  const stale = db
    .prepare(`SELECT 1 FROM "stage_screens" b JOIN "design_screens" d ON d."design_revision" = b."design_revision" AND d."key" = b."screen" WHERE b."stage" = ? AND b."design_revision" = ? AND d."status" = 'stale' LIMIT 1`)
    .get(stage, current.id);
  return stale ? 'design_stale' : null;
}

// The UI stages whose design_ready milestone is unmet now: their
// stage_build items not complete or cancelled.
export function heldStages(db: Database, project: string): string[] {
  const items = db
    .prepare(`SELECT "subject", "depends_on" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' AND "status" NOT IN ('complete', 'cancelled') ORDER BY "seq"`)
    .all(project) as { subject: string; depends_on: string | null }[];
  const out: string[] = [];
  for (const it of items) {
    const deps = parseJson<{ milestone?: string; stage?: string }[]>(it.depends_on) ?? [];
    const d = deps.find((x) => typeof x === 'object' && x !== null && x.milestone === 'design_ready');
    if (!d) continue;
    const stage = d.stage ?? parseJson<{ stage?: string }>(it.subject)?.stage;
    if (typeof stage !== 'string') continue;
    if (designUnmet(db, stage) !== null) out.push(stage);
  }
  return out;
}
