// The attention queue's eleven kinds (build spec §3; D1 §§3.4, 4.6, 9.7, 10;
// RN R4; build spec §6 correction 22; Review B12; SEAM.md §§76-82). For each
// kind: what its preview binds (the dependency manifest, ../contract in the
// tests), its options with their effect plans and blockers, whether the
// question still stands, what a positive answer does, and what withdrawing
// an invalidated effect undoes. Every answer is checked against what the
// engine computes now, from current rows and the current time; the tick's
// decision step invalidates a decision whose dependency changed and, where
// the question stands, raises its next generation; and it escalates a
// decision past its target.

import { wideningKeys } from '../../config/project-policy.js';
import { nowIso } from '../../clock.js';
import { Refusal } from '../../refusal.js';
import { canonical, illegal, notFound, parseJson, sha256 } from './common.js';
import type { CommandResult, Effect } from './control.js';
import {
  type DecisionKind,
  type DecisionRow,
  type OptionSpec,
  consumeDecision,
  currentPreview,
  getDecision,
  invalidateDecision,
  openDecision,
  raiseDecision,
  stale,
} from './decisions.js';
import { contentHash, getCandidate, markStale } from './evidence.js';
import { type FindingRow, blocks, findingApplies } from './gates.js';
import { intendOperation, opDetail } from './journal.js';
import { CORRECTION_KIND, approveProposal, effectiveVersion, getProposal, invalidateResults, withdrawApproval } from './protected.js';
import { type OobRow, type RegistryRow, integrationRef, nextCounter, projectRepoRow, recordRevision, registerRef } from './repo.js';
import { getRun } from './runs.js';
import { engineSettings, policyRevision, projectPolicy } from './settings.js';
import type { Tx } from './tx.js';
import { getWorkItem, transitionWork } from './work.js';

type Db = Tx['db'];

// What the main thread read afresh for an answer or an effect (D1 §10.5;
// SEAM.md §79): the integration branch's head as the repository has it, and
// what an observed ref or checkout holds now.
export interface Facts {
  head?: string | null;
  found?: string | null;
}

export interface Preview {
  manifest: Record<string, unknown>;
  options: OptionSpec[];
  question: string;
  blockedWorkItems?: string[];
  blockedOperation?: string;
}

type Subject = Pick<DecisionRow, 'project' | 'kind' | 'subject_type' | 'subject_id' | 'scope' | 'options'>;

interface KindSpec {
  // The question as it stands now; null if it no longer stands.
  preview(tx: Tx, d: Subject, facts?: Facts): Preview | null;
  // What the decision is bound to now, whether or not the question stands:
  // what an effect's preconditions are compared with.
  manifest(tx: Tx, d: Subject, facts?: Facts): Record<string, unknown>;
  // The tick raises the next generation itself when a dependency changed
  // (not for a question a command raises: SEAM.md §76).
  reraise: boolean;
  answer(tx: Tx, d: DecisionRow, option: string, note: string | null, facts: Facts): CommandResult;
  // An effect of this kind was invalidated: undo the consumption's local
  // transition; return whether the question is raised again.
  withdraw?(tx: Tx, d: DecisionRow): boolean;
}

const consumed = (d: DecisionRow, effects: Effect[] = []): CommandResult => ({ status: 200, body: { decision: { id: d.id, status: 'consumed' } }, effects });

const policyRevisionId = (db: Db, project: string): string | null =>
  (db.prepare('SELECT "policy_revision" FROM "projects" WHERE "id" = ?').get(project) as { policy_revision: string | null } | undefined)?.policy_revision ?? null;

// ---- approvals and effect intents --------------------------------------------------

function recordApproval(tx: Tx, d: DecisionRow, args: { consequence: string; subjectType: string; subjectId: string; contentHash?: string | null; resultHash?: string | null }): string {
  const id = tx.newId('appr_');
  tx.db
    .prepare(
      `INSERT INTO "approvals" ("id", "created_at", "project", "decision", "actor", "consequence", "subject_type", "subject_id", "acceptance_content_hash", "result_hash",
         "policy_revision", "consumed_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, d.project, d.id, tx.actor.actor_kind, args.consequence, args.subjectType, args.subjectId, args.contentHash ?? null, args.resultHash ?? null, policyRevisionId(tx.db, d.project), tx.at);
  return id;
}

function recordIntent(tx: Tx, d: DecisionRow, args: { approval: string | null; kind: string; plan: Record<string, unknown> }): Effect {
  const preconditions = KINDS[d.kind as DecisionKind]!.manifest(tx, d);
  const id = tx.newId('eff_');
  tx.db
    .prepare(
      `INSERT INTO "effect_intents" ("id", "created_at", "project", "decision", "approval", "operation", "preconditions", "status", "kind", "plan")
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?)`,
    )
    .run(id, tx.at, d.project, d.id, args.approval, JSON.stringify(preconditions), args.kind, JSON.stringify(args.plan));
  tx.emit('intent.recorded', { project: d.project, decision: d.id, intent: id }, { kind: args.kind });
  return { kind: 'effect', intent: id };
}

// ---- blocker --------------------------------------------------------------------------

const BLOCKER_EVIDENCE: unknown[] = [];

function blockerPreview(tx: Tx, d: Subject): Preview | null {
  if (d.subject_type === 'work_item') {
    const item = getWorkItem(tx, d.subject_id);
    const blocker = parseJson<{ reason: string; worktree?: string }>(item?.blocker ?? null);
    if (!item || !blocker) return null;
    if (item.status === 'parked') {
      const what =
        blocker.reason === 'integration_branch_checked_out'
          ? `its integration was refused: the integration branch is checked out in the worktree ${blocker.worktree ?? '(unknown)'}, which the engine does not own. Switch that worktree to another branch, or detach it, then retry`
          : (PARK_TEXT[blocker.reason] ?? blocker.reason);
      return {
        manifest: { work_item: item.id, subject_status: 'parked', cause: blocker.reason, quarantined: false, evidence: BLOCKER_EVIDENCE, continuation: 'eligible' },
        options: [
          { key: 'retry', label: 'Retry', consequence: 'The item becomes eligible and is dispatched again by the scheduler.', effect: { work_item: item.id, to: 'eligible' } },
          { key: 'cancel', label: 'Cancel', consequence: 'The item is cancelled and never dispatched again.', effect: { work_item: item.id, to: 'cancelled' } },
        ],
        question: `Work item ${item.id} (${item.kind}) is parked: ${what}. Retry it, or cancel it.`,
        blockedWorkItems: [item.id],
      };
    }
    if (item.status === 'eligible' && blocker.reason === 'max_chained_roles') {
      return {
        manifest: { work_item: item.id, subject_status: 'eligible', cause: 'max_chained_roles', quarantined: false, evidence: BLOCKER_EVIDENCE, continuation: 'dispatch' },
        options: [
          { key: 'continue', label: 'Continue', consequence: 'The work starts a new chain and the scheduler dispatches it.', effect: { work_item: item.id, chain: 0 } },
          { key: 'cancel', label: 'Cancel', consequence: 'The work is cancelled without a launch.', effect: { work_item: item.id, to: 'cancelled' } },
        ],
        question:
          `Work item ${item.id} (${item.kind}) was created by the outcome of a run, and the project's max_chained_roles does not let it run ` +
          'without a person. Continue to let the scheduler dispatch it, or cancel it.',
        blockedWorkItems: [item.id],
      };
    }
    return null;
  }
  if (d.subject_type === 'run') {
    const run = getRun(tx, d.subject_id);
    if (!run || run.state !== 'finalizing' || run.quarantined !== 1) return null;
    return {
      manifest: { run: run.id, subject_status: run.state, cause: 'termination_unobserved', quarantined: true, evidence: BLOCKER_EVIDENCE, continuation: null },
      options: [
        {
          key: 'acknowledge',
          label: 'Acknowledge',
          consequence: 'Records that you have seen this. It establishes nothing: the quarantine ends only when termination is observed.',
          effect: { record: 'acknowledgement' },
        },
      ],
      question: `Run ${run.id} cannot be ended: the execution boundary has not reported its domains terminated. It stays quarantined until termination is observed.`,
      blockedWorkItems: [run.work_item],
    };
  }
  if (d.subject_type === 'operation') {
    let op;
    try {
      op = opDetail(tx, d.subject_id);
    } catch {
      return null;
    }
    if (op.state !== 'ambiguous') return null;
    // What the probe could not establish is the cause; which reading it made
    // last is in the attempt's record, not in what the answer binds.
    return {
      manifest: { operation: op.id, journal_kind: op.kind, subject_status: op.state, cause: 'effect_unconfirmed', quarantined: false, evidence: BLOCKER_EVIDENCE, continuation: null },
      options: [
        {
          key: 'acknowledge',
          label: 'Acknowledge',
          consequence: 'Records that you have seen this. It establishes nothing: the operation goes on only once a probe can tell what git holds.',
          effect: { record: 'acknowledgement' },
        },
      ],
      question: `Operation ${op.id} (${op.kind}) cannot go on: the probe could not establish what git holds.`,
      blockedOperation: op.id,
    };
  }
  return null;
}

