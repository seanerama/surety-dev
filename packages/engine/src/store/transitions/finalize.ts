// The domain finalizers of the four journal kinds (D1 §7.10; build spec §6
// correction 14; ../contract/journal.json `finalizers`). A finalizer writes
// the receipts its operation exists for, in the transaction that appends the
// journal's `finalized`, from the inputs fixed with the intent
// (`operations.finalizer_inputs`): never from a newer plan in the store, a
// stage with the same number elsewhere, or a file in a role's workspace. It
// runs once: a finalized operation is never finalized again, so the receipts
// keep the identities they were written with.

import { limitsChanged } from './prototype.js';
import { recordCompatibility } from '../../deploy/compatibility.js';
import type { TreeAnswer } from '../../deploy/output-kind.js';
import { followUpsDue } from '../../plan/deferral.js';
import { recordMetMilestones } from '../../scheduler/milestones.js';
import { reraiseOnPolicy } from '../../adopt/records.js';
import { conformanceNominated } from '../../adopt/conformance.js';
import { illegal } from './common.js';
import { markStale } from './evidence.js';
import { type AppliedInputs, type ProposalInputs, finalizeApplied, finalizeProposal } from '../../spec/change.js';
import { type ApplicationInputs, completeIntent, effectiveVersion, finalizeApplication } from './protected.js';
import type { IntentSpec, OpDetail } from './journal.js';
import { intendOperation } from './journal.js';
import { type Baseline, type RefKind, addCheckout, nextCounter, openLineage, recordRevision, registerRef, releaseCheckouts } from './repo.js';
import type { Tx } from './tx.js';
import { cancelSuperseded, registerAtNomination } from './checks.js';
import { type ChainOrigin, getWorkItem, observeTrigger, registerPlan, transitionWork } from './work.js';
import { reconcileRepairs } from './repair.js';
import { type ReplanPrepared, finalizeReplan, rebindHarmless } from '../../plan/bundle.js';
import { type PreparedBrief, recordPreparedBrief } from '../../prototype/brief.js';
import { supersededWhileRunning } from '../../plan/replace.js';
import { registerPhaseAtNomination } from '../../plan/phase.js';
import { type ApprovedInputs, finalizeApproved } from '../../spec/approval-effect.js';
import { type InventoryRefInputs, designTurnedOff, designTurnedOn, finalizeInventoryRef, recordInventory } from '../../design/store.js';
import { heldStages } from '../../design/readiness.js';
import { reviewDesignDue } from '../../design/due.js';
import { type AssetRefInputs, finalizeAssetRef } from '../../design/assets-submit.js';
import { type ReviewRefusedRefInputs, finalizeReviewRefused } from '../../design/review-refused.js';
import { recordBindings } from '../../design/asset-bindings.js';

export interface WorkspaceInputs {
  purpose: 'workspace';
  run: string;
  path: string;
  base: string;
  baseline: Baseline;
}

export interface DiscardInputs {
  purpose: 'discard';
  run: string;
  workspace: string;
}

export interface CommitInputs {
  purpose: 'run' | 'bootstrap' | 'policy' | 'protected' | 'stash' | 'adopt' | 'spec' | 'design';
  run?: string;
  sha: string;
  parent: string;
  tree: string;
  keep_ref: string;
  revision_kind: string;
  checkpoint?: boolean;
  workspace?: string;
  // An operation to intend once this commit is finalized (the ref update of
  // a bootstrap or a policy change), so that the chain survives a crash.
  follow?: IntentSpec;
}

export interface PlanInput {
  phase: number;
  path: string;
  stages: { number: number; goal: string }[];
}

