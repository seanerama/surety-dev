// The store's side of accepting what a role left (D1 §§7.3–7.8; SEAM.md
// §§28–30, 40–43): what the acceptance pipeline reads, and the transitions
// that record its steps. Every step is idempotent and derives what it writes
// from durable facts, so a step repeated after a failure writes what it
// would have written the first time (E28 item 1).

import { type Report, recordReport } from './findings.js';
import { type ChangeKind, captureProposal, effectiveVersion } from './protected.js';
import { projectPolicy } from './settings.js';
import { illegal, notFound } from './common.js';
import { type CommitInputs, type PlanInput, type RefInputs, nextCandidateSeq } from './finalize.js';
import { type IntentResult, type IntentSpec, intendOperation, opsOfRun } from './journal.js';
import { type Baseline, integrationRef, nextCounter, projectRepoRow } from './repo.js';
import { getRun } from './runs.js';
import type { Tx } from './tx.js';
import { getWorkItem, transitionWork } from './work.js';

export interface RunResult {
  summary: string;
  checkpoint: boolean;
  nominate: boolean;
  // What a Verifier or a Reviewer reports (SEAM.md §68).
  report?: Report;
}

export interface AcceptFacts {
  run: { id: string; state: string; role: string; work_item: string; base_revision: string; chain: number; project: string; seq: number };
  work: { id: string; kind: string; status: string; seq: number; stage: string | null; goal: string | null };
  result: RunResult | null;
  project: { id: string; repo: string; branch: string; tier: string };
  caps: { files: number; bytes: number; fileBytes: number };
  workspace: { id: string; path: string; base_revision: string; current_base: string; snapshot_tree: string | null; metadata: Record<string, unknown> | null } | null;
  domains: { id: string; status: string }[];
  head: string | null;
  registry: { ref: string; expected_oid: string }[];
  moving: Record<string, string[]>;
  others: { kind: string; path: string; adminDir: string | null; baseline: Baseline }[];
  commits: { id: string; state: string; status: string; sha: string; parent: string; tree: string }[];
  integrations: { id: string; state: string; status: string; detail: Record<string, unknown> | null; new_oid: string }[];
  // The protected roots of the effective version: what no Builder may
  // change, and the only thing a Verifier may (SEAM.md §§66, 68).
  roots: string[];
}

// Refs the engine's own unfinished journal is moving, with the commits it is
// moving them to and from: neither is out of band (D1 §7.6).
export function movingRefs(db: Tx['db'], project: string): Record<string, string[]> {
  const rows = db
    .prepare(
      `SELECT e."payload" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id"
       JOIN "git_journal_events" e ON e."operation" = o."id" AND e."seq" = 1
       WHERE o."project" = ? AND o."kind" = 'git_ref_update' AND s."state" NOT IN ('finalized', 'failed')`,
    )
    .all(project) as { payload: string }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { ref: string; new_oid: string };
    (out[p.ref] ??= []).push(p.new_oid);
  }
  return out;
}