export const PARK_TEXT: Record<string, string> = {
  repair_attempts_max: 'every permitted repair attempt failed',
  preflight_refusals_max: 'its runs were refused before launch as often as policy allows',
  deadline: 'its run passed its deadline',
  no_progress_max: 'its repairs left the same rejected result as often as policy allows',
  budget_run_billable_tokens: "its run passed the project's limit of billable tokens per run (budget_run_billable_tokens) and was stopped",
  budget_day_unknown_tokens: "the project's tokens of unknown cost today passed their limit (budget_day_unknown_tokens), and its run was stopped",
  budget_day_verified_usd: "the project's verified cost today passed its limit (budget_day_verified_usd), and its run was stopped",
  budget_unreadable: 'its budget could not be read, and its run was stopped rather than run on without one',
  integration_conflict: 'its result could not be integrated: the integration branch moved, and the change does not apply to it, or the compare-and-swap failed. No role resolves it',
};

const BLOCKER: KindSpec = {
  preview: blockerPreview,
  manifest: (tx, d) => blockerPreview(tx, d)?.manifest ?? { subject_status: null, quarantined: null, cause: null, evidence: BLOCKER_EVIDENCE, continuation: null },
  reraise: true,
  answer(tx, d, option, note) {
    if (d.subject_type === 'work_item') {
      const item = getWorkItem(tx, d.subject_id)!;
      consumeDecision(tx, d, option, note);
      if (item.status === 'eligible') {
        // The human step at the chaining boundary (D1-34; SEAM.md §40): the
        // work starts a new chain and the scheduler dispatches it once; the
        // answer launches nothing itself.
        if (option === 'continue') {
          tx.db.prepare('UPDATE "work_items" SET "blocker" = NULL, "chain" = 0 WHERE "id" = ?').run(item.id);
          return consumed(d, [{ kind: 'tick' }]);
        }
        transitionWork(tx, item, 'cancelled', { blocker: null }, { decision: d.id, cause: 'cancel' });
        return consumed(d);
      }
      if (option === 'retry') transitionWork(tx, item, 'eligible', { blocker: null, repair_due: 0 }, { decision: d.id, cause: 'retry' });
      else transitionWork(tx, item, 'cancelled', { blocker: null }, { decision: d.id, cause: 'cancel' });
      return consumed(d);
    }
    // A quarantine's or an operation's acknowledgement establishes nothing
    // (build spec §6 correction 2).
    consumeDecision(tx, d, option, note);
    return consumed(d);
  },
};

// ---- stop_confirm, abandon_confirm (SEAM.md §80) --------------------------------------

