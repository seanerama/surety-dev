// The design's human tests as a phase plan holds them (E156 Q3; D7 §7.4):
// each per-target human-only requirement the design approval assigned to the
// phase holding its target's last UI stage, bound to that stage of the plan
// version it was assigned against. A bound requirement is planned (the phase
// gate's PLAN_REQUIREMENT_UNPLANNED does not name it); one whose binding no
// longer holds (its stage replaced) is named again, never silently passed.

import type Database from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';

export function designBoundHumanTests(db: Database.Database, project: string, _planId: string, activeStages: Set<string>): string[] {
  const rev = db
    .prepare(`SELECT "assignments" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') AND "assignments" IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { assignments: string } | undefined;
  const assignments = parseJson<{ requirement: string | null; phase: number | null; stage?: string; phase_plan?: string }[]>(rev?.assignments ?? null) ?? [];
  return assignments.filter((a) => a.requirement !== null && a.phase !== null && a.stage !== undefined && activeStages.has(a.stage)).map((a) => a.requirement!);
}