export function acceptFacts(tx: Tx, args: { run: string }): AcceptFacts {
  const run = getRun(tx, args.run);
  if (!run) throw notFound('run', args.run);
  const extra = tx.db.prepare('SELECT "result_value", "chain" FROM "runs" WHERE "id" = ?').get(run.id) as { result_value: string | null; chain: number };
  const item = getWorkItem(tx, run.work_item)!;
  const subject = JSON.parse(item.subject) as { stage?: string };
  const stage = subject.stage ? (tx.db.prepare('SELECT "goal" FROM "stages" WHERE "id" = ?').get(subject.stage) as { goal: string } | undefined) : undefined;
  const p = projectRepoRow(tx, run.project);
  const policy = projectPolicy(tx.db, run.project);
  const ws = run.workspace
    ? (tx.db.prepare('SELECT * FROM "workspaces" WHERE "id" = ?').get(run.workspace) as {
        id: string;
        path: string;
        base_revision: string;
        current_base: string;
        snapshot_tree: string | null;
        metadata_baseline: string | null;
      })
    : undefined;
  const ref = integrationRef(p.integration_branch);
  const head = tx.db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(run.project, ref) as { expected_oid: string } | undefined;
  const others = (
    tx.db
      .prepare(
        `SELECT c.*, w."metadata_baseline" FROM "managed_checkouts" c LEFT JOIN "workspaces" w ON w."run" = c."owner_run" AND w."path" = c."path"
         WHERE c."project" = ? AND c."released_at" IS NULL AND (c."owner_run" IS NULL OR c."owner_run" <> ?)`,
      )
      .all(run.project, run.id) as { kind: string; path: string; baseline: string; metadata_baseline: string | null }[]
  ).map((c) => ({
    kind: c.kind,
    path: c.path,
    adminDir: c.metadata_baseline ? ((JSON.parse(c.metadata_baseline) as { adminDir?: string }).adminDir ?? null) : null,
    baseline: JSON.parse(c.baseline) as Baseline,
  }));
  const commits = opsOfRun(tx.db, run.id, 'commit_tree').map((o) => {
    const inputs = JSON.parse(o.inputs) as CommitInputs;
    return { id: o.id, state: o.state, status: o.status, sha: inputs.sha, parent: inputs.parent, tree: inputs.tree };
  });
  const integrations = opsOfRun(tx.db, run.id, 'ref_update').map((o) => {
    const detail = (tx.db.prepare('SELECT "outcome_detail" FROM "operations" WHERE "id" = ?').get(o.id) as { outcome_detail: string | null }).outcome_detail;
    return { id: o.id, state: o.state, status: o.status, detail: detail ? (JSON.parse(detail) as Record<string, unknown>) : null, new_oid: (JSON.parse(o.inputs) as RefInputs).new_oid };
  });
  return {
    run: { id: run.id, state: run.state, role: run.role, work_item: run.work_item, base_revision: run.base_revision, chain: extra.chain, project: run.project, seq: run.seq },
    work: { id: item.id, kind: item.kind, status: item.status, seq: item.seq, stage: subject.stage ?? null, goal: stage?.goal ?? null },
    result: extra.result_value ? (JSON.parse(extra.result_value) as RunResult) : null,
    project: { id: p.id, repo: p.dev_repo_path, branch: p.integration_branch, tier: p.tier },
    caps: { files: policy.snapshot_max_files!, bytes: policy.snapshot_max_bytes!, fileBytes: policy.snapshot_max_file_bytes! },
    workspace: ws
      ? {
          id: ws.id,
          path: ws.path,
          base_revision: ws.base_revision,
          current_base: ws.current_base,
          snapshot_tree: ws.snapshot_tree,
          metadata: ws.metadata_baseline ? (JSON.parse(ws.metadata_baseline) as Record<string, unknown>) : null,
        }
      : null,
    domains: tx.db.prepare('SELECT "id", "status" FROM "execution_domains" WHERE "run" = ? ORDER BY "id"').all(run.id) as { id: string; status: string }[],
    head: head?.expected_oid ?? null,
    registry: tx.db.prepare('SELECT "ref", "expected_oid" FROM "ref_registry" WHERE "project" = ? ORDER BY "id"').all(run.project) as { ref: string; expected_oid: string }[],
    moving: movingRefs(tx.db, run.project),
    others,
    commits,
    integrations,
    roots: (() => {
      const v = effectiveVersion(tx.db, run.project);
      return v ? (JSON.parse(v.roots) as string[]) : ['.surety/checks/'];
    })(),
  };
}

// A Verifier's or a Reviewer's run that changed nothing: what its role
// reported is recorded (SEAM.md §68).
export function recordRunReport(tx: Tx, args: { run: string; evidence?: (string | null)[] }): void {
  const run = getRun(tx, args.run);
  if (!run || run.state !== 'validating') return;
  recordReport(tx, args);
}

// A Verifier's protected-only diff is captured as a proposal (D1 §§4.1, 7.3;
// SEAM.md §68): the run is proposal_captured, the proposal recorded, and what
// its role reported recorded. Capture is not a commit.
export function captureRunProposal(
  tx: Tx,
  args: { run: string; base: string; tree: string; diffHash: string; rationale: string | null; requested: ChangeKind; changesRequiredSet: boolean; evidence?: (string | null)[] },
): void {
  const run = getRun(tx, args.run);
  if (!run || run.state !== 'validating') return;
  tx.db.prepare(`UPDATE "runs" SET "state" = 'proposal_captured' WHERE "id" = ?`).run(run.id);
  tx.emit('run.proposal_captured', { project: run.project, run: run.id, work_item: run.work_item }, {});
  captureProposal(tx, {
    project: run.project,
    proposedBy: 'verifier_run',
    run: run.id,
    base: args.base,
    tree: args.tree,
    diffHash: args.diffHash,
    rationale: args.rationale,
    requested: args.requested,
    changesRequiredSet: args.changesRequiredSet,
  });
  recordReport(tx, { run: run.id, evidence: args.evidence });
}

