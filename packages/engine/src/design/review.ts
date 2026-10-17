// The design review (D7 §10; G13; Q4; SEAM.md §489): the review's record at
// a review-mode session's close, its verdicts proposals only; the
// `design_verdicts` question that alone makes them the owner's.

import type { Tx } from '../store/transitions/tx.js';

export interface ReviewArgs {
  project: string;
  run: string;
  design_revision: string | null;
  trigger: 'alpha_complete' | 'owner_command';
  subject: Record<string, unknown>;
  review_blob: string | null;
  verdicts: Record<string, unknown>[];
}

export function recordReview(tx: Tx, args: ReviewArgs): { review: string; decision: string | null } {
  const id = tx.newId('drv_');
  tx.db
    .prepare(`INSERT INTO "design_reviews" ("id", "created_at", "project", "design_revision", "run", "trigger", "subject", "review_blob", "verdicts") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tx.at, args.project, args.design_revision, args.run, args.trigger, JSON.stringify(args.subject), args.review_blob, JSON.stringify(args.verdicts));
  tx.emit('design.review_recorded', { project: args.project, design_review: id }, { trigger: args.trigger, verdicts: args.verdicts.length });
  return { review: id, decision: null };
}
