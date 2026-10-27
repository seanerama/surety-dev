// Project transitions: creation, pause and resume (D1 §8.4, §11.4), and the
// project policy command, whose valid changes commit through the journaled
// git path that slice 3 builds.

import { newId } from '../../ids.js';
import { Refusal } from '../../refusal.js';
import { intendCommit } from './accept.js';
import type { IntentSpec } from './journal.js';
import { journalBlocks } from './journal.js';
import { type Baseline, addCheckout, blockingObservation, integrationRef, openLineage, projectRepoRow, registerRef } from './repo.js';
import { policyRevision, projectEffective } from './settings.js';
import type { Policy } from '../../config/project-policy.js';
import type { CommandResult } from './control.js';
import { type ProtectedSet, captureProposal, recordInitialVersion } from './protected.js';
import { raiseQuestion, widenScope } from './queue.js';
import type { Tx } from './tx.js';

export interface ProjectRow {
  id: string;
  paused: number;
}

export function projectNotFound(project: string): Refusal {
  return new Refusal(404, 'not_found', `No project "${project}" is registered with this engine.`, 'Check the project id.', { project });
}

export function getProject(tx: Tx, project: string): ProjectRow {
  const row = tx.db.prepare('SELECT "id", "paused" FROM "projects" WHERE "id" = ?').get(project) as ProjectRow | undefined;
  if (!row) throw projectNotFound(project);
  return row;
}

export interface NewProject {
  name: string;
  tier: string;
  dev_repo_path: string;
  integration_branch: string;
}

// A project on an existing repository. `label` is added to the payload of
// its project.created event; the fixture installer labels the projects it
// creates as test setup (SEAM.md §7). The integration branch is registered at
// `head`, the project's first lineage opened, and every checkout of the
// integration branch outside the engine recorded as a managed checkout with
// what it holds as its baseline (SEAM.md §§25, 32). Returns the project id.
export function createProject(
  tx: Tx,
  project: NewProject & { id?: string; registration?: 'registered' | 'pending_bootstrap'; head: string; checkouts?: { path: string; baseline: Baseline }[]; protectedSet: ProtectedSet; approvedBy?: string },
  label: Record<string, unknown>,
): string {
  const id = project.id ?? newId('proj_');
  const management = { mode: 'live', health: 'unknown', triage_policy: 'manual' };
  tx.db
    .prepare(
      `INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch",
         "baseline_state", "registration_state", "management", "paused", "seq_counters")
       VALUES (?, ?, ?, ?, ?, ?, 'idea', ?, ?, 0, '{}')`,
    )
    .run(id, tx.at, project.name, project.tier, project.dev_repo_path, project.integration_branch, project.registration ?? 'registered', JSON.stringify(management));
  const { name, tier, dev_repo_path, integration_branch } = project;
  tx.emit('project.created', { project: id }, { ...label, name, tier, dev_repo_path, integration_branch });
  registerRef(tx, { project: id, ref: integrationRef(project.integration_branch), kind: 'integration', expected: project.head });
  openLineage(tx, id);
  for (const c of project.checkouts ?? []) addCheckout(tx, { project: id, kind: 'integration_worktree', path: c.path, baseline: c.baseline, run: null });
  // The project's first protected version (SEAM.md §66).
  recordInitialVersion(tx, id, project.protectedSet, project.approvedBy ?? 'project creation', project.head);
  return id;
}

export interface PreparedCommit {
  tree: string;
  sha: string;
  content: string;
}