// The snapshot of a quiescent workspace, recorded once.
export function recordSnapshot(tx: Tx, args: { workspace: string; tree: string }): void {
  tx.db.prepare('UPDATE "workspaces" SET "snapshot_tree" = ? WHERE "id" = ? AND "snapshot_tree" IS NULL').run(args.tree, args.workspace);
}

// What lies outside the workspace's diff, as the engine left it before the
// role was launched.
export function recordWorkspaceMetadata(tx: Tx, args: { workspace: string; metadata: Record<string, unknown> }): void {
  tx.db.prepare('UPDATE "workspaces" SET "metadata_baseline" = ? WHERE "id" = ? AND "metadata_baseline" IS NULL').run(JSON.stringify(args.metadata), args.workspace);
}

// The intent of a commit (D1 §7.3): its frozen content and id, and the keep
// ref that will publish it, allocated here, once.
export function intendCommit(
  tx: Tx,
  args: {
    project: string;
    repo: string;
    run?: string;
    purpose: CommitInputs['purpose'];
    tree: string;
    parent: string;
    sha: string;
    content: string;
    revisionKind: string;
    checkpoint?: boolean;
    workspace?: string;
    follow?: IntentSpec;
    fence?: boolean;
    deadlineSeconds: number;
    // Further finalizer inputs, fixed with the intent.
    extra?: Record<string, unknown>;
  },
): IntentResult {
  const target = { repo: args.repo, commit: args.sha };
  const subject = { purpose: args.purpose, run: args.run ?? null };
  const existing = tx.db.prepare(`SELECT "id" FROM "operations" WHERE "kind" = 'git_commit' AND "project" = ? AND json_extract("finalizer_inputs", '$.sha') = ? AND json_extract("target", '$.commit') = ?`).get(
    args.project,
    args.sha,
    args.sha,
  ) as { id: string } | undefined;
  if (existing) return { operation: existing.id, existing: true };
  const keep = `refs/surety/keep/${nextCounter(tx, args.project, 'keep')}`;
  const inputs: CommitInputs & { content: string; fence?: boolean } = {
    ...(args.extra ?? {}),
    purpose: args.purpose,
    sha: args.sha,
    parent: args.parent,
    tree: args.tree,
    keep_ref: keep,
    revision_kind: args.revisionKind,
    content: args.content,
  };
  if (args.run !== undefined) inputs.run = args.run;
  if (args.checkpoint) inputs.checkpoint = true;
  if (args.workspace !== undefined) inputs.workspace = args.workspace;
  if (args.follow !== undefined) inputs.follow = args.follow;
  if (args.fence) inputs.fence = true;
  const payload: IntentSpec['payload'] = { repo: args.repo, ref: keep, tree: args.tree, old_oid: args.parent, new_oid: args.sha };
  if (args.run !== undefined) payload.run = args.run;
  return intendOperation(tx, {
    project: args.project,
    kind: 'commit_tree',
    payload,
    target,
    subject,
    finalizer: inputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
    ...(args.run !== undefined && args.fence ? { run: args.run } : {}),
  });
}

// A checkpoint is a working revision (D1 §7.4; E2, E11): the work returns to
// eligible, to be continued by a new run from the checkpoint, with no repair
// charged.
export function checkpointContinue(tx: Tx, args: { run: string; sha: string }): void {
  const run = getRun(tx, args.run)!;
  const item = getWorkItem(tx, run.work_item)!;
  if (item.status !== 'executing') return;
  transitionWork(tx, item, 'eligible', { continue_from: args.sha, repair_due: 0 }, { run: run.id, cause: 'checkpoint' });
}

// The work item enters `integrating` (D1 §7.5).
export function beginIntegration(tx: Tx, args: { run: string }): boolean {
  const run = getRun(tx, args.run)!;
  if (run.state !== 'validating') return false;
  const item = getWorkItem(tx, run.work_item)!;
  if (item.status === 'executing') transitionWork(tx, item, 'integrating', {}, { run: run.id });
  return true;
}