export function controlManifest(tx: Tx, runId: string, kind: 'stop_confirm' | 'abandon_confirm'): Record<string, unknown> {
  const run = getRun(tx, runId);
  const domains = (tx.db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ? ORDER BY "id"').all(runId) as { id: string }[]).map((r) => r.id);
  const lease = tx.db.prepare(`SELECT "generation" FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? ORDER BY "acquired_at" DESC LIMIT 1`).get(runId) as
    | { generation: number }
    | undefined;
  const ws = tx.db.prepare('SELECT "id", "snapshot_tree" FROM "workspaces" WHERE "run" = ?').get(runId) as { id: string; snapshot_tree: string | null } | undefined;
  const item = run ? getWorkItem(tx, run.work_item) : undefined;
  const stoppable = !!run && run.state !== 'finalizing' && run.state !== 'ended' && run.quarantined === 0;
  return {
    run: runId,
    stoppable,
    domains,
    lease_generation: lease?.generation ?? null,
    workspace: ws?.id ?? run?.workspace ?? null,
    workspace_snapshot: ws?.snapshot_tree ?? null,
    workspace_fate: kind === 'stop_confirm' ? 'retained' : 'discarded',
    work_fate: kind === 'stop_confirm' ? { status: 'held' } : { status: item?.prior_status ?? 'eligible', dispatch_hold: true },
  };
}

function controlPreview(kind: 'stop_confirm' | 'abandon_confirm') {
  return (tx: Tx, d: Subject): Preview | null => {
    const run = getRun(tx, d.subject_id);
    if (!run || run.state === 'finalizing' || run.state === 'ended' || run.quarantined === 1) return null;
    const stop = kind === 'stop_confirm';
    return {
      manifest: controlManifest(tx, run.id, kind),
      options: [
        {
          key: 'confirm',
          label: stop ? 'Stop' : 'Abandon',
          consequence: stop ? 'The run ends stopped and the work is held.' : 'The run ends abandoned and the workspace is discarded.',
          effect: { run: run.id, outcome: stop ? 'stopped' : 'abandoned' },
        },
      ],
      question: stop
        ? `Stop run ${run.id}? Its role is terminated, what it observed is kept, its workspace is retained and its work is held until you resume it.`
        : `Abandon run ${run.id}? Its role is terminated, its workspace is discarded once termination is confirmed, and its work waits under a dispatch hold until you resume it.`,
    };
  };
}

function controlSpec(kind: 'stop_confirm' | 'abandon_confirm'): KindSpec {
  return {
    preview: controlPreview(kind),
    manifest: (tx, d) => controlManifest(tx, d.subject_id, kind),
    reraise: false,
    answer(tx, d, option, note) {
      consumeDecision(tx, d, option, note);
      return beginControl(tx, d, kind === 'stop_confirm' ? 'stop' : 'abandon');
    },
  };
}

// Set by control.ts: the run-end protocol begun for a confirmed Stop or Abandon.
let beginControl: (tx: Tx, d: DecisionRow, kind: 'stop' | 'abandon') => CommandResult = () => {
  throw new Error('control is not wired');
};
export function wireControl(fn: typeof beginControl): void {
  beginControl = fn;
}

// ---- out_of_band_change (SEAM.md §§32, 79) ---------------------------------------------

function oobRow(db: Db, id: string): OobRow | undefined {
  return db.prepare('SELECT * FROM "out_of_band_changes" WHERE "id" = ?').get(id) as OobRow | undefined;
}

export function oobOptions(tx: Tx, o: { subject_kind: string; ref: string | null; found: string | null }): OptionSpec[] {
  if (o.subject_kind === 'repository') return [];
  if (o.subject_kind === 'checkout') {
    return [
      { key: 'stash', label: 'Stash', consequence: 'The engine commits the checkout as it is to an oob ref and restores its baseline.', effect: { disposition: 'stash' } },
      { key: 'adopt', label: 'Adopt', consequence: 'What the checkout holds becomes its baseline.', effect: { disposition: 'adopt' } },
    ];
  }
  const row = tx.db.prepare('SELECT * FROM "ref_registry" WHERE "id" = ?').get(o.ref) as RegistryRow;
  const discard = { key: 'discard', label: 'Discard', consequence: `The engine puts ${row.ref} back on ${row.expected_oid}${o.found ? ' and keeps the commit found under an oob ref' : ''}.`, effect: { disposition: 'discard' } };
  if (o.found === null || row.immutable === 1) return [discard];
  return [discard, { key: 'adopt', label: 'Adopt', consequence: `The commit found, ${o.found}, becomes the one the engine expects for ${row.ref}.`, effect: { disposition: 'adopt' } }];
}

const OOB: KindSpec = {
  preview(tx, d, facts) {
    const row = oobRow(tx.db, d.subject_id);
    if (!row || row.disposition !== null || row.closed_at !== null) return null;
    const found = facts && 'found' in facts ? facts.found : row.found;
    return { manifest: { subject_kind: row.subject_kind, expected: row.expected, found }, options: oobOptions(tx, row), question: 'An out-of-band change was observed.' };
  },
  manifest(tx, d, facts) {
    const row = oobRow(tx.db, d.subject_id)!;
    return { subject_kind: row.subject_kind, expected: row.expected, found: facts && 'found' in facts ? facts.found : row.found };
  },
  reraise: false,
  answer: answerOutOfBand,
};

// The answers to an observation (D1 §7.6; SEAM.md §§32, 79). The caller has
// compared the actual ref or checkout with what was found (the preview's
// `found`, afresh). `adopt` of a ref makes the commit found the expected one
// and invalidates the evidence of the open lineage; `discard` journals the
// ref that keeps the commit found and the compare-and-swap back; `stash` of a
// checkout is an effect, made after the answer.
function answerOutOfBand(tx: Tx, d: DecisionRow, option: string, note: string | null): CommandResult {
  const row = oobRow(tx.db, d.subject_id)!;
  if (row.disposition !== null || row.closed_at !== null) throw stale(d);
  const repo = projectRepoRow(tx, row.project).dev_repo_path;
  if (row.subject_kind === 'checkout') {
    if (option === 'stash') {
      consumeDecision(tx, d, option, note);
      const checkout = tx.db.prepare('SELECT "path", "baseline" FROM "managed_checkouts" WHERE "id" = ?').get(row.checkout) as { path: string; baseline: string };
      return consumed(d, [recordIntent(tx, d, { approval: null, kind: 'oob_stash', plan: { observation: row.id, checkout: row.checkout, path: checkout.path, found: row.found } })]);
    }
    // `adopt` of a checkout is not built in M1 (SEAM.md §79: not exercised).
    throw new Refusal(501, 'unsupported', 'Adopting what a checkout holds is not available in this engine revision.', 'Nothing was changed. Answer stash, or put the checkout back yourself.', { decision: d.id });
  }
  if (row.subject_kind !== 'ref') throw illegal('An answer to a repository observation', { decision: d.id });
  const reg = tx.db.prepare('SELECT * FROM "ref_registry" WHERE "id" = ?').get(row.ref) as RegistryRow;
  consumeDecision(tx, d, option, note);
  if (option === 'adopt') {
    if (row.found === null || reg.immutable === 1) throw stale(d);
    registerRef(tx, { project: row.project, ref: reg.ref, kind: reg.kind, expected: row.found });
    recordRevision(tx, { project: row.project, sha: row.found, parent: null, kind: 'out_of_band', run: null });
    tx.db.prepare(`UPDATE "out_of_band_changes" SET "disposition" = 'adopt' WHERE "id" = ?`).run(row.id);
    if (reg.kind === 'integration') invalidateLineageEvidence(tx, row.project);
    tx.emit('repo.reconciled', { project: row.project, out_of_band_change: row.id }, { disposition: 'adopt', ref: reg.ref, adopted: row.found });
    return consumed(d, [{ kind: 'tick' }]);
  }
  const deadline = engineSettings().git_deadline;
  if (row.found !== null) {
    const keep = `refs/surety/oob/${nextCounter(tx, row.project, 'oob')}`;
    intendOperation(tx, {
      project: row.project,
      kind: 'ref_update',
      payload: { repo, ref: keep, old_oid: null, new_oid: row.found },
      target: { repo, ref: keep },
      subject: { out_of_band_change: row.id, keep: row.found },
      finalizer: { purpose: 'oob_keep', ref: keep, ref_kind: 'oob', new_oid: row.found },
      deadlineSeconds: deadline,
    });
  }
  intendOperation(tx, {
    project: row.project,
    kind: 'ref_update',
    payload: { repo, ref: reg.ref, old_oid: row.found, new_oid: reg.expected_oid },
    target: { repo, ref: reg.ref },
    subject: { out_of_band_change: row.id, reset: reg.expected_oid },
    finalizer: { purpose: 'oob_discard', ref: reg.ref, ref_kind: reg.kind, immutable: reg.immutable === 1, new_oid: reg.expected_oid, oob: row.id },
    deadlineSeconds: deadline,
  });
  return consumed(d, [{ kind: 'journal', project: row.project }]);
}

// Adopting a commit on the integration branch invalidates at least the
// results of the candidate the open lineage started from (E34 item 5;
// SEAM.md §72).
function invalidateLineageEvidence(tx: Tx, project: string): void {
  const p = projectRepoRow(tx, project);
  const lineage = tx.db.prepare('SELECT "started_from_candidate" FROM "lineages" WHERE "project" = ? AND "branch" = ? AND "open" = 1').get(project, p.integration_branch) as
    | { started_from_candidate: string | null }
    | undefined;
  if (lineage?.started_from_candidate) {
    const ids = (tx.db.prepare('SELECT "id" FROM "check_results" WHERE "candidate" = ? AND "invalidated_at" IS NULL').all(lineage.started_from_candidate) as { id: string }[]).map((r) => r.id);
    invalidateResults(tx, project, ids, 'out_of_band_adopted');
  }
  markStale(tx, { project });
}

// ---- policy_widening (SEAM.md §78) -----------------------------------------------------

export function widenScope(change: Record<string, number>): string {
  return `change:${sha256(canonical(change))}`;
}

export function widenPreview(tx: Tx, project: string, change: Record<string, number>): Preview | null {
  const effective = projectPolicy(tx.db, project);
  const widens = wideningKeys(effective, change).sort();
  const proposed = { ...effective, ...change };
  const sorted = Object.fromEntries(Object.keys(proposed).sort().map((k) => [k, proposed[k]!]));
  const revision = tx.db
    .prepare('SELECT r."revision", r."git_blob" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?')
    .get(project) as { revision: number; git_blob: string } | undefined;
  const manifest = { base_revision: revision?.revision ?? null, base_blob: revision?.git_blob ?? null, proposed_policy: sorted, widens };
  if (widens.length === 0) return null;
  return {
    manifest,
    options: [
      { key: 'approve', label: 'Approve', consequence: `The policy is committed with ${widens.join(', ')} raised.`, effect: { change, policy: sorted } },
      { key: 'reject', label: 'Reject', consequence: 'Nothing is changed.', effect: { change } },
    ],
    question: `The policy change widens what the engine may do unasked (${widens.join(', ')}). Approve it to commit it.`,
  };
}

const changeOf = (d: Subject): Record<string, number> =>
  ((JSON.parse(d.options) as { key: string; effect_plan: { change?: Record<string, number> } }[]).find((o) => o.key === 'approve')?.effect_plan.change ?? {}) as Record<string, number>;

const WIDENING: KindSpec = {
  preview: (tx, d) => widenPreview(tx, d.project, changeOf(d)),
  manifest(tx, d) {
    const p = widenPreview(tx, d.project, changeOf(d));
    if (p) return p.manifest;
    const revision = policyRevision(tx.db, d.project);
    return { base_revision: revision, base_blob: null, proposed_policy: null, widens: [] };
  },
  reraise: false,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    if (option !== 'approve') return consumed(d);
    const plan = (JSON.parse(d.options) as { key: string; effect_plan: Record<string, unknown> }[]).find((o) => o.key === 'approve')!.effect_plan;
    const approval = recordApproval(tx, d, { consequence: 'the widened policy is committed', subjectType: 'project', subjectId: d.project });
    return consumed(d, [recordIntent(tx, d, { approval, kind: 'policy_widening', plan })]);
  },
  withdraw: () => true,
};