// POST /v1/projects (D1 §3.1; SEAM.md §27): the project, pending its
// bootstrap, and the journaled commit that adds .surety/project.json to the
// integration branch, whose finalizer intends the ref update, whose finalizer
// in turn registers the project.
export function bootstrapProject(
  tx: Tx,
  args: { id: string; name: string; tier: string; repo: string; branch: string; head: string; commit: PreparedCommit; deadlineSeconds: number; protectedSet: ProtectedSet; idea?: { blob: string }; initiallyPaused?: boolean },
): { project: { id: string; registration_state: string } } {
  const ref = integrationRef(args.branch);
  createProject(
    tx,
    { id: args.id, name: args.name, tier: args.tier, dev_repo_path: args.repo, integration_branch: args.branch, registration: 'pending_bootstrap', head: args.head, protectedSet: args.protectedSet },
    {},
  );
  const follow: IntentSpec = {
    project: args.id,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: args.head, new_oid: args.commit.sha },
    target: { repo: args.repo, ref },
    subject: { bootstrap: args.id, new_oid: args.commit.sha },
    finalizer: { purpose: 'bootstrap', ref, ref_kind: 'integration', new_oid: args.commit.sha },
    deadlineSeconds: args.deadlineSeconds,
  };
  intendCommit(tx, {
    project: args.id,
    repo: args.repo,
    purpose: 'bootstrap',
    tree: args.commit.tree,
    parent: args.head,
    sha: args.commit.sha,
    content: args.commit.content,
    revisionKind: 'engine_commit',
    follow,
    deadlineSeconds: args.deadlineSeconds,
  });
  // The idea record version 1 (D6 §1 step 1, §3.1; reading 5): the create
  // route's own binding, the owner's, the brief's blob in the bootstrap
  // commit; baseline `idea`.
  if (args.idea) {
    const history = [{ version: 1, blob: args.idea.blob, binding: { kind: 'create', actor: tx.actor.actor_kind }, at: tx.at }];
    tx.db.prepare('UPDATE "projects" SET "idea_version" = 1, "idea_blob" = ?, "idea_history" = ? WHERE "id" = ?').run(args.idea.blob, JSON.stringify(history), args.id);
    tx.emit('baseline.idea_recorded', { project: args.id }, { version: 1, blob: args.idea.blob, actor: tx.actor.actor_kind, commit: args.commit.sha });
  }
  if (args.initiallyPaused) setPaused(tx, { project: args.id, paused: true });
  return { project: { id: args.id, registration_state: 'pending_bootstrap' } };
}
// Pause sets the flag the scheduler's select step skips on; resume clears it.
// Asking for the state the project is already in changes nothing and emits
// nothing.
export function setPaused(tx: Tx, args: { project: string; paused: boolean }) {
  const row = getProject(tx, args.project);
  const want = args.paused ? 1 : 0;
  if (row.paused !== want) {
    tx.db.prepare('UPDATE "projects" SET "paused" = ? WHERE "id" = ?').run(want, args.project);
    tx.emit(args.paused ? 'project.paused' : 'project.resumed', { project: args.project }, {});
  }
  return { project: { id: args.project, paused: args.paused }, events: tx.events.map(({ seq, type }) => ({ seq, type })) };
}

// What a policy change needs to be committed: the effective policy it
// starts from and the integration branch's expected commit.
export function policyFacts(tx: Tx, args: { project: string }) {
  const p = projectRepoRow(tx, args.project);
  const head = tx.db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(args.project, integrationRef(p.integration_branch)) as
    | { expected_oid: string }
    | undefined;
  const blocking = blockingObservation(tx.db, args.project);
  return {
    repo: p.dev_repo_path,
    branch: p.integration_branch,
    head: head?.expected_oid ?? null,
    effective: projectEffective(tx.db, args.project),
    revision: policyRevision(tx.db, args.project),
    blocking: blocking?.subject_kind ?? null,
    journalBlocked: journalBlocks(tx.db, args.project),
  };
}

export function policyRefusal(blocking: string): Refusal {
  return blocking === 'repository'
    ? new Refusal(409, 'repo_unreadable', 'The project repository cannot be read, so the policy cannot be committed.', 'Make the repository readable; nothing was changed.', { subject: 'repository' })
    : new Refusal(
        409,
        'out_of_band_change',
        'The integration branch has an unreconciled out-of-band change, so the policy cannot be committed to it.',
        'Answer the out_of_band_change decision first; nothing was changed.',
        { subject: 'integration_branch' },
      );
}

export interface PolicyCommit {
  head: string;
  revision: number;
  commit: PreparedCommit;
  blob: string;
  effective: Policy;
  change: Policy;
  deadlineSeconds: number;
  // D7 §2, §4.4: the inventory committed with a policy turning design on.
  design_inventory?: { digest: string; inventory: unknown; manifest: unknown; incarnation: string };
}

export interface GovernedEdit {
  head: string;
  tree: string;
  diffHash: string;
  changesRequiredSet: boolean;
  rationale: string;
}

