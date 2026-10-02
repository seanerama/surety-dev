// The store's side of the effects of consumed decisions (D1 §10.5; SEAM.md
// §§76, 78, 79): what the main thread reads to make an effect, and the
// transitions that begin and finish one. Each beginning revalidates the
// intent's preconditions first; an intent whose preconditions changed is
// invalidated there (queue.ts) and nothing is begun.

import { notFound } from './common.js';
import { intendCommit } from './accept.js';
import type { IntentResult, IntentSpec } from './journal.js';
import { type PolicyCommit, intendPolicyCommit, policyFacts } from './project.js';
import { completeIntent } from './protected.js';
import { type Facts, revalidateIntent } from './queue.js';
import { nextCounter, projectRepoRow } from './repo.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export function intentRow(db: Db, args: { intent: string }) {
  const row = db.prepare('SELECT * FROM "effect_intents" WHERE "id" = ?').get(args.intent) as
    | { id: string; project: string; decision: string; status: string; kind: string; plan: string; operation: string | null }
    | undefined;
  return row ? { ...row, plan: JSON.parse(row.plan) as Record<string, unknown> } : null;
}

// What the tick's effects step takes on: intents pending or executing, and
// proposals a Reviewer approved that no application has begun for.
export function effectsDue(db: Db, args: { project: string }): { intents: string[]; proposals: string[] } {
  const intents = (db.prepare(`SELECT "id" FROM "effect_intents" WHERE "project" = ? AND "status" IN ('pending', 'executing') ORDER BY "created_at"`).all(args.project) as { id: string }[]).map((r) => r.id);
  const proposals = (
    db
      .prepare(
        `SELECT p."id" FROM "protected_proposals" p WHERE p."project" = ? AND p."status" = 'approved' AND p."approver_authority" = 'reviewer'
         AND NOT EXISTS (SELECT 1 FROM "protected_versions" v WHERE v."proposal" = p."id") ORDER BY p."seq"`,
      )
      .all(args.project) as { id: string }[]
  ).map((r) => r.id);
  return { intents, proposals };
}

export function revalidate(tx: Tx, args: { intent: string; facts: Facts }): boolean {
  return revalidateIntent(tx, args.intent, args.facts);
}

const markExecuting = (tx: Tx, intent: string, project: string, operation: string, kind: string) => {
  tx.db.prepare(`UPDATE "effect_intents" SET "status" = 'executing', "operation" = ? WHERE "id" = ? AND "status" = 'pending'`).run(operation, intent);
  tx.emit('intent.executing', { project, intent, operation }, { kind });
};

// A widening's effect begins: its commit and the ref update whose finalizer
// records the policy revision with `widens_authority`, on the base it was
// bound to (SEAM.md §78).
export function beginWidening(tx: Tx, args: { intent: string; project: string; prepared: PolicyCommit }): IntentResult | null {
  if (!revalidateIntent(tx, args.intent, {})) return null;
  const facts = policyFacts(tx, { project: args.project });
  // The branch moved under the prepared commit for another reason: begun at
  // a later tick, against what is there then.
  if (facts.head !== args.prepared.head || (facts.revision ?? 0) + 1 !== args.prepared.revision) return null;
  const intent = tx.db.prepare('SELECT "decision" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { decision: string };
  const made = intendPolicyCommit(tx, { project: args.project, repo: facts.repo, branch: facts.branch, prepared: args.prepared, widens: true, decision: intent.decision, intent: args.intent });
  if ('operation' in made) markExecuting(tx, args.intent, args.project, made.operation, 'policy_widening');
  return made;
}

export function stashFacts(tx: Tx, args: { intent: string }): { repo: string; path: string; baseline: { head: string } } | null {
  const intent = tx.db.prepare('SELECT * FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { project: string; plan: string } | undefined;
  if (!intent) throw notFound('intent', args.intent);
  const plan = JSON.parse(intent.plan) as { checkout: string };
  const c = tx.db.prepare('SELECT "path", "baseline" FROM "managed_checkouts" WHERE "id" = ?').get(plan.checkout) as { path: string; baseline: string } | undefined;
  if (!c) return null;
  return { repo: projectRepoRow(tx, intent.project).dev_repo_path, path: c.path, baseline: JSON.parse(c.baseline) as { head: string } };
}

// A stash begins (SEAM.md §79): what the checkout holds now is compared with
// what the preview showed; the commit of its tracked content, and the oob ref
// that keeps it, are journaled.
export function beginStash(
  tx: Tx,
  args: { intent: string; facts: Facts; repo: string; tree: string; parent: string; sha: string; content: string; deadlineSeconds: number },
): IntentResult | null {
  if (!revalidateIntent(tx, args.intent, args.facts)) return null;
  const intent = tx.db.prepare('SELECT * FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { project: string; plan: string };
  const plan = JSON.parse(intent.plan) as { observation: string };
  const ref = `refs/surety/oob/${nextCounter(tx, intent.project, 'oob')}`;
  const follow: IntentSpec = {
    project: intent.project,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: null, new_oid: args.sha },
    target: { repo: args.repo, ref },
    subject: { out_of_band_change: plan.observation, stash: args.sha },
    finalizer: { purpose: 'oob_stash', ref, ref_kind: 'oob', new_oid: args.sha, oob: plan.observation, intent: args.intent },
    deadlineSeconds: args.deadlineSeconds,
  };
  const made = intendCommit(tx, {
    project: intent.project,
    repo: args.repo,
    purpose: 'stash',
    tree: args.tree,
    parent: args.parent,
    sha: args.sha,
    content: args.content,
    revisionKind: 'out_of_band',
    follow,
    deadlineSeconds: args.deadlineSeconds,
    extra: { intent: args.intent },
  });
  if ('operation' in made) markExecuting(tx, args.intent, intent.project, made.operation, 'oob_stash');
  return made;
}

// Is the stash kept under its oob ref (its ref update finalized)?
export function stashKept(db: Db, args: { intent: string }): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id"
       WHERE json_extract(o."finalizer_inputs", '$.purpose') = 'oob_stash' AND json_extract(o."finalizer_inputs", '$.intent') = ? AND s."state" = 'finalized'`,
    )
    .get(args.intent);
  const intent = db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
  return row !== undefined && intent?.status === 'executing';
}

// The checkout is back at its baseline: the observation is reconciled and the
// intent done.
export function stashed(tx: Tx, args: { intent: string }): void {
  const intent = tx.db.prepare('SELECT * FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { project: string; plan: string; status: string };
  if (intent.status !== 'executing') return;
  const plan = JSON.parse(intent.plan) as { observation: string; checkout: string };
  tx.db.prepare(`UPDATE "out_of_band_changes" SET "disposition" = 'stash' WHERE "id" = ? AND "disposition" IS NULL`).run(plan.observation);
  tx.emit('repo.reconciled', { project: intent.project, out_of_band_change: plan.observation }, { disposition: 'stash', checkout: plan.checkout });
  completeIntent(tx, args.intent);
}