// ---- findings: disposition, severity, applicability (SEAM.md §§74, 77) ----------------

function findingRow(db: Db, id: string): FindingRow | undefined {
  return db.prepare('SELECT * FROM "findings" WHERE "id" = ?').get(id) as FindingRow | undefined;
}

function findingBinding(tx: Tx, f: FindingRow): { applicable: boolean; candidate_revision: string | null; acceptance_content_hash: string | null } {
  const candidate = f.candidate ? getCandidate(tx.db, f.candidate) : undefined;
  return {
    applicable: candidate ? findingApplies(tx.db, f, candidate) : f.scope === 'project',
    candidate_revision: candidate?.revision ?? null,
    acceptance_content_hash: candidate ? contentHash(tx.db, f.project, candidate) : null,
  };
}

interface ProposedDisposition {
  disposition: 'defer' | 'accept' | 'fix';
  linked_issue?: string | null;
  defer_target?: string | null;
  run: string;
}

function dispositionManifest(tx: Tx, f: FindingRow): Record<string, unknown> {
  const proposed = parseJson<ProposedDisposition>(f.proposed_disposition);
  return {
    finding_status: f.status,
    disposition: f.disposition,
    proposed_disposition: proposed?.disposition ?? null,
    effective_severity: f.effective_severity,
    sensitive_area: f.sensitive_area,
    evidence: [],
    defer_target: proposed?.defer_target ?? null,
    linked_issue: proposed?.linked_issue ?? null,
    ...findingBinding(tx, f),
    policy_revision: policyRevisionId(tx.db, f.project),
  };
}

const DISPOSITION: KindSpec = {
  preview(tx, d) {
    const f = findingRow(tx.db, d.subject_id);
    const proposed = parseJson<ProposedDisposition>(f?.proposed_disposition ?? null);
    if (!f || !proposed || f.status === 'resolved') return null;
    // A deferral whose target has passed cannot be approved: the question no
    // longer stands (SEAM.md §§76, 77).
    if (proposed.disposition === 'defer' && proposed.defer_target && Date.parse(proposed.defer_target) <= Date.parse(nowIso())) return null;
    return {
      manifest: dispositionManifest(tx, f),
      options: [
        { key: 'approve', label: 'Approve', consequence: `The finding is dispositioned ${proposed.disposition} by the human owner.`, effect: { finding: f.id, ...proposed } },
        { key: 'reject', label: 'Reject', consequence: 'The finding stays as it is.', effect: { finding: f.id } },
      ],
      question: `A Reviewer proposes to ${proposed.disposition} finding ${f.id} (${f.effective_severity}), which is beyond its authority. Approve or reject it.`,
    };
  },
  manifest: (tx, d) => dispositionManifest(tx, findingRow(tx.db, d.subject_id)!),
  reraise: true,
  answer(tx, d, option, note) {
    const f = findingRow(tx.db, d.subject_id)!;
    const proposed = parseJson<ProposedDisposition>(f.proposed_disposition)!;
    consumeDecision(tx, d, option, note);
    tx.db.prepare('UPDATE "findings" SET "proposed_disposition" = NULL WHERE "id" = ?').run(f.id);
    if (option !== 'approve') return consumed(d);
    const binding = findingBinding(tx, f);
    recordApproval(tx, d, { consequence: `finding ${f.id} dispositioned ${proposed.disposition}`, subjectType: 'finding', subjectId: f.id, contentHash: binding.acceptance_content_hash });
    recordDisposition(tx, f, { disposition: proposed.disposition, authority: 'human', by: tx.actor.actor_kind, linked_issue: proposed.linked_issue ?? null, defer_target: proposed.defer_target ?? null });
    return consumed(d);
  },
};

