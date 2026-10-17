// The stage-to-screen binding (D7 §8.1; A.3 stage_screens; SEAM.md §513):
// a UI stage's screens are the approved screens, of the targets its `ui`
// modules serve, that name a requirement the stage implements; or, when its
// plan named `screens` (B.5, G6), those of them the approved design holds.
// Computed at a design's approval for the published plans and at each
// publication for the stages it publishes, so the first plan, published
// before any design existed, needs no Architect re-entry. Keyed (stage,
// screen, design revision): recomputing records nothing twice.

import type Database from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import { approvedModuleMap, stageModuleNames, stageRequirementKeys } from './policy.js';

type Db = Database.Database;

export interface ApprovedScreen {
  key: string;
  target: string;
  requirements: string[];
}

// The latest approved design revision of a project (by insertion), or null.
export function approvedRevisionId(db: Db, project: string): string | null {
  return (
    (db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as { id: string } | undefined)?.id ?? null
  );
}

// The one revision rule (D7 §7.5, §8.2, §9.1; the slice-44 review's B1):
// the design in force is the latest approved revision (by insertion), and
// its `ready_at` is the design_ready milestone; holds, the stage-to-screen
// binding and design_due read it. Staleness marks it and every approved
// revision back to the latest ready one (which an approval not yet ready
// supersedes), so no revision a stage could be released against is left
// fresh.
export interface DesignInForce {
  current: { id: string; ready_at: string | null } | null;
  stale_scope: string[];
}
export function designInForce(db: Db, project: string): DesignInForce {
  const current =
    (db.prepare(`SELECT "id", "ready_at" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as
      | { id: string; ready_at: string | null }
      | undefined) ?? null;
  const ready = db.prepare(`SELECT rowid AS "r", "id" FROM "design_revisions" WHERE "project" = ? AND "ready_at" IS NOT NULL AND "status" NOT IN ('proposed', 'rejected') ORDER BY rowid DESC LIMIT 1`).get(project) as
    | { r: number; id: string }
    | undefined;
  const later = ready
    ? (db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND rowid > ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid`).all(project, ready.r) as { id: string }[]).map((r) => r.id)
    : [];
  const scope = [...new Set([...(ready ? [ready.id] : []), ...later, ...(current ? [current.id] : [])])];
  return { current, stale_scope: scope };
}

// The approved design's screens (null: no design approved yet).
export function approvedDesignScreens(db: Db, project: string): ApprovedScreen[] | null {
  const rev = approvedRevisionId(db, project);
  if (rev === null) return null;
  return (db.prepare('SELECT "key", "target", "requirements" FROM "design_screens" WHERE "design_revision" = ? ORDER BY "key"').all(rev) as { key: string; target: string; requirements: string }[]).map((s) => ({
    key: s.key,
    target: s.target,
    requirements: parseJson<string[]>(s.requirements) ?? [],
  }));
}

// Bind `stages` (ids; every published stage of the project when omitted) to
// the screens of design revision `revision` (the approved one when omitted).
// Returns the rows written.
export function bindStageScreensTo(tx: Tx, args: { project: string; revision?: string; stages?: string[] }): number {
  const revision = args.revision ?? approvedRevisionId(tx.db, args.project);
  if (revision === null) return 0;
  const screens = (tx.db.prepare('SELECT "key", "target", "requirements" FROM "design_screens" WHERE "design_revision" = ? ORDER BY "key"').all(revision) as { key: string; target: string; requirements: string }[]).map((s) => ({
    key: s.key,
    target: s.target,
    requirements: parseJson<string[]>(s.requirements) ?? [],
  }));
  const map = approvedModuleMap(tx.db, args.project)?.map ?? null;
  const rows = (
    args.stages
      ? args.stages.map((id) => tx.db.prepare('SELECT "id", "modules", "implements", "screens" FROM "stages" WHERE "id" = ?').get(id))
      : tx.db
          .prepare(
            `SELECT s."id", s."modules", s."implements", s."screens" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan"
             WHERE s."project" = ? AND p."active" = 1 AND p."status" IN ('published', 'completed') AND s."cancelled_at" IS NULL ORDER BY p."phase_number", s."number"`,
          )
          .all(args.project)
  ).filter((r): r is { id: string; modules: string; implements: string; screens: string | null } => r !== undefined);
  let n = 0;
  for (const st of rows) {
    const modules = stageModuleNames(tx.db, args.project, st.modules);
    const targets = new Set((map?.modules ?? []).filter((m) => m.surface === 'ui' && modules.includes(m.name)).flatMap((m) => (m.targets ?? []).map((t) => t.target)));
    if (targets.size === 0) continue;
    // The plan's named screens and the computed ones, together (the review's
    // S6): naming fewer, or none, never unbinds a screen the stage needs.
    const named = parseJson<string[]>(st.screens) ?? [];
    const reqs = new Set(stageRequirementKeys(tx.db, args.project, st.implements));
    const bound = screens.filter((s) => targets.has(s.target) && (named.includes(s.key) || s.requirements.some((r) => reqs.has(r))));
    for (const s of bound) {
      n += tx.db.prepare('INSERT OR IGNORE INTO "stage_screens" ("id", "created_at", "stage", "screen", "target", "design_revision") VALUES (?, ?, ?, ?, ?, ?)').run(tx.newId('sscr_'), tx.at, st.id, s.key, s.target, revision).changes;
    }
  }
  return n;
}