// ---- the owner's policy submissions and their commit (the usability batch
// of 2026-10-27, decision 6; migration 0041) --------------------------------

export interface PolicySubmissionRow {
  id: string;
  created_at: string;
  project: string;
  intent_id: string | null;
  fingerprint: string;
  outcome: 'accepted' | 'unchanged' | 'refused';
  revision: number | null;
  operation: string | null;
  status: number;
  answer: string;
}

export function policySubmissionOf(db: Tx['db'], project: string, intent: string): PolicySubmissionRow | null {
  return (db.prepare('SELECT * FROM "policy_submissions" WHERE "project" = ? AND "intent_id" = ?').get(project, intent) as PolicySubmissionRow | undefined) ?? null;
}

export type PolicyCommitState = { state: 'committed' | 'pending' | 'ambiguous' | 'failed'; committed_at: string | null };

// The commit state of an intended policy revision, from its journal
// operations: its commit of `.surety/policy.json`, then the ref update that
// follows it, whose finalizer records the revision (finalize.ts). `pending`
// until that finalizer has run; `ambiguous` while the journal does not know
// whether an operation took effect (it settles it); `failed` when the
// journal failed or superseded either, so the revision never took effect.
export function policyCommitState(db: Tx['db'], project: string, operation: string): PolicyCommitState {
  const c = db.prepare('SELECT "status", "target" FROM "operations" WHERE "id" = ?').get(operation) as { status: string; target: string } | undefined;
  if (!c) return { state: 'pending', committed_at: null };
  if (c.status === 'failed' || c.status === 'superseded') return { state: 'failed', committed_at: null };
  let sha: string | null = null;
  try {
    sha = (JSON.parse(c.target) as { commit?: string }).commit ?? null;
  } catch {
    sha = null;
  }
  const r = sha === null
    ? undefined
    : (db
        .prepare(
          `SELECT "status", "finalized_at" FROM "operations" WHERE "project" = ? AND "kind" = 'git_ref_update'
           AND json_extract("finalizer_inputs", '$.purpose') = 'policy' AND json_extract("finalizer_inputs", '$.new_oid') = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(project, sha) as { status: string; finalized_at: string | null } | undefined);
  if (!r) return { state: c.status === 'ambiguous' ? 'ambiguous' : 'pending', committed_at: null };
  if (r.status === 'succeeded' && r.finalized_at !== null) return { state: 'committed', committed_at: r.finalized_at };
  if (r.status === 'failed' || r.status === 'superseded') return { state: 'failed', committed_at: null };
  return { state: r.status === 'ambiguous' ? 'ambiguous' : 'pending', committed_at: null };
}

// An answer as it stands now: a stored accepted answer's commit state is
// the current one (its outcome and revision are as answered).
function answerNow(db: Tx['db'], row: PolicySubmissionRow): { status: number; body: Record<string, unknown> } {
  const body = JSON.parse(row.answer) as Record<string, unknown>;
  if (row.outcome === 'accepted' && row.operation !== null) {
    const now = policyCommitState(db, row.project, row.operation);
    body.committed = now.state === 'committed';
    body.commit = { state: now.state, ...(now.committed_at ? { committed_at: now.committed_at } : {}) };
  }
  return { status: row.status, body };
}

function recordSubmission(
  tx: Tx,
  args: { project: string; intent_id: string | null; fingerprint: string | null; outcome: PolicySubmissionRow['outcome']; revision: number | null; operation: string | null; status: number; answer: unknown },
): void {
  if (args.intent_id === null && args.outcome !== 'accepted') return;
  tx.db
    .prepare(
      `INSERT INTO "policy_submissions" ("id", "created_at", "project", "intent_id", "fingerprint", "outcome", "revision", "operation", "status", "answer")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tx.newId('psub_'), tx.at, args.project, args.intent_id, args.fingerprint ?? '', args.outcome, args.revision, args.operation, args.status, JSON.stringify(args.answer));
}

export const policyIntentConflict = (project: string, intent: string): Refusal =>
  new Refusal(409, 'policy_intent_conflict', `The intent ${intent} already names a different policy submission of this project.`, 'Use a new intent_id for a new submission; nothing was changed.', { project, intent_id: intent });

// POST /v1/projects/:p/policy (D1 §§10.1, 11.4; SEAM.md §§27, 66, 78). The
// ungoverned part of a submission is committed through the journal, unless
// it widens what the engine may do unasked: then it is not committed, and a
// policy_widening decision is raised (409 confirm_required). A governed part
// is never applied here: it becomes a protected proposal (202).
//
// The answer states its outcome (decision 6): `accepted` with the revision
// intended and its commit `pending` (the journal commits it and its
// finalizer records it; GET .../policy then reads it `committed`), or
// `unchanged` with nothing to commit; a refusal is a 4xx with its code. A
// submission with an `intent_id` is answered once: a repeat with the same
// body is that answer (its commit state current), never a second revision; a
// different body is 409 policy_intent_conflict.
export function submitPolicy(
  tx: Tx,
  args: { project: string; body: unknown; ordinary: Policy; widens: string[]; governed: GovernedEdit | null; prepared: PolicyCommit | null; intent_id?: string | null; fingerprint?: string | null; repeat?: boolean },
): CommandResult {
  getProject(tx, args.project);
  const intent = args.intent_id ?? null;
  const fingerprint = args.fingerprint ?? null;
  if (intent !== null) {
    const prior = policySubmissionOf(tx.db, args.project, intent);
    if (prior !== null) {
      if (prior.fingerprint !== fingerprint) throw policyIntentConflict(args.project, intent);
      return answerNow(tx.db, prior);
    }
  }
  if (args.repeat === true) {
    throw new Refusal(409, 'illegal_transition', 'The submission this repeats is not recorded.', 'Send the change again.', { project: args.project });
  }
  const facts = policyFacts(tx, { project: args.project });
  let proposal: string | null = null;
  if (args.governed) {
    if (facts.head !== args.governed.head) {
      throw new Refusal(409, 'illegal_transition', 'The integration branch moved while the edit was prepared.', 'Send the change again.', { project: args.project });
    }
    proposal = captureProposal(tx, {
      project: args.project,
      proposedBy: 'human',
      run: null,
      base: args.governed.head,
      tree: args.governed.tree,
      diffHash: args.governed.diffHash,
      rationale: args.governed.rationale,
      requested: 'unclassifiable',
      changesRequiredSet: args.governed.changesRequiredSet,
    }).id;
  }
  if (args.widens.length > 0) {
    const decision = raiseQuestion(tx, {
      project: args.project,
      kind: 'policy_widening',
      subjectType: 'project',
      subjectId: args.project,
      scope: widenScope(args.ordinary),
      options: JSON.stringify([{ key: 'approve', effect_plan: { change: args.ordinary } }]),
    })!;
    const refusal = new Refusal(
      409,
      'confirm_required',
      `The change widens what the engine may do unasked (${args.widens.join(', ')}): it needs confirmation through decision ${decision.id}.`,
      'Answer the decision with its preview hash to commit the change.',
      { decision: decision.id, preview_hash: decision.preview_hash, ...(proposal ? { proposal } : {}) },
    );
    recordSubmission(tx, { project: args.project, intent_id: intent, fingerprint, outcome: 'refused', revision: null, operation: null, status: 409, answer: refusal.body() });
    return { status: 409, body: refusal.body() };
  }
  let revision: number | null = null;
  let operation: string | null = null;
  if (args.prepared) {
    if (facts.blocking) throw policyRefusal(facts.blocking);
    const pr = args.prepared;
    if (facts.head !== pr.head || (facts.revision ?? 0) + 1 !== pr.revision) {
      throw new Refusal(409, 'illegal_transition', 'The project policy or its branch changed while the change was prepared.', 'Send the change again.', { project: args.project });
    }
    const intended = intendPolicyCommit(tx, { project: args.project, repo: facts.repo, branch: facts.branch, prepared: pr, widens: false });
    operation = 'operation' in intended ? intended.operation : null;
    revision = pr.revision;
  }
  const commit = revision !== null ? { committed: false, commit: { state: 'pending' } } : { committed: false, commit: null };
  if (proposal !== null) {
    const body = { outcome: 'accepted', proposal: { id: proposal }, ...(revision !== null ? { revision } : {}), ...commit };
    recordSubmission(tx, { project: args.project, intent_id: intent, fingerprint, outcome: 'accepted', revision, operation, status: 202, answer: body });
    return { status: 202, body, effects: revision !== null ? [{ kind: 'journal', project: args.project }] : [] };
  }
  const outcome = revision !== null ? 'accepted' : 'unchanged';
  const body = { outcome, revision, ...commit };
  recordSubmission(tx, { project: args.project, intent_id: intent, fingerprint, outcome, revision, operation, status: 200, answer: body });
  return { status: 200, body, effects: [{ kind: 'journal', project: args.project }] };
}

// GET /v1/projects/:p/policy's commit part (decision 6): the recorded
// revision's commit time, the accepted submissions not yet committed, and the
// latest submissions with their outcome and commit state, so a client whose
// answer was lost settles it (committed, pending, or absent: never recorded)
// by reading, without submitting again.
export function policyCommitView(db: Tx['db'], project: string) {
  const current = db.prepare('SELECT r."revision", r."changed_at" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?').get(project) as
    | { revision: number; changed_at: string }
    | undefined;
  const rows = db.prepare('SELECT * FROM "policy_submissions" WHERE "project" = ? ORDER BY rowid DESC LIMIT 20').all(project) as PolicySubmissionRow[];
  const submissions = rows.map((r) => {
    const commit = r.outcome === 'accepted' && r.operation !== null ? policyCommitState(db, project, r.operation) : null;
    return { intent_id: r.intent_id, outcome: r.outcome, revision: r.revision, submitted_at: r.created_at, committed: commit?.state === 'committed', commit };
  });
  return {
    committed_at: current?.changed_at ?? null,
    pending: submissions.filter((x) => x.commit !== null && (x.commit.state === 'pending' || x.commit.state === 'ambiguous')).map((x) => ({ revision: x.revision, intent_id: x.intent_id, state: x.commit!.state, submitted_at: x.submitted_at })),
    submissions,
  };
}

// The commit of `.surety/policy.json` and the ref update whose finalizer
// records the policy revision.
export function intendPolicyCommit(tx: Tx, args: { project: string; repo: string; branch: string; prepared: PolicyCommit; widens: boolean; decision?: string; intent?: string }) {
  const pr = args.prepared;
  const ref = integrationRef(args.branch);
  const follow: IntentSpec = {
    project: args.project,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: pr.head, new_oid: pr.commit.sha },
    target: { repo: args.repo, ref },
    subject: { policy_revision: pr.revision, new_oid: pr.commit.sha },
    finalizer: {
      purpose: 'policy',
      ref,
      ref_kind: 'integration',
      new_oid: pr.commit.sha,
      revision: pr.revision,
      blob: pr.blob,
      effective: pr.effective,
      change: pr.change,
      widens: args.widens,
      ...(pr.design_inventory ? { design_inventory: pr.design_inventory } : {}),
      ...(args.decision ? { decision: args.decision } : {}),
      ...(args.intent ? { intent: args.intent } : {}),
    },
    deadlineSeconds: pr.deadlineSeconds,
  };
  return intendCommit(tx, {
    project: args.project,
    repo: args.repo,
    purpose: 'policy',
    tree: pr.commit.tree,
    parent: pr.head,
    sha: pr.commit.sha,
    content: pr.commit.content,
    revisionKind: 'engine_commit',
    follow,
    deadlineSeconds: pr.deadlineSeconds,
    ...(args.intent ? { extra: { intent: args.intent } } : {}),
  });
}

// A project's repository was moved, and is bound again explicitly at its new
// path (Plan M62; SEAM.md §59), by the API or by a restore. The next
// integrity observation is made there; nothing else about the project
// changes.
export function rebindProject(tx: Tx, args: { project: string; dev_repo_path: string }) {
  const row = projectRepoRow(tx, args.project);
  if (row.dev_repo_path !== args.dev_repo_path) {
    tx.db.prepare('UPDATE "projects" SET "dev_repo_path" = ? WHERE "id" = ?').run(args.dev_repo_path, args.project);
    tx.emit('project.rebound', { project: args.project }, { from: row.dev_repo_path, to: args.dev_repo_path });
  }
  return { project: { id: args.project, dev_repo_path: args.dev_repo_path } };
}