// A disposition is recorded on a finding (F §6.2; SEAM.md §74).
export function recordDisposition(
  tx: Tx,
  f: FindingRow,
  args: { disposition: 'fix' | 'defer' | 'accept'; authority: 'reviewer' | 'human'; by: string; linked_issue: string | null; defer_target: string | null },
): void {
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("execution_seq"), 0) AS n FROM "check_results" WHERE "project" = ?').get(f.project) as { n: number };
  tx.db
    .prepare(
      `UPDATE "findings" SET "status" = 'dispositioned', "disposition" = ?, "disposition_authority" = ?, "disposition_by" = ?, "disposition_at" = ?, "disposition_seq" = ?,
         "linked_issue" = ?, "defer_target" = ? WHERE "id" = ?`,
    )
    .run(args.disposition, args.authority, args.by, tx.at, n, args.linked_issue, args.defer_target, f.id);
  tx.emit('finding.dispositioned', { project: f.project, finding: f.id }, { disposition: args.disposition, authority: args.authority });
  markStale(tx, { project: f.project });
}

// A severity change is applied and recorded (D1 §9.4; F §6.3).
export function changeSeverity(tx: Tx, f: FindingRow, args: { to: string; actor: string; authority: string }): void {
  const history = JSON.parse(f.severity_history) as unknown[];
  history.push({ actor: args.actor, authority: args.authority, from: f.effective_severity, to: args.to, at: tx.at });
  tx.db.prepare('UPDATE "findings" SET "effective_severity" = ?, "severity_history" = ? WHERE "id" = ?').run(args.to, JSON.stringify(history), f.id);
  tx.emit('finding.severity_changed', { project: f.project, finding: f.id }, { from: f.effective_severity, to: args.to, authority: args.authority });
  markStale(tx, { project: f.project });
}

function severityManifest(tx: Tx, f: FindingRow): Record<string, unknown> {
  const proposed = parseJson<{ to: string }>(f.proposed_severity_change);
  const { applicable, candidate_revision, acceptance_content_hash } = findingBinding(tx, f);
  return {
    finding_status: f.status,
    effective_severity: f.effective_severity,
    to: proposed?.to ?? null,
    sensitive_area: f.sensitive_area,
    applicable,
    candidate_revision,
    acceptance_content_hash,
    policy_revision: policyRevisionId(tx.db, f.project),
  };
}

const SEVERITY: KindSpec = {
  preview(tx, d) {
    const f = findingRow(tx.db, d.subject_id);
    const proposed = parseJson<{ to: string }>(f?.proposed_severity_change ?? null);
    if (!f || !proposed || f.status === 'resolved') return null;
    return {
      manifest: severityManifest(tx, f),
      options: [
        { key: 'approve', label: 'Approve', consequence: `The finding's severity is lowered to ${proposed.to}.`, effect: { finding: f.id, to: proposed.to } },
        { key: 'reject', label: 'Reject', consequence: 'The severity stays as it is.', effect: { finding: f.id } },
      ],
      question: `A Reviewer asks to lower finding ${f.id} from ${f.effective_severity} to ${proposed.to}, out of the blocking range. Approve or reject it.`,
    };
  },
  manifest: (tx, d) => severityManifest(tx, findingRow(tx.db, d.subject_id)!),
  reraise: true,
  answer(tx, d, option, note) {
    const f = findingRow(tx.db, d.subject_id)!;
    const proposed = parseJson<{ to: string }>(f.proposed_severity_change)!;
    consumeDecision(tx, d, option, note);
    tx.db.prepare('UPDATE "findings" SET "proposed_severity_change" = NULL WHERE "id" = ?').run(f.id);
    if (option !== 'approve') return consumed(d);
    recordApproval(tx, d, { consequence: `finding ${f.id} lowered to ${proposed.to}`, subjectType: 'finding', subjectId: f.id, contentHash: findingBinding(tx, f).acceptance_content_hash });
    changeSeverity(tx, f, { to: proposed.to, actor: tx.actor.actor_kind, authority: 'human' });
    return consumed(d);
  },
};

interface AssessmentRow {
  id: string;
  project: string;
  finding: string;
  candidate: string;
  proposed_by_run: string;
  assessed_by_run: string | null;
  authorized_by: string | null;
  evidence: string;
  reason: string;
  status: string;
}

export const blocksAnyGate = (f: Pick<FindingRow, 'effective_severity' | 'alpha_exception' | 'sensitive_area'>): boolean => blocks(f, 'stage') || blocks(f, 'alpha_authorize');

function exclusionManifest(tx: Tx, a: AssessmentRow): Record<string, unknown> {
  const f = findingRow(tx.db, a.finding)!;
  const candidate = getCandidate(tx.db, a.candidate);
  const evidence = tx.db.prepare('SELECT "post_scan", "missing_at" FROM "records" WHERE "id" = ?').get(a.evidence) as { post_scan: string; missing_at: string | null } | undefined;
  return {
    assessment_status: a.status,
    evidence: { record: a.evidence, quarantined: evidence?.post_scan === 'hit', missing: evidence ? evidence.missing_at !== null : true },
    reason: a.reason,
    proposed_by_run: a.proposed_by_run,
    assessed_by_run: a.assessed_by_run,
    finding: a.finding,
    candidate: a.candidate,
    ancestry: f.candidate,
    acceptance_content_hash: candidate ? contentHash(tx.db, a.project, candidate) : null,
    effective_severity: f.effective_severity,
    disposition: f.disposition,
    sensitive_area: f.sensitive_area,
    blocks_gate: blocksAnyGate(f),
    protected_version: effectiveVersion(tx.db, a.project)?.id ?? null,
    policy_revision: policyRevisionId(tx.db, a.project),
  };
}