export interface RefInputs {
  purpose: 'integration' | 'nomination' | 'bootstrap' | 'policy' | 'oob_keep' | 'oob_discard' | 'oob_stash' | 'oob_adopt' | 'protected' | 'spec_change' | 'spec_applied' | 'spec_approved' | 'design_inventory' | 'design_asset' | 'design_review_refused';
  ref: string;
  ref_kind: RefKind;
  immutable?: boolean;
  new_oid: string;
  // integration
  run?: string;
  work_item?: string;
  stage?: string | null;
  plans?: PlanInput[];
  // D6 §5.5 (B02): a session's checkpoint, whose integration registers
  // nothing it carries.
  checkpoint?: boolean;
  // A replan's plan in Appendix B.5's form, checked before the intent
  // (runs/accept.ts; D6 §5.6): published here as its routing says.
  replan?: ReplanPrepared;
  // A rapid prototype's brief preparation (slice E3): the brief and the
  // specification's semantics, prepared before the intent (runs/accept.ts);
  // its spec_approval raised here (prototype/brief.ts).
  brief?: PreparedBrief;
  architect?: boolean;
  nominate?: { by: 'engine_cadence' | 'builder_request' } | null;
  chain?: number;
  // The origin of the chain (D6 §6.5; K3): carried to the work it makes.
  chain_origin?: ChainOrigin | null;
  // nomination
  seq?: number;
  by?: 'engine_cadence' | 'builder_request';
  // the revision's module presence as read before the intent (D3 §4.1)
  module_presence?: { modules: string[]; read_at: string; basis: string };
  // the revision's tree as read before the intent (the deployment
  // compatibility, the static-preview shapes §5)
  output_tree?: TreeAnswer;
  // policy
  revision?: number;
  blob?: string;
  effective?: Record<string, number>;
  change?: Record<string, number>;
  // out-of-band
  oob?: string;
  // an adopted checkout, and the baseline it holds once the branch moved
  checkout?: string;
  baseline?: Baseline;
  // a policy that widens authority, and the decision that confirmed it
  widens?: boolean;
  decision?: string;
  // the effect intent this operation completes
  intent?: string | null;
  // D7 §6.5 (G15): a UI Builder's validated asset bindings
  asset_bindings?: { slot: string; variant: string; target: string; path: string; form: 'copy' | 'derived'; slot_version: number }[];
  // D7 §4.4: an inventory committed with a policy change turning design on
  design_inventory?: { digest: string; inventory: unknown; manifest: unknown; incarnation: string };
}

export function runFinalizer(tx: Tx, op: OpDetail): Record<string, unknown> {
  switch (op.kind) {
    case 'worktree_add':
      return finalizeWorkspace(tx, op, op.inputs as unknown as WorkspaceInputs);
    case 'worktree_remove':
      return finalizeDiscard(tx, op.inputs as unknown as DiscardInputs);
    case 'commit_tree':
      return finalizeCommit(tx, op, op.inputs as unknown as CommitInputs);
    case 'ref_update':
      return finalizeRef(tx, op, op.inputs as unknown as RefInputs);
    default:
      throw illegal(`a finalizer for ${String(op.kind)}`, { operation: op.id });
  }
}