// The intent of an integration: the compare-and-swap of the integration
// branch from the commit it is at to the run's commit, with everything its
// finalizer will write fixed now (correction 14).
export function intendIntegration(
  tx: Tx,
  args: { run: string; repo: string; head: string; commit: string; plans: PlanInput[]; deadlineSeconds: number },
): IntentResult {
  const run = getRun(tx, args.run)!;
  const extra = tx.db.prepare('SELECT "result_value", "chain" FROM "runs" WHERE "id" = ?').get(run.id) as { result_value: string | null; chain: number };
  const result = extra.result_value ? (JSON.parse(extra.result_value) as RunResult) : null;
  const item = getWorkItem(tx, run.work_item)!;
  const p = projectRepoRow(tx, run.project);
  const ref = integrationRef(p.integration_branch);
  const subject = JSON.parse(item.subject) as { stage?: string };
  let nominate: RefInputs['nominate'] = null;
  if (item.kind === 'stage_build' && (p.tier === 'T2' || p.tier === 'T3')) nominate = { by: 'engine_cadence' };
  else if (p.tier === 'T1' && result?.nominate === true && (item.kind === 'stage_build' || item.kind === 'fix')) nominate = { by: 'builder_request' };
  const inputs: RefInputs & { fence: boolean; work_kind: string } = {
    purpose: 'integration',
    ref,
    ref_kind: 'integration',
    new_oid: args.commit,
    run: run.id,
    work_item: item.id,
    work_kind: item.kind,
    stage: subject.stage ?? null,
    plans: args.plans,
    architect: run.role === 'architect',
    nominate,
    chain: extra.chain,
    fence: true,
  };
  return intendOperation(tx, {
    project: run.project,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: args.head, new_oid: args.commit, run: run.id },
    target: { repo: args.repo, ref },
    subject: { run: run.id, old_oid: args.head, new_oid: args.commit },
    finalizer: inputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
    run: run.id,
    linkFailedIntegration: { workItem: item.id, ref },
  });
}

// The intent of a nomination (D1 §7.7): the immutable ref
// refs/surety/cand/<seq> at the revision found due, written by a ref update
// whose finalizer writes the candidate. Clears what was due.
export function intendNomination(tx: Tx, args: { project: string; deadlineSeconds: number }): IntentResult | null {
  const row = tx.db.prepare('SELECT "nomination_due", "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { nomination_due: string | null; dev_repo_path: string } | undefined;
  if (!row) throw notFound('project', args.project);
  if (row.nomination_due === null) return null;
  const due = JSON.parse(row.nomination_due) as { revision: string; by: 'engine_cadence' | 'builder_request'; chain: number };
  const pending = tx.db
    .prepare(
      `SELECT o."id" FROM "operations" o WHERE o."project" = ? AND o."kind" = 'git_ref_update' AND json_extract(o."finalizer_inputs", '$.purpose') = 'nomination'
       AND json_extract(o."finalizer_inputs", '$.new_oid') = ?`,
    )
    .get(args.project, due.revision) as { id: string } | undefined;
  tx.db.prepare('UPDATE "projects" SET "nomination_due" = NULL WHERE "id" = ?').run(args.project);
  if (pending) return { operation: pending.id, existing: true };
  const seq = nextCandidateSeq(tx, args.project);
  const ref = `refs/surety/cand/${seq}`;
  const inputs: RefInputs = { purpose: 'nomination', ref, ref_kind: 'nomination', immutable: true, new_oid: due.revision, seq, by: due.by, chain: due.chain };
  return intendOperation(tx, {
    project: args.project,
    kind: 'ref_update',
    payload: { repo: row.dev_repo_path, ref, old_oid: null, new_oid: due.revision },
    target: { repo: row.dev_repo_path, ref },
    subject: { nominate: due.revision },
    finalizer: inputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
  });
}

export function nominationDue(db: Tx['db']): string[] {
  return (db.prepare('SELECT "id" FROM "projects" WHERE "nomination_due" IS NOT NULL').all() as { id: string }[]).map((r) => r.id);
}

// The role's structured result as the engine accepted it (SEAM.md §26).
export function storeResult(tx: Tx, args: { run: string; result: RunResult }): void {
  const run = getRun(tx, args.run);
  if (!run) throw notFound('run', args.run);
  if (run.state === 'ended') throw illegal('a result for an ended run', { run: args.run });
  tx.db.prepare('UPDATE "runs" SET "result_value" = ? WHERE "id" = ? AND "result_value" IS NULL').run(JSON.stringify(args.result), args.run);
}