const assessmentRow = (db: Db, id: string) => db.prepare('SELECT * FROM "applicability_assessments" WHERE "id" = ?').get(id) as AssessmentRow | undefined;

const EXCLUSION: KindSpec = {
  preview(tx, d) {
    const a = assessmentRow(tx.db, d.subject_id);
    if (!a || a.status !== 'assessed') return null;
    const f = findingRow(tx.db, a.finding)!;
    if (!blocksAnyGate(f) || f.status === 'resolved') return null;
    return {
      manifest: exclusionManifest(tx, a),
      options: [
        { key: 'approve', label: 'Approve', consequence: `Finding ${f.id} no longer applies to candidate ${a.candidate}.`, effect: { assessment: a.id, finding: f.id, candidate: a.candidate } },
        { key: 'reject', label: 'Reject', consequence: 'The finding applies as before.', effect: { assessment: a.id } },
      ],
      question: `A Verifier proposed, and a Reviewer assessed, that finding ${f.id} does not apply to candidate ${a.candidate}. It blocks a gate: approve or reject the exclusion.`,
    };
  },
  manifest: (tx, d) => exclusionManifest(tx, assessmentRow(tx.db, d.subject_id)!),
  reraise: true,
  answer(tx, d, option, note) {
    const a = assessmentRow(tx.db, d.subject_id)!;
    consumeDecision(tx, d, option, note);
    if (option !== 'approve') {
      tx.db.prepare(`UPDATE "applicability_assessments" SET "status" = 'rejected' WHERE "id" = ?`).run(a.id);
      tx.emit('assessment.rejected', { project: a.project, assessment: a.id, finding: a.finding }, { by: 'human' });
      return consumed(d);
    }
    recordApproval(tx, d, { consequence: `finding ${a.finding} excluded from candidate ${a.candidate}`, subjectType: 'applicability_assessment', subjectId: a.id });
    tx.db.prepare(`UPDATE "applicability_assessments" SET "status" = 'approved', "authorized_by" = ? WHERE "id" = ?`).run(tx.actor.actor_kind, a.id);
    tx.emit('assessment.approved', { project: a.project, assessment: a.id, finding: a.finding }, { candidate: a.candidate });
    markStale(tx, { project: a.project });
    return consumed(d);
  },
};

// ---- check corrections (SEAM.md §§69, 77) ------------------------------------------------

function correctionManifest(tx: Tx, proposalId: string, facts?: Facts): Record<string, unknown> {
  const p = getProposal(tx, proposalId)!;
  const r = projectRepoRow(tx, p.project);
  const head = tx.db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(p.project, integrationRef(r.integration_branch)) as
    | { expected_oid: string }
    | undefined;
  const rationale = p.rationale
    ? (tx.db.prepare('SELECT "post_scan", "missing_at" FROM "records" WHERE "id" = ?').get(p.rationale) as { post_scan: string; missing_at: string | null } | undefined)
    : undefined;
  const scopeApproval = tx.db.prepare('SELECT "id" FROM "scope_approvals" WHERE "proposal" = ? ORDER BY "created_at" LIMIT 1').get(p.id) as { id: string } | undefined;
  return {
    proposal_status: p.status,
    tree: p.tree_id,
    diff_hash: p.diff_hash,
    base_revision: p.base_revision,
    integration_revision: facts && 'head' in facts ? facts.head : (head?.expected_oid ?? null),
    classification: p.classified_change_kind,
    // A rationale a later detector matched is a changed dependency; the scan
    // of a record that is still pending is not (SEAM.md §77).
    evidence: { rationale: p.rationale, quarantined: rationale?.post_scan === 'hit', missing: rationale ? rationale.missing_at !== null : null },
    effective_protected_version: effectiveVersion(tx.db, p.project)?.id ?? null,
    spec_revision: null,
    scope_approval: scopeApproval?.id ?? null,
    policy_revision: policyRevisionId(tx.db, p.project),
  };
}

function correctionSpec(changeKind: 'tightening' | 'loosening' | 'unclassifiable'): KindSpec {
  return {
    preview(tx, d, facts) {
      const p = getProposal(tx, d.subject_id);
      if (!p || !['classified', 'awaiting_human'].includes(p.status) || p.classified_change_kind !== changeKind) return null;
      const manifest = correctionManifest(tx, p.id, facts);
      const r = projectRepoRow(tx, p.project);
      const blockers = p.changes_required_set === 1 && manifest.scope_approval === null ? ['APPROVAL_MISSING'] : [];
      return {
        manifest,
        options: [
          {
            key: 'approve',
            label: 'Approve',
            consequence: `The proposal is applied to ${integrationRef(r.integration_branch)} as one protected commit, and a new protected version takes effect.`,
            effect: { proposal: p.id, tree: p.tree_id, ref: integrationRef(r.integration_branch) },
            blockers,
          },
          { key: 'reject', label: 'Reject', consequence: 'The proposal is rejected and nothing is applied.', effect: { proposal: p.id } },
        ],
        question: `A protected proposal (${p.id}), classified ${changeKind}, awaits approval.`,
      };
    },
    manifest: (tx, d, facts) => correctionManifest(tx, d.subject_id, facts),
    reraise: true,
    answer(tx, d, option, note) {
      const p = getProposal(tx, d.subject_id)!;
      consumeDecision(tx, d, option, note);
      if (option !== 'approve') {
        tx.db.prepare(`UPDATE "protected_proposals" SET "status" = 'rejected' WHERE "id" = ?`).run(p.id);
        tx.emit('protected.rejected', { project: p.project, proposal: p.id }, { decision: d.id });
        return consumed(d);
      }
      approveProposal(tx, p, tx.actor.actor_kind, 'human');
      const approval = recordApproval(tx, d, { consequence: `protected proposal ${p.id} applied`, subjectType: 'protected_proposal', subjectId: p.id, resultHash: p.diff_hash });
      const plan = (JSON.parse(d.options) as { key: string; effect_plan: Record<string, unknown> }[]).find((o) => o.key === 'approve')!.effect_plan;
      return consumed(d, [recordIntent(tx, d, { approval, kind: 'protected_application', plan })]);
    },
    withdraw(tx, d) {
      withdrawApproval(tx, d.subject_id);
      return true;
    },
  };
}

export const KINDS: Record<DecisionKind, KindSpec> = {
  blocker: BLOCKER,
  stop_confirm: controlSpec('stop_confirm'),
  abandon_confirm: controlSpec('abandon_confirm'),
  out_of_band_change: OOB,
  policy_widening: WIDENING,
  finding_disposition: DISPOSITION,
  severity_lower: SEVERITY,
  finding_applicability_exclusion: EXCLUSION,
  check_correction_tightening: correctionSpec('tightening'),
  check_correction_loosening: correctionSpec('loosening'),
  check_correction_unclassifiable: correctionSpec('unclassifiable'),
};