// worktree_add: the run's workspaces row and its managed checkout. A
// worktree adopted after its run is over (SEAM.md §45) is retained at once.
function finalizeWorkspace(tx: Tx, op: OpDetail, inputs: WorkspaceInputs): Record<string, unknown> {
  const run = tx.db.prepare('SELECT "state" FROM "runs" WHERE "id" = ?').get(inputs.run) as { state: string };
  const disposition = run.state === 'finalizing' || run.state === 'ended' ? 'retained' : 'active';
  const id = tx.newId('ws_');
  tx.db
    .prepare(
      `INSERT INTO "workspaces" ("id", "created_at", "project", "run", "path", "base_revision", "current_base", "disposition")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, op.project, inputs.run, inputs.path, inputs.base, inputs.base, disposition);
  tx.db.prepare('UPDATE "runs" SET "workspace" = ? WHERE "id" = ?').run(id, inputs.run);
  addCheckout(tx, { project: op.project, kind: 'run_workspace', path: inputs.path, baseline: inputs.baseline, run: inputs.run });
  return { workspace: id };
}

// worktree_remove: the workspace discarded; it is no longer a managed checkout.
function finalizeDiscard(tx: Tx, inputs: DiscardInputs): Record<string, unknown> {
  tx.db.prepare(`UPDATE "workspaces" SET "disposition" = 'discarded', "disposed_at" = ? WHERE "id" = ?`).run(tx.at, inputs.workspace);
  releaseCheckouts(tx, { run: inputs.run });
  return { workspace: inputs.workspace };
}

// commit_tree: the revision of the commit and the registered keep ref that
// makes it reachable; for a checkpoint, the workspace's current base.
function finalizeCommit(tx: Tx, op: OpDetail, inputs: CommitInputs): Record<string, unknown> {
  const revision = recordRevision(tx, { project: op.project, sha: inputs.sha, parent: inputs.parent, kind: inputs.revision_kind, run: inputs.run ?? null });
  registerRef(tx, { project: op.project, ref: inputs.keep_ref, kind: 'keep', expected: inputs.sha });
  if (inputs.checkpoint && inputs.workspace) {
    const ws = tx.db.prepare('SELECT "checkpoints" FROM "workspaces" WHERE "id" = ?').get(inputs.workspace) as { checkpoints: string };
    const list = JSON.parse(ws.checkpoints) as string[];
    list.push(revision);
    tx.db.prepare('UPDATE "workspaces" SET "current_base" = ?, "checkpoints" = ? WHERE "id" = ?').run(inputs.sha, JSON.stringify(list), inputs.workspace);
  }
  let follow: string | null = null;
  if (inputs.follow) {
    const made = intendOperation(tx, inputs.follow);
    if ('operation' in made) follow = made.operation;
  }
  return { revision, follow };
}

function finalizeRef(tx: Tx, op: OpDetail, inputs: RefInputs): Record<string, unknown> {
  registerRef(tx, { project: op.project, ref: inputs.ref, kind: inputs.ref_kind, expected: inputs.new_oid, immutable: inputs.immutable === true });
  switch (inputs.purpose) {
    case 'integration':
      return finalizeIntegration(tx, op, inputs);
    case 'nomination':
      return finalizeNomination(tx, op, inputs);
    case 'bootstrap': {
      const row = tx.db.prepare('SELECT "registration_state" FROM "projects" WHERE "id" = ?').get(op.project) as { registration_state: string };
      if (row.registration_state !== 'registered') {
        tx.db.prepare(`UPDATE "projects" SET "registration_state" = 'registered' WHERE "id" = ?`).run(op.project);
        tx.emit('project.registered', { project: op.project }, { revision: inputs.new_oid });
      }
      return {};
    }
    case 'policy': {
      // The UI stages held for design under the policy this revision replaces (D7 §2).
      const designHeldBefore = heldStages(tx.db, op.project);
      const id = tx.newId('pol_');
      tx.db
        .prepare(
          `INSERT INTO "policy_revisions" ("id", "created_at", "project", "revision", "git_path", "git_blob", "changed_by", "changed_at", "diff_summary",
             "widens_authority", "committed", "effective")
           VALUES (?, ?, ?, ?, '.surety/policy.json', ?, 'human', ?, ?, ?, 1, ?)`,
        )
        .run(id, tx.at, op.project, inputs.revision, inputs.blob, tx.at, JSON.stringify(inputs.change ?? {}), inputs.widens ? 1 : 0, JSON.stringify(inputs.effective ?? {}));
      if (inputs.decision) tx.db.prepare('UPDATE "policy_revisions" SET "decision" = ? WHERE "id" = ?').run(inputs.decision, id);
      tx.db.prepare('UPDATE "projects" SET "policy_revision" = ? WHERE "id" = ?').run(id, op.project);
      tx.emit('policy.changed', { project: op.project, policy_revision: id }, { revision: inputs.revision, change: inputs.change ?? {}, commit: inputs.new_oid, widens_authority: inputs.widens === true });
      // A rapid prototype's current iteration follows its editable limit
      // keys; a raised limit reopens one that reached a limit (R4; slice
      // E2), never a stopped one (slice E5, gap 4: POST …/resume does).
      limitsChanged(tx, op.project);
      // The policy is part of every evaluation's inputs (D1 §9.5).
      markStale(tx, { project: op.project });
      // And of the adoption's open questions (D6 §8.1; SEAM.md §377).
      reraiseOnPolicy(tx, op.project);
      // Design turned on (D7 §2): the undispatched UI stages wait on it, and
      // the inventory committed with the policy is recorded.
      designTurnedOn(tx, op.project);
      // Design turned off, or to `at_alpha` (D7 §2): the holds released, a
      // waiver recorded on each stage design `off` released.
      designTurnedOff(tx, { project: op.project, held: designHeldBefore, policy_revision: id, decision: inputs.decision ?? null });
      // design_due binds the policy revision (D1 §4.6; SEAM.md §517): asked
      // again against it in this transaction, as the adoption's questions are.
      reviewDesignDue(tx, op.project);
      if (inputs.design_inventory) {
        const di = inputs.design_inventory;
        const made = finalizeInventoryRef(tx, op, { purpose: 'design_inventory', ref: inputs.ref, ref_kind: 'integration', new_oid: inputs.new_oid, project: op.project, inventory_digest: di.digest, inventory: di.inventory as never, manifest: di.manifest as never, incarnation: di.incarnation });
        recordInventory(tx, { id: made.design_inventory as string });
      }
      // A pending bundle on the head the policy commit moved stays answerable
      // (B03): the commit touches none of its bound inputs.
      if (op.payload.old_oid) rebindHarmless(tx, { project: op.project, from: op.payload.old_oid, to: inputs.new_oid });
      if (inputs.intent) completeIntent(tx, inputs.intent);
      return { policy_revision: id };
    }
    case 'protected':
      return finalizeApplication(tx, op, inputs as unknown as ApplicationInputs);
    // D6 §4.3: a spec change's proposal on its side ref; §4.5: its approval
    // integrated.
    case 'spec_change':
      return finalizeProposal(tx, op, inputs as unknown as ProposalInputs);
    case 'spec_applied':
      return finalizeApplied(tx, op, inputs as unknown as AppliedInputs);
    // D6 §3.4: spec_approval's change log row integrated; the approval.
    case 'spec_approved':
      return finalizeApproved(tx, op, inputs as unknown as ApprovedInputs);
    // D7 §4.4: the inventory's engine commit on the integration branch.
    case 'design_inventory':
      return finalizeInventoryRef(tx, op, inputs as unknown as InventoryRefInputs);
    // D7 §6.3: the owner's asset file committed by the engine.
    case 'design_asset':
      return finalizeAssetRef(tx, op, inputs as unknown as AssetRefInputs);
    // H5 (SEAM.md §553): a refused review's file moved out of active review.
    case 'design_review_refused':
      return finalizeReviewRefused(tx, op, inputs as unknown as ReviewRefusedRefInputs);
    case 'oob_stash':
      return {};
    case 'oob_keep':
      return {};
    case 'oob_adopt': {
      // The developer's edits are on the integration branch (brief B2): the
      // checkout's baseline is what it holds now (HEAD the adopted commit,
      // its index set to it by the effect, its files untouched), the
      // observation is reconciled, and the next run's base is the adopted
      // commit, which the registry now expects.
      if (inputs.checkout && inputs.baseline) tx.db.prepare('UPDATE "managed_checkouts" SET "baseline" = ? WHERE "id" = ?').run(JSON.stringify(inputs.baseline), inputs.checkout);
      tx.db.prepare(`UPDATE "out_of_band_changes" SET "disposition" = 'adopt' WHERE "id" = ? AND "disposition" IS NULL`).run(inputs.oob);
      tx.emit('repo.reconciled', { project: op.project, out_of_band_change: inputs.oob }, { disposition: 'adopt', checkout: inputs.checkout, ref: inputs.ref, adopted: inputs.new_oid });
      markStale(tx, { project: op.project });
      if (inputs.intent) completeIntent(tx, inputs.intent);
      return {};
    }
    case 'oob_discard': {
      tx.db.prepare(`UPDATE "out_of_band_changes" SET "disposition" = 'discard' WHERE "id" = ? AND "disposition" IS NULL`).run(inputs.oob);
      tx.emit('repo.reconciled', { project: op.project, out_of_band_change: inputs.oob }, { disposition: 'discard', ref: inputs.ref, restored: inputs.new_oid });
      markStale(tx, { project: op.project });
      return {};
    }
    default:
      return {};
  }
}

// The integration of a run's commit (D1 §§7.5, 7.7, 7.8): the work item
// integrated; the stage it built integrated at the commit; every phase plan
// the commit adds registered, with its stages and their work; the
// Architect's work complete; and, where the tier's cadence or the Builder's
// request says so, a nomination due.
function finalizeIntegration(tx: Tx, op: OpDetail, inputs: RefInputs): Record<string, unknown> {
  const item = inputs.work_item ? getWorkItem(tx, inputs.work_item) : undefined;
  let status = item?.status;
  if (item && item.status === 'integrating') {
    transitionWork(tx, item, 'integrated', {}, { run: inputs.run, operation: op.id, revision: inputs.new_oid });
    status = 'integrated';
  }
  // D7 §6.5 (G15): the asset bindings recorded with the stage and the revision.
  if (inputs.asset_bindings && inputs.asset_bindings.length > 0 && item && inputs.run) {
    recordBindings(tx, { project: op.project, run: inputs.run, work_item: item.id, stage: inputs.stage ?? null, revision: inputs.new_oid, bindings: inputs.asset_bindings });
  }
  if (inputs.stage) {
    tx.db.prepare(`UPDATE "stages" SET "status" = 'integrated', "integrated_revision" = ? WHERE "id" = ?`).run(inputs.new_oid, inputs.stage);
    // Its dependants' stage-code milestone (D6 §6.4; B08), after its
    // work.integrated; a deferral it was the prerequisite of, its follow-up
    // (D6 §6.2; D6-W06), once.
    recordMetMilestones(tx, op.project);
    followUpsDue(tx, op.project);
    // A stage an early replacement superseded while its Builder ran (D6
    // §5.7; the driver's ruling 10): its late integration is history, the
    // code on the branch; its work completes `superseded` and is never
    // verified, and it fulfils no replacement work.
    if (item && supersededWhileRunning(tx.db, inputs.stage)) {
      const now = getWorkItem(tx, item.id)!;
      if (now.status === 'integrated') {
        const verifying = transitionWork(tx, now, 'verifying', {}, { cause: 'superseded', stage: inputs.stage, revision: inputs.new_oid });
        transitionWork(tx, verifying, 'complete', {}, { cause: 'superseded', stage: inputs.stage, revision: inputs.new_oid });
        tx.db.prepare(`UPDATE "work_items" SET "end_cause" = 'superseded' WHERE "id" = ?`).run(item.id);
        status = 'complete';
      }
    }
  }
  const plans: string[] = [];
  // B02 (D6 §5.5): a checkpoint registers nothing, whatever it carries: a
  // session's save is draft intent. What an Architect's one-shot integration
  // commits is registered as D1 §7.8 built it, under the authority of that
  // integration (`architect_integration`), until slice 35 routes a replan's
  // plan through the check and §5.5's publication.
  const legacy = inputs.checkpoint !== true && inputs.architect === true;
  for (const plan of legacy ? (inputs.plans ?? []) : []) {
    const made = registerPlan(
      tx,
      { project: op.project, baseRevision: inputs.new_oid, authority: { kind: 'architect_integration' }, stages: plan.stages, phase: plan.phase, gitPath: plan.path, chain: inputs.chain ?? 1 },
      {},
    );
    plans.push(made.plan.id);
  }
  if (inputs.replan && inputs.run) {
    const published = finalizeReplan(tx, { project: op.project, run: inputs.run, prepared: inputs.replan, integrated: inputs.new_oid, base: op.payload.old_oid ?? null });
    if (published) plans.push(published);
  }
  if (inputs.brief && inputs.run && item) recordPreparedBrief(tx, { project: op.project, run: inputs.run, work_item: item.id, prepared: inputs.brief });
  if (inputs.architect && item && status === 'integrated') {
    const now = getWorkItem(tx, item.id)!;
    transitionWork(tx, now, 'complete', {}, { run: inputs.run, operation: op.id });
  }
  if (inputs.nominate) {
    // A nomination still due when another integration finalizes (one
    // finalized by recovery, outside the lease) is not lost (the slice-37
    // review's N3): the integration branch moves by compare-and-swap, so the
    // later revision holds the earlier one, and the due nomination is made
    // at it, a Builder's request kept, the deeper chain and both origins
    // carried.
    const before = tx.db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(op.project) as { nomination_due: string | null };
    const prior = before.nomination_due ? (JSON.parse(before.nomination_due) as { revision: string; by: string; chain: number; origin: unknown; subsumes?: string[] }) : null;
    const due = {
      revision: inputs.new_oid,
      by: prior?.by === 'builder_request' ? 'builder_request' : inputs.nominate.by,
      chain: Math.max(inputs.chain ?? 1, prior?.chain ?? 0),
      origin: inputs.chain_origin ?? prior?.origin ?? null,
      ...(prior ? { subsumes: [...(prior.subsumes ?? []), prior.revision] } : {}),
    };
    tx.db.prepare('UPDATE "projects" SET "nomination_due" = ? WHERE "id" = ?').run(JSON.stringify(due), op.project);
  }
  return { plans };
}

// A nomination (D1 §§3.3, 7.7; E11; E18): the candidate, its immutable ref,
// its lineage closed and the successor opened, its verification work, and the
// Builder's integrated work on the closed lineage now being verified.
function finalizeNomination(tx: Tx, op: OpDetail, inputs: RefInputs): Record<string, unknown> {
  const lineage = openLineage(tx, op.project);
  const candidate = tx.newId('cand_');
  const held = (
    tx.db
      .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" IN ('stage_build', 'fix') AND "status" = 'integrated' ORDER BY "seq"`)
      .all(op.project) as { id: string }[]
  ).map((r) => r.id);
  // The version it is nominated under is a historical fact (D1 §3.3).
  const version = effectiveVersion(tx.db, op.project)?.id ?? null;
  tx.db
    .prepare(
      `INSERT INTO "candidates" ("id", "created_at", "project", "seq", "revision", "lineage", "nominated_at", "nominated_by", "nominated_protected_version", "progress", "held_work")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'developing', ?)`,
    )
    .run(candidate, tx.at, op.project, inputs.seq, inputs.new_oid, lineage, tx.at, inputs.by, version, JSON.stringify(held));
  // The approved specification it is nominated under, a historical fact (D1
  // A.3; D6 §4.6).
  const spec = tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(op.project) as { id: string } | undefined;
  if (spec) tx.db.prepare('UPDATE "candidates" SET "spec_revision" = ? WHERE "id" = ?').run(spec.id, candidate);
  // The presence frozen at intent (D3 §4.1); readers take it only under the
  // module definitions it was read under (evidence.ts presenceIn).
  if (inputs.module_presence) tx.db.prepare('UPDATE "candidates" SET "module_presence" = ? WHERE "id" = ?').run(JSON.stringify(inputs.module_presence), candidate);
  tx.db.prepare('UPDATE "lineages" SET "open" = 0 WHERE "id" = ?').run(lineage);
  const branch = (tx.db.prepare('SELECT "branch" FROM "lineages" WHERE "id" = ?').get(lineage) as { branch: string }).branch;
  tx.db
    .prepare('INSERT INTO "lineages" ("id", "created_at", "project", "branch", "started_from_candidate", "open") VALUES (?, ?, ?, ?, ?, 1)')
    .run(tx.newId('lin_'), tx.at, op.project, branch, candidate);
  tx.emit('candidate.nominated', { project: op.project, candidate }, { seq: inputs.seq, revision: inputs.new_oid, nominated_by: inputs.by });
  // A conformance stage bound at publication is held from here (K11).
  conformanceNominated(tx, { project: op.project, candidate });
  // The candidate whose lineage this nomination closes is superseded by it
  // (D1 A.3 `superseded_by`, A.6; SEAM.md §192): the one change a later
  // nomination makes to an earlier candidate. Its queued executions are
  // cancelled before launch and its evaluations are stale (Q9 refuses them).
  const opened = tx.db.prepare('SELECT "started_from_candidate" FROM "lineages" WHERE "id" = ?').get(lineage) as { started_from_candidate: string | null };
  if (opened.started_from_candidate !== null) {
    const earlier = opened.started_from_candidate;
    const changed = tx.db.prepare('UPDATE "candidates" SET "superseded_by" = ? WHERE "id" = ? AND "superseded_by" IS NULL').run(candidate, earlier).changes;
    if (changed > 0) {
      tx.emit('candidate.superseded', { project: op.project, candidate: earlier }, { by: candidate });
      markStale(tx, { candidate: earlier });
    }
  }
  for (const id of held) {
    const item = getWorkItem(tx, id)!;
    transitionWork(tx, item, 'verifying', {}, { candidate });
  }
  const due = tx.db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(op.project) as { nomination_due: string | null };
  if (due.nomination_due !== null && (JSON.parse(due.nomination_due) as { revision: string }).revision === inputs.new_oid) {
    tx.db.prepare('UPDATE "projects" SET "nomination_due" = NULL WHERE "id" = ?').run(op.project);
  }
  // The nomination's checks, registered in its finalizer (D3 §2.5; L2);
  // at T1 the phase's own nomination registers the phase scope's too (D6
  // §5.8; reading 8): all of them before the verification work.
  registerAtNomination(tx, { project: op.project, candidate });
  registerPhaseAtNomination(tx, { project: op.project, candidate });
  const verification = observeTrigger(
    tx,
    { project: op.project, kind: 'verification', trigger_source: 'nomination', trigger_id: candidate, trigger_generation: 1, subject: { candidate }, chain: inputs.chain ?? 1, chain_origin: inputs.chain_origin ?? null },
    {},
  );
  cancelSuperseded(tx, op.project);
  // The items now verifying are reconciled (D3 §2.10): a failure already
  // recorded at their current candidate is repaired here.
  reconcileRepairs(tx, op.project);
  // Whether the environments can host the new candidate's output, from its
  // tree as read before the intent (the static-preview shapes, §5).
  recordCompatibility(tx, { project: op.project, trigger: 'candidate_nominated', tree: inputs.output_tree ?? null });
  return { candidate, verification: verification.work_item.id };
}

// The next candidate number and its ref (D1 §7.2: refs/surety/cand/<seq>).
export function nextCandidateSeq(tx: Tx, project: string): number {
  return nextCounter(tx, project, 'candidates');
}
