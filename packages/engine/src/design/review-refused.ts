// A review that ends without being recorded (H5; E166 item 4, E171 item 5;
// SEAM.md §552). A review-mode Designer session closed with `refuse`, or
// closed by protocol (idle timeout, spent budget) raising nothing, leaves no
// review file where the design check and the review-recording step read one:
// before the session closes, the engine moves each unrecorded
// `.surety/design/reviews/review-<n>.json` of the head to
// `.surety/design/reviews/refused/<run>-review-<n>.json`, the blob unchanged,
// by one engine `intent` commit naming the run, and emits one
// `design.review_refused` per file moved. `reviews/refused/` is the engine's:
// the design check and the recording skip it, and a Designer save writing
// under it is refused `diff_violation` (git/snapshot.ts). The history stays:
// the blob at its new path, the move commit, the event.
//
// Here: the moves a head calls for (pure), the intent (the commit with the
// branch's move to it as its follow-on, on the head the main thread read)
// and its finalizer. The main thread's part is design/review-driver.ts.

import { intendCommit } from '../store/transitions/accept.js';
import { REFUSED_REVIEWS_DIR } from './paths.js';
import type { IntentResult } from '../store/transitions/journal.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import type { Tx } from '../store/transitions/tx.js';

const REVIEW_FILE = /^\.surety\/design\/reviews\/(review-[0-9]+\.json)$/;

export interface ReviewMove {
  from: string;
  to: string;
  blob: string;
  mode: string;
}

// The moves a head's tree calls for at the end of `run`: each review file
// directly under `reviews/` whose blob no recorded review holds, to
// `reviews/refused/<run>-<its name>`, in the order of their paths.
export function refusedMoves(entries: Iterable<{ path: string; oid: string; type: string; mode: string }>, recorded: readonly string[], run: string): ReviewMove[] {
  const held = new Set(recorded);
  const moves: ReviewMove[] = [];
  for (const e of entries) {
    if (e.type !== 'blob') continue;
    const m = REVIEW_FILE.exec(e.path);
    if (!m || held.has(e.oid)) continue;
    moves.push({ from: e.path, to: `${REFUSED_REVIEWS_DIR}${run}-${m[1]}`, blob: e.oid, mode: e.mode });
  }
  return moves.sort((a, b) => a.from.localeCompare(b.from));
}

export interface ReviewRefusedRefInputs {
  purpose: 'design_review_refused';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  project: string;
  run: string;
  moves: ReviewMove[];
}

// The engine's intent commit of the move, with the branch's move to it as
// its follow-on, on the head the main thread read; fenced if it moved.
export function intendReviewRefused(
  tx: Tx,
  a: { project: string; repo: string; run: string; head: string; commit: { sha: string; tree: string; content: string }; moves: ReviewMove[]; deadlineSeconds: number },
): IntentResult {
  const p = projectRepoRow(tx, a.project);
  const ref = integrationRef(p.integration_branch);
  if (registryRow(tx, a.project, ref)?.expected_oid !== a.head) return { fenced: true };
  const finalizer: ReviewRefusedRefInputs = { purpose: 'design_review_refused', ref, ref_kind: 'integration', new_oid: a.commit.sha, project: a.project, run: a.run, moves: a.moves };
  return intendCommit(tx, {
    project: a.project,
    repo: a.repo,
    purpose: 'design',
    tree: a.commit.tree,
    parent: a.head,
    sha: a.commit.sha,
    content: a.commit.content,
    revisionKind: 'intent',
    follow: {
      project: a.project,
      kind: 'ref_update',
      payload: { repo: a.repo, ref, old_oid: a.head, new_oid: a.commit.sha },
      target: { repo: a.repo, ref },
      subject: { design_review_refused: a.run, old_oid: a.head, new_oid: a.commit.sha },
      finalizer: finalizer as unknown as Record<string, unknown>,
      deadlineSeconds: a.deadlineSeconds,
    },
    deadlineSeconds: a.deadlineSeconds,
  });
}

// The branch moved: one `design.review_refused` per file moved, naming the
// run, the old path, the blob and the new path.
export function finalizeReviewRefused(tx: Tx, op: { id: string; project: string }, inputs: ReviewRefusedRefInputs): Record<string, unknown> {
  for (const m of inputs.moves) {
    tx.emit('design.review_refused', { project: op.project, run: inputs.run }, { run: inputs.run, path: m.from, blob: m.blob, moved_to: m.to, revision: inputs.new_oid });
  }
  return { design_review_refused: inputs.run, moved: inputs.moves.length };
}