// What each enabled kind's dependency manifest binds, at least (D1 A.8;
// build spec §6 correction 22): every preview's manifest holds these keys,
// which raising a question checks, and the executable contract (contract/)
// states this table.
const CORRECTION_KEYS = ['proposal_status', 'tree', 'diff_hash', 'base_revision', 'integration_revision', 'classification', 'evidence', 'effective_protected_version', 'spec_revision', 'scope_approval', 'policy_revision'];
const CONTROL_KEYS = ['run', 'stoppable', 'domains', 'lease_generation', 'workspace', 'workspace_snapshot', 'workspace_fate', 'work_fate'];
export const MANIFEST_KEYS: Readonly<Record<DecisionKind, readonly string[]>> = {
  blocker: ['subject_status', 'quarantined', 'cause', 'evidence', 'continuation'],
  stop_confirm: CONTROL_KEYS,
  abandon_confirm: CONTROL_KEYS,
  out_of_band_change: ['subject_kind', 'expected', 'found'],
  policy_widening: ['base_revision', 'base_blob', 'proposed_policy', 'widens'],
  finding_disposition: [
    'finding_status',
    'disposition',
    'proposed_disposition',
    'effective_severity',
    'sensitive_area',
    'evidence',
    'defer_target',
    'linked_issue',
    'applicable',
    'candidate_revision',
    'acceptance_content_hash',
    'policy_revision',
  ],
  severity_lower: ['finding_status', 'effective_severity', 'to', 'sensitive_area', 'applicable', 'candidate_revision', 'acceptance_content_hash', 'policy_revision'],
  finding_applicability_exclusion: [
    'assessment_status',
    'evidence',
    'reason',
    'proposed_by_run',
    'assessed_by_run',
    'finding',
    'candidate',
    'ancestry',
    'acceptance_content_hash',
    'effective_severity',
    'disposition',
    'sensitive_area',
    'blocks_gate',
    'protected_version',
    'policy_revision',
  ],
  check_correction_tightening: CORRECTION_KEYS,
  check_correction_loosening: CORRECTION_KEYS,
  check_correction_unclassifiable: CORRECTION_KEYS,
};

// ---- raising, answering, revalidating ---------------------------------------------------

// Raise the question of `kind` about a subject as it stands now, or return
// the open one with the same preview; null if the question does not stand.
export function raiseQuestion(tx: Tx, args: { project: string; kind: DecisionKind; subjectType: string; subjectId: string; scope?: string; options?: string; question?: string }): DecisionRow | null {
  const seed: Subject = { project: args.project, kind: args.kind, subject_type: args.subjectType, subject_id: args.subjectId, scope: args.scope ?? 'subject', options: args.options ?? '[]' };
  const p = KINDS[args.kind].preview(tx, seed);
  if (p === null) return null;
  const missing = MANIFEST_KEYS[args.kind].filter((key) => !(key in p.manifest));
  if (missing.length > 0) throw new Error(`the ${args.kind} manifest lacks ${missing.join(', ')}`);
  const row = raiseDecision(tx, {
    project: args.project,
    kind: args.kind,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    scope: args.scope,
    question: args.question ?? p.question,
    options: p.options,
    manifest: p.manifest,
    blockedWorkItems: p.blockedWorkItems,
    blockedOperation: p.blockedOperation,
  });
  if (args.kind === 'blocker' && args.subjectType === 'work_item') {
    // The item's blocker names the decision that holds it.
    const item = getWorkItem(tx, args.subjectId)!;
    const blocker = parseJson<Record<string, unknown>>(item.blocker);
    if (blocker && blocker.decision !== row.id) tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ ...blocker, decision: row.id }), item.id);
  }
  return row;
}

const previewOf = (d: DecisionRow, p: Preview): string => currentPreview(d, p.manifest, p.options);

// POST /v1/projects/:p/decisions/:d/answer (D1 §10.5; SEAM.md §76).
export function answerQueued(tx: Tx, args: { project: string; decision: string; option: unknown; preview_hash: unknown; note: unknown; facts?: Facts | undefined }): CommandResult {
  const d = getDecision(tx, args.decision);
  if (!d || d.project !== args.project) throw notFound('decision', args.decision);
  if (d.status === 'invalidated') {
    throw new Refusal(409, 'decision_invalidated', `Decision ${d.id} was invalidated: what it was bound to changed, or its subject was settled another way.`, 'Read the current decision about its subject, if there is one.', {
      decision: d.id,
      status: d.status,
    });
  }
  if (d.status !== 'open') throw new Refusal(409, 'decision_consumed', `Decision ${d.id} is ${d.status}, not open.`, 'Read the decision again; it cannot be answered twice.', { decision: d.id, status: d.status });
  const spec = KINDS[d.kind as DecisionKind];
  const offered = JSON.parse(d.options) as { key: string; blockers?: string[] }[];
  if (typeof args.option !== 'string' || !offered.some((o) => o.key === args.option)) {
    throw new Refusal(400, 'invalid_value', `"option" must be one of ${offered.map((o) => o.key).join(', ')}.`, 'Answer with an option the decision offers.', { field: 'option' });
  }
  const facts = args.facts ?? {};
  const now = spec.preview(tx, d, facts);
  if (typeof args.preview_hash !== 'string' || args.preview_hash !== d.preview_hash || now === null || previewOf(d, now) !== d.preview_hash) throw stale(d);
  const option = now.options.find((o) => o.key === args.option)!;
  if ((option.blockers ?? []).length > 0) {
    throw new Refusal(409, 'illegal_transition', `Option ${option.key} of decision ${d.id} cannot be chosen now: ${option.blockers!.join(', ')}.`, 'Resolve what the option lists, then answer the next preview.', {
      decision: d.id,
      blockers: option.blockers,
    });
  }
  return spec.answer(tx, d, args.option, typeof args.note === 'string' ? args.note : null, facts);
}

