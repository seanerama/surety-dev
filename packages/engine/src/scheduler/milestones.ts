// The two milestones of stage work (D6 §6.4; B07, B08; SEAM.md §427): the
// phase's authoring readiness and the stage-code readiness of each stage it
// depends on. each milestone is noted as it is met, and
// `work.dependency_met` is recorded once per item, when the last of its
// milestones is met (D6 §7.6: eligible when both are), in the transaction
// that meets it (readiness applied or excepted, a stage's
// integration finalized, a plan published with a milestone already met), so
// the pace read measures eligibility from the moment it occurred (D6 §7.6).
// A stage-code milestone is met only while the depended-on stage's active
// generation is integrated and neither cancelled nor parked: a parked
// stage's historical integration meets nothing (B08).

import { milestoneUnmet } from '../store/transitions/runs.js';
import type { Tx } from '../store/transitions/tx.js';
import type { Milestone } from '../store/transitions/work.js';

const keyOf = (m: Milestone): string | null => (m.milestone === 'authoring_ready' ? 'authoring_ready' : m.milestone === 'stage_code' ? `stage_code:${m.stage}` : null);

export function recordMetMilestones(tx: Tx, project: string): number {
  const items = tx.db
    .prepare(`SELECT "id", "depends_on", "milestones_met" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' AND "status" NOT IN ('complete', 'cancelled') ORDER BY "seq"`)
    .all(project) as { id: string; depends_on: string | null; milestones_met: string | null }[];
  let n = 0;
  for (const item of items) {
    let deps: Milestone[] = [];
    let met: string[] = [];
    try {
      deps = (JSON.parse(item.depends_on ?? '[]') as unknown[]).filter((d): d is Milestone => typeof d === 'object' && d !== null && keyOf(d as Milestone) !== null);
      met = item.milestones_met ? (JSON.parse(item.milestones_met) as string[]) : [];
    } catch {
      continue;
    }
    if (deps.length === 0 || met.includes('eligible')) continue;
    // Each milestone as it is met; the event once all are (D6 §7.6: the
    // item is eligible when both milestones are met), naming the one whose
    // meeting completed them.
    const now: Milestone[] = [];
    for (const m of deps) {
      const key = keyOf(m)!;
      if (met.includes(key)) continue;
      if (milestoneUnmet(tx.db, m) !== null) continue;
      met.push(key);
      now.push(m);
    }
    if (now.length === 0) continue;
    const complete = deps.every((m) => met.includes(keyOf(m)!));
    if (complete) {
      met.push('eligible');
      const last = now[now.length - 1]!;
      tx.emit(
        'work.dependency_met',
        { project, work_item: item.id },
        {
          ...(last.milestone === 'stage_code' ? { milestone: 'stage_code', stage: last.stage } : { milestone: 'authoring_ready', phase_plan: (last as { phase_plan: string }).phase_plan }),
          milestones: deps.map((m) => keyOf(m)),
        },
      );
      n++;
    }
    tx.db.prepare('UPDATE "work_items" SET "milestones_met" = ? WHERE "id" = ?').run(JSON.stringify(met), item.id);
  }
  return n;
}
