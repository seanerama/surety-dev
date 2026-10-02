// Project transitions: creation, pause and resume (D1 §8.4, §11.4), and the
// project policy command, whose valid changes commit through the journaled
// git path that slice 3 builds.

import { validatePolicySubmission } from '../../config/project-policy.js';
import { newId } from '../../ids.js';
import { Refusal } from '../../refusal.js';
import { intendCommit } from './accept.js';
import type { IntentSpec } from './journal.js';
import { journalBlocks } from './journal.js';
import { type Baseline, addCheckout, blockingObservation, integrationRef, openLineage, projectRepoRow, registerRef } from './repo.js';
import { policyRevision, projectPolicy } from './settings.js';
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
  project: NewProject & { id?: string; registration?: 'registered' | 'pending_bootstrap'; head: string; checkouts?: { path: string; baseline: Baseline }[] },
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
  args: { id: string; name: string; tier: string; repo: string; branch: string; head: string; commit: PreparedCommit; deadlineSeconds: number },
): { project: { id: string; registration_state: string } } {
  const ref = integrationRef(args.branch);
  createProject(tx, { id: args.id, name: args.name, tier: args.tier, dev_repo_path: args.repo, integration_branch: args.branch, registration: 'pending_bootstrap', head: args.head }, {});
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
    effective: projectPolicy(tx.db, args.project),
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

// POST /v1/projects/:p/policy, a valid change (D1 §11.4; SEAM.md §27): the
// file is committed through the journal, and the ref update's finalizer
// records the policy revision.
export function submitPolicy(
  tx: Tx,
  args: { project: string; body: unknown; prepared: { head: string; revision: number; commit: PreparedCommit; blob: string; effective: Record<string, number>; change: Record<string, number>; deadlineSeconds: number } },
): { revision: number; committed: false } {
  getProject(tx, args.project);
  validatePolicySubmission(args.body);
  const facts = policyFacts(tx, { project: args.project });
  if (facts.blocking) throw policyRefusal(facts.blocking);
  const pr = args.prepared;
  if (facts.head !== pr.head || (facts.revision ?? 0) + 1 !== pr.revision) {
    throw new Refusal(409, 'illegal_transition', 'The project policy or its branch changed while the change was prepared.', 'Send the change again.', { project: args.project });
  }
  const ref = integrationRef(facts.branch);
  const follow: IntentSpec = {
    project: args.project,
    kind: 'ref_update',
    payload: { repo: facts.repo, ref, old_oid: pr.head, new_oid: pr.commit.sha },
    target: { repo: facts.repo, ref },
    subject: { policy_revision: pr.revision, new_oid: pr.commit.sha },
    finalizer: { purpose: 'policy', ref, ref_kind: 'integration', new_oid: pr.commit.sha, revision: pr.revision, blob: pr.blob, effective: pr.effective, change: pr.change },
    deadlineSeconds: pr.deadlineSeconds,
  };
  intendCommit(tx, {
    project: args.project,
    repo: facts.repo,
    purpose: 'policy',
    tree: pr.commit.tree,
    parent: pr.head,
    sha: pr.commit.sha,
    content: pr.commit.content,
    revisionKind: 'engine_commit',
    follow,
    deadlineSeconds: pr.deadlineSeconds,
  });
  return { revision: pr.revision, committed: false };
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