// POST /v1/projects/:p/decisions/answer-batch (D1 §10.3; SEAM.md §81): one
// combined plan, consumed in one transaction or not at all. Two answers that
// both change the project's policy against one base conflict.
export function answerBatch(tx: Tx, args: { project: string; answers: unknown; facts?: Record<string, Facts> }): CommandResult {
  if (!Array.isArray(args.answers) || args.answers.length === 0) {
    throw new Refusal(400, 'invalid_value', '"answers" must be a non-empty array.', 'Send {"answers": [{"decision", "option", "preview_hash"}]}.', { field: 'answers' });
  }
  const answers = args.answers as { decision?: unknown; option?: unknown; preview_hash?: unknown }[];
  const rows: DecisionRow[] = [];
  for (const a of answers) {
    if (typeof a !== 'object' || a === null || typeof a.decision !== 'string') throw new Refusal(400, 'invalid_value', 'Each answer names a decision.', 'Send {"decision", "option", "preview_hash"}.', { field: 'answers' });
    const d = getDecision(tx, a.decision);
    if (!d || d.project !== args.project) throw notFound('decision', a.decision);
    rows.push(d);
  }
  const widenings = rows.filter((d) => d.kind === 'policy_widening');
  if (widenings.length > 1 && answers.filter((a, i) => rows[i]!.kind === 'policy_widening' && a.option === 'approve').length > 1) {
    throw new Refusal(409, 'batch_conflict', 'Two answers of the batch would each change the project policy from the same base.', 'Answer them one at a time; nothing was consumed.', {
      decisions: widenings.map((d) => d.id),
    });
  }
  const effects: Effect[] = [];
  const results: unknown[] = [];
  for (const [i, a] of answers.entries()) {
    const r = answerQueued(tx, { project: args.project, decision: rows[i]!.id, option: a.option, preview_hash: a.preview_hash, note: null, facts: args.facts?.[rows[i]!.id] });
    effects.push(...(r.effects ?? []));
    results.push(r.body);
  }
  return { status: 200, body: { answers: results }, effects };
}

// Immediately before an effect (D1 §10.5): the intent's preconditions are
// read again, from the store and from what the main thread read afresh. If
// one differs, the intent is invalidated, the consumption's local transition
// is withdrawn, and the next generation is raised with no approval. Returns
// whether the effect may go on.
export function revalidateIntent(tx: Tx, intentId: string, facts: Facts): boolean {
  const intent = tx.db.prepare('SELECT * FROM "effect_intents" WHERE "id" = ?').get(intentId) as
    | { id: string; project: string; decision: string; status: string; preconditions: string; kind: string }
    | undefined;
  if (!intent || intent.status !== 'pending') return false;
  const d = getDecision(tx, intent.decision)!;
  const spec = KINDS[d.kind as DecisionKind];
  const now = spec.manifest(tx, d, facts);
  if (canonical(now) === canonical(JSON.parse(intent.preconditions))) return true;
  tx.db.prepare(`UPDATE "effect_intents" SET "status" = 'invalidated', "invalidated_reason" = 'EFFECT_PRECONDITION_CHANGED' WHERE "id" = ?`).run(intent.id);
  tx.emit('intent.invalidated', { project: intent.project, decision: d.id, intent: intent.id }, { reason: 'EFFECT_PRECONDITION_CHANGED', kind: intent.kind });
  if (spec.withdraw?.(tx, d)) raiseQuestion(tx, { project: d.project, kind: d.kind as DecisionKind, subjectType: d.subject_type, subjectId: d.subject_id, scope: d.scope, options: d.options });
  return false;
}

// The tick's decision step (D1 §§4.6, 8.1 step 6, 10.4): every open decision
// of the project is computed again; one whose dependency changed is
// invalidated and, if its question stands, raised in its next generation;
// one whose question no longer stands is invalidated. Then aging: an open
// decision past its target is escalated, once per generation, with one
// notification intent.
export function reviewDecisions(tx: Tx, args: { project: string; channel: string }): { escalated: number } {
  const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY "seq"`).all(args.project) as DecisionRow[];
  for (const d of open) {
    const spec = KINDS[d.kind as DecisionKind];
    if (!spec || d.kind === 'out_of_band_change') continue;
    const p = spec.preview(tx, d);
    if (p === null) {
      invalidateDecision(tx, d, 'the question no longer stands');
      continue;
    }
    if (previewOf(d, p) === d.preview_hash) continue;
    if (!spec.reraise) {
      invalidateDecision(tx, d, 'what it was bound to changed');
      continue;
    }
    raiseQuestion(tx, { project: d.project, kind: d.kind as DecisionKind, subjectType: d.subject_type, subjectId: d.subject_id, scope: d.scope, options: d.options });
  }
  let escalated = 0;
  const now = Date.parse(tx.at);
  const aging = tx.db
    .prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "status" = 'open' AND "escalated_at" IS NULL AND "target_seconds" IS NOT NULL ORDER BY "seq"`)
    .all(args.project) as (DecisionRow & { raised_at: string; target_seconds: number })[];
  for (const d of aging) {
    if (Date.parse(d.raised_at) + d.target_seconds * 1000 > now) continue;
    tx.db.prepare('UPDATE "decisions" SET "escalated_at" = ? WHERE "id" = ?').run(tx.at, d.id);
    const id = tx.newId('ntf_');
    tx.db
      .prepare(`INSERT INTO "notification_intents" ("id", "created_at", "project", "source", "channel", "key", "status", "attempts") VALUES (?, ?, ?, ?, ?, ?, 'queued', 0)`)
      .run(id, tx.at, d.project, JSON.stringify({ decision: d.id }), args.channel, `${d.id}:${d.semantic_generation}`);
    tx.emit('decision.escalated', { project: d.project, decision: d.id }, { kind: d.kind, target_seconds: d.target_seconds, notification: id });
    tx.emit('notification.queued', { project: d.project, notification: id, decision: d.id }, { channel: args.channel });
    escalated++;
  }
  return { escalated };
}

// The open decision of a kind about a subject, if any.
export function openQuestion(tx: Tx, project: string, kind: DecisionKind, subjectType: string, subjectId: string): DecisionRow | undefined {
  return openDecision(tx, project, kind, subjectType, subjectId);
}

export { CORRECTION_KIND };

// What the main thread reads afresh before an answer (SEAM.md §79): for an
// out-of-band observation, where its subject is.
export function decisionSubjectRead(db: Db, args: { project: string; decision: string }) {
  const d = db.prepare('SELECT "id", "project", "kind", "subject_type", "subject_id", "status" FROM "decisions" WHERE "id" = ?').get(args.decision) as
    | { id: string; project: string; kind: string; subject_type: string; subject_id: string; status: string }
    | undefined;
  if (!d || d.project !== args.project) return null;
  if (d.kind !== 'out_of_band_change') return { kind: d.kind, oob: null };
  const row = oobRow(db, d.subject_id);
  if (!row) return { kind: d.kind, oob: null };
  const repo = (db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(row.project) as { dev_repo_path: string }).dev_repo_path;
  const ref = row.ref ? (db.prepare('SELECT "ref" FROM "ref_registry" WHERE "id" = ?').get(row.ref) as { ref: string }).ref : null;
  const checkout = row.checkout ? (db.prepare('SELECT "path" FROM "managed_checkouts" WHERE "id" = ?').get(row.checkout) as { path: string }).path : null;
  return { kind: d.kind, oob: { subject_kind: row.subject_kind, repo, ref, checkout } };
}
