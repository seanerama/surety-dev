// The effect of `spec_approval`'s `approve` (D6 §3.4; the coordinator's
// ruling on slice 34's question 2): TPL §11's change log row appended by the
// engine to the approved text in one journaled engine commit on the
// integration branch, whose finalizer is the approval (spec/approval.ts
// approveSpec) with `spec_revisions.git_blob` the committed blob. The
// decision's manifest binds the saved blob and semantics and is checked when
// it is answered and again when the effect begins (D1 §10.5); a precondition
// that moved invalidates the intent and asks the owner again.

import { intendCommit } from '../store/transitions/accept.js';
import { type IntentResult } from '../store/transitions/journal.js';
import { completeIntent } from '../store/transitions/protected.js';
import { invalidateIntent, revalidateIntent } from '../store/transitions/queue.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import type { Tx } from '../store/transitions/tx.js';
import { illegal } from '../store/transitions/common.js';
import { approveSpec, latestSemantics } from './approval.js';
import { briefApproved } from '../prototype/brief.js';

export interface ApprovalFacts {
  intent: string;
  status: string;
  project: string;
  repo: string;
  ref: string;
  head: string | null;
  run: string;
  decision: string;
  // The saved specification's blob, which the row is appended to.
  blob: string | null;
  // The version the approval allocates.
  version: number;
  // Who answered, as the decision's answer records it; null when it cannot
  // be read (the effect then fails closed, the review's N3 (a)).
  approved_by: string | null;
}

export function approvalFacts(tx: Tx, args: { intent: string }): ApprovalFacts | null {
  const row = tx.db.prepare('SELECT "id", "project", "status", "plan", "decision" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { id: string; project: string; status: string; plan: string; decision: string } | undefined;
  if (!row) return null;
  const plan = JSON.parse(row.plan) as { run: string };
  const p = projectRepoRow(tx, row.project);
  const ref = integrationRef(p.integration_branch);
  const latest = (tx.db.prepare('SELECT "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(row.project) as { version: number } | undefined)?.version ?? 0;
  const d = tx.db.prepare('SELECT "answer" FROM "decisions" WHERE "id" = ?').get(row.decision) as { answer: string | null } | undefined;
  let actor: string | null = null;
  try {
    const a = (JSON.parse(d?.answer ?? 'null') as { actor?: unknown } | null)?.actor;
    actor = typeof a === 'string' && a.length > 0 ? a : null;
  } catch {
    actor = null;
  }
  return {
    intent: row.id,
    status: row.status,
    project: row.project,
    repo: p.dev_repo_path,
    ref,
    head: registryRow(tx, row.project, ref)?.expected_oid ?? null,
    run: plan.run,
    decision: row.decision,
    blob: latestSemantics(tx.db, plan.run)?.git_blob ?? null,
    version: latest + 1,
    approved_by: actor,
  };
}

// What cannot be prepared as approved: the intent invalidated, the question
// asked again (never a silent retry).
export function refuseApproval(tx: Tx, args: { intent: string; reason: string }): boolean {
  const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
  if (!row || row.status !== 'pending') return false;
  invalidateIntent(tx, args.intent, [args.reason]);
  return true;
}

export interface ApprovedInputs {
  purpose: 'spec_approved';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  run: string;
  decision: string;
  intent: string;
  blob: string;
}

// The effect begins: its preconditions read again; then the commit with the
// row, on the head the decision was answered at, and the branch moved to it.
export function beginApproval(tx: Tx, args: { intent: string; head: string; commit: { sha: string; tree: string; content: string }; blob: string; deadlineSeconds: number }): IntentResult | null {
  if (!revalidateIntent(tx, args.intent, {})) return null;
  const facts = approvalFacts(tx, { intent: args.intent });
  if (!facts) return null;
  if (facts.head !== args.head) return null;
  const follow = {
    project: facts.project,
    kind: 'ref_update' as const,
    payload: { repo: facts.repo, ref: facts.ref, old_oid: args.head, new_oid: args.commit.sha },
    target: { repo: facts.repo, ref: facts.ref },
    subject: { spec_approval: facts.decision, old_oid: args.head, new_oid: args.commit.sha },
    finalizer: { purpose: 'spec_approved', ref: facts.ref, ref_kind: 'integration', new_oid: args.commit.sha, run: facts.run, decision: facts.decision, intent: args.intent, blob: args.blob } satisfies ApprovedInputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
  };
  const made = intendCommit(tx, {
    project: facts.project,
    repo: facts.repo,
    purpose: 'spec',
    tree: args.commit.tree,
    parent: args.head,
    sha: args.commit.sha,
    content: args.commit.content,
    revisionKind: 'engine_commit',
    follow,
    deadlineSeconds: args.deadlineSeconds,
    extra: { intent: args.intent },
  });
  if ('operation' in made) {
    tx.db.prepare(`UPDATE "effect_intents" SET "status" = 'executing', "operation" = ? WHERE "id" = ? AND "status" = 'pending'`).run(made.operation, args.intent);
    tx.emit('intent.executing', { project: facts.project, intent: args.intent, operation: made.operation }, { kind: 'spec_approval_application' });
  }
  return made;
}

// The approval itself, in the finalizer of the branch's move: once.
export function finalizeApproved(tx: Tx, op: { id: string; project: string }, inputs: ApprovedInputs): Record<string, unknown> {
  const intent = tx.db.prepare('SELECT "decision" FROM "effect_intents" WHERE "id" = ?').get(inputs.intent) as { decision: string } | undefined;
  if (!intent) throw illegal('approving a specification with no intent', { intent: inputs.intent });
  const made = approveSpec(tx, { project: op.project, run: inputs.run, decision: inputs.decision, via: 'session', blob: inputs.blob });
  completeIntent(tx, inputs.intent);
  // A rapid prototype's brief (slice E3; R1): the iteration building, its
  // first plan asked of the Architect. Nothing for any other run.
  briefApproved(tx, { project: op.project, run: inputs.run, decision: inputs.decision, spec_revision: made.spec_revision });
  return { spec_revision: made.spec_revision, version: made.version };
}
