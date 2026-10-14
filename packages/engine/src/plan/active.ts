// The active stages of a plan generation (D6 §5.7; B08): its own, and those
// an earlier generation it replaced kept or retained, under their ids and on
// their own plan rows, none cancelled or superseded. A read with no imports,
// for every reader of a generation's stages (the review's M1).

import type { Database } from 'better-sqlite3';

export const ACTIVE_STAGES = `WITH RECURSIVE "gen"("id") AS (SELECT ? UNION SELECT p."id" FROM "phase_plans" p JOIN "gen" g ON p."replaced_by" = g."id")
  SELECT s.* FROM "stages" s JOIN "gen" g ON s."phase_plan" = g."id" WHERE s."cancelled_at" IS NULL`;

export const activeStages = <T = Record<string, unknown>>(db: Database, plan: string): T[] => db.prepare(`${ACTIVE_STAGES} ORDER BY s."number"`).all(plan) as T[];
