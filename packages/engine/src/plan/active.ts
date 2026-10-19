// The active stages of a plan generation (D6 §5.7; B08): its own, and those
// an earlier generation it replaced kept or retained, under their ids and on
// their own plan rows, none cancelled or superseded. A read with no imports,
// for every reader of a generation's stages (the review's M1).

import type { Database } from 'better-sqlite3';

export const ACTIVE_STAGES = `WITH RECURSIVE "gen"("id") AS (SELECT ? UNION SELECT p."id" FROM "phase_plans" p JOIN "gen" g ON p."replaced_by" = g."id")
  SELECT s.* FROM "stages" s JOIN "gen" g ON s."phase_plan" = g."id" WHERE s."cancelled_at" IS NULL`;

export const activeStages = <T = Record<string, unknown>>(db: Database, plan: string): T[] => db.prepare(`${ACTIVE_STAGES} ORDER BY s."number"`).all(plan) as T[];

// A stage row's `depends_on` as the plan schema (B.5) and every agent reads
// it: stage numbers. The row holds the stage ids registerPlan resolved them
// to; each id is read back to its stage's number (a kept stage's on its own
// earlier row included), a number is taken as it is. An entry that resolves
// to no stage is left as stored, never dropped: unknown, not "no
// dependency".
export function dependsOnNumbers(db: Database, stored: unknown): (number | unknown)[] {
  return dependsOnEntries(stored).map((d) => {
    if (typeof d === 'number') return d;
    if (typeof d !== 'string') return d;
    const row = db.prepare('SELECT "number" FROM "stages" WHERE "id" = ?').get(d) as { number: number } | undefined;
    return row ? row.number : d;
  });
}

// A stage row's `depends_on` entries as stored, one per entry: JSON that
// does not parse is one entry, the text as stored; null or absent is none.
export function dependsOnEntries(stored: unknown): unknown[] {
  let deps: unknown = stored;
  if (typeof stored === 'string') {
    try {
      deps = JSON.parse(stored);
    } catch {
      return [stored];
    }
  }
  if (!Array.isArray(deps)) return deps === null || deps === undefined ? [] : [deps];
  return deps;
}
