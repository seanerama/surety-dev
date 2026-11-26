// The classifier, the store's side (D3 §§1.6, 3.1 to 3.4, A.3, A.7; B02,
// N01, T10, Q5, K8, L5; SEAM.md §§215 to 218): the classification of a
// captured proposal, recorded at a tick after its capture and never in the
// capturing transaction; a Reviewer's approval under `classifier_authority`;
// and the revalidation of an application's whole binding immediately before
// it begins and when it is replayed.
//
// What the classifier reads of git (the two trees' discoveries and entries)
// is read on the main thread (checks/classify-inputs.ts) and handed in; the
// classification itself is computed here, against the requirement index as
// it stands in the transaction that records it.

import { proposalBoundaryErrors } from './checks.js';
import { type AuthoritySetting, type Classified, type ClassifiedKind, DEFAULT_AUTHORITY, authorityInForce, classify, runningClassifierVersion } from '../../checks/classify.js';
import type { ClassifyInputs } from '../../checks/classify-inputs.js';
import type { Discovery } from '../../checks/discovery.js';
import { specRevision } from './baseline.js';
import { knownCriteria } from './checks.js';
import { canonical, sha256 } from './common.js';
import { type DecisionKind, type DecisionRow, invalidateDecision } from './decisions.js';
import { observeTrigger } from './work.js';
import { refuseOperation, opDetail } from './journal.js';
import { CORRECTION_KIND, type ProposalRow, approveProposal, effectiveVersion, getProposal, settleProposalFindings } from './protected.js';
import { type Facts, correctionManifest, invalidateIntent, raiseQuestion } from './queue.js';
import { engineSettings } from './settings.js';
import { correctionProposalDecided } from '../../spec/change.js';
import { POLICY_ACTOR, briefScope, runIteration } from './policy-fix.js';
import { recordDelegatedAction } from './delegation.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

// What the engine records on a proposal it classified (D3 A.3; SEAM.md §216).
export interface StoredClassification extends Classified {
  effective_version: string;
  spec_revision: string;
  classifier_version: number;
  // The setting as it is in force (SEAM.md §217): `authoritative` only when
  // it names the running classifier.
  classifier_authority: 'recommend' | 'authoritative';
  // The discovery of the proposal's tree, frozen (D3 §1.4): the new
  // version's checks when it is applied.
  discovery: Discovery;
  // D6 §6.2 (B07): the existing checks whose input fingerprint moves.
  fingerprint_changes?: { check: string; from: string; to: string }[];
}

// The configured setting (A.7), as the store was handed it at open.
export const configuredAuthority = (): AuthoritySetting => {
  try {
    return engineSettings().classifier_authority ?? DEFAULT_AUTHORITY;
  } catch {
    return DEFAULT_AUTHORITY;
  }
};

export const authorityNow = (): 'recommend' | 'authoritative' => authorityInForce(configuredAuthority(), runningClassifierVersion());

// The proposal's classification column, parsed.
function classificationJson(db: Db, proposal: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT "classification" FROM "protected_proposals" WHERE "id" = ?').get(proposal) as { classification: string | null } | undefined;
  return row?.classification ? (JSON.parse(row.classification) as Record<string, unknown>) : null;
}

// Whether the engine's classifier gave the proposal its class. A class the
// harness fixture set (SEAM.md §§67, 215) is not the engine's: the fixture
// replaces the column with the discovery alone, so the class stands and is
// never classified again by the engine (the driver's ruling 1).
export const engineClassified = (json: Record<string, unknown> | null): boolean => typeof json?.classifier_version === 'number';

// A value that differs whenever the discovery does (SEAM.md §218; its form
// is not pinned).
export const discoveryHash = (d: Discovery | null | undefined): string | null => (d ? sha256(canonical(d)) : null);

function buildClassification(tx: Tx, project: string, effective: string, inputs: ClassifyInputs): StoredClassification {
  const c = classify(inputs.p0, inputs.p1, knownCriteria(tx.db, project));
  // D6 §6.2 (B07; SEAM.md §428): every existing check whose input
  // fingerprint the proposal moves, with the fingerprint of its inputs
  // before and after; [] when none moves. The class is the classifier's.
  const before = new Map(inputs.p0.discovery.checks.map((x) => [x.key, x]));
  const fingerprint_changes = inputs.p1.discovery.checks
    .filter((x) => before.has(x.key))
    .map((x) => ({ check: x.key, from: sha256(canonical(before.get(x.key)!.input_manifest)), to: sha256(canonical(x.input_manifest)) }))
    .filter((x) => x.from !== x.to)
    .sort((a, b) => a.check.localeCompare(b.check));
  return {
    ...c,
    fingerprint_changes,
    effective_version: effective,
    spec_revision: specRevision(tx.db, project),
    classifier_version: runningClassifierVersion(),
    classifier_authority: authorityNow(),
    discovery: inputs.p1.discovery,
  };
}

function writeClassification(tx: Tx, p: ProposalRow, c: StoredClassification): void {
  tx.db
    .prepare('UPDATE "protected_proposals" SET "classification" = ?, "affected_checks" = ?, "classified_change_kind" = ?, "fingerprint_changes" = ? WHERE "id" = ?')
    .run(JSON.stringify(c), JSON.stringify(c.affected_checks), c.change_kind, JSON.stringify((c as { fingerprint_changes?: unknown }).fingerprint_changes ?? []), p.id);
}

// ---- classification at a tick after the capture (D3 §1.6; SEAM.md §215) --------------------

export interface Unclassified {
  proposal: string;
  repo: string;
  effective: string;
  revision: string;
  // The proposal's base and own tree: what classifiedTree rebases.
  base: string;
  tree: string;
}

// The project's captured proposals with no class, with what the main thread
// reads to classify them. A proposal whose effective version records no
// authorized commit cannot be compared with it (a store made before slice
// 17 that holds no exact record): it stays captured, never guessed.
export function unclassifiedProposals(db: Db, args: { project: string }): Unclassified[] {
  const effective = effectiveVersion(db, args.project);
  if (!effective || effective.authorized_revision === null) return [];
  const rows = db
    .prepare(
      `SELECT p."id", p."base_revision", p."tree_id", r."dev_repo_path" FROM "protected_proposals" p JOIN "projects" r ON r."id" = p."project"
       WHERE p."project" = ? AND p."status" = 'captured' AND p."classified_change_kind" IS NULL ORDER BY p."seq"`,
    )
    .all(args.project) as { id: string; base_revision: string; tree_id: string; dev_repo_path: string }[];
  return rows.map((r) => ({ proposal: r.id, repo: r.dev_repo_path, effective: effective.id, revision: effective.authorized_revision!, base: r.base_revision, tree: r.tree_id }));
}

// The project's pending proposals the engine classified at an effective
// version that is no longer the effective one (the driver's ruling on loop
// run 1, item 3): another proposal was applied while they waited for their
// decision. Each is classified again, on its changes rebased onto the
// effective revision (reclassifyProposal). An approved proposal is the
// application's revalidation's (revalidateApplication); a fixture's class
// stands (the driver's ruling 1).
export function pendingReclassification(db: Db, args: { project: string }): Unclassified[] {
  const effective = effectiveVersion(db, args.project);
  if (!effective || effective.authorized_revision === null) return [];
  const rows = db
    .prepare(
      `SELECT p."id", p."base_revision", p."tree_id", p."classification", r."dev_repo_path" FROM "protected_proposals" p JOIN "projects" r ON r."id" = p."project"
       WHERE p."project" = ? AND p."status" IN ('classified', 'awaiting_human') ORDER BY p."seq"`,
    )
    .all(args.project) as { id: string; base_revision: string; tree_id: string; classification: string | null; dev_repo_path: string }[];
  return rows
    .filter((r) => {
      const json = r.classification === null ? null : (JSON.parse(r.classification) as Record<string, unknown>);
      return engineClassified(json) && json!.effective_version !== effective.id;
    })
    .map((r) => ({ proposal: r.id, repo: r.dev_repo_path, effective: effective.id, revision: effective.authorized_revision!, base: r.base_revision, tree: r.tree_id }));
}

// The engine's classification of a captured proposal: recorded, routed as
// SEAM.md §69 says (a tightening `classified`, anything else
// `awaiting_human`), and the human's question of its class raised. Only
// while the proposal is still captured with no class and the effective
// version is the one read: otherwise nothing is written, and a later tick
// reads again.
//
// Not built (accepted, D3 §3.3): a proposal classified and not yet approved
// is not classified again when the effective version or the running
// classifier changes; its stored class stands until the revalidation at the
// application, which reads both again.
export function recordClassification(tx: Tx, args: { proposal: string; effective: string; inputs: ClassifyInputs; tree?: string }): { proposal: string; change_kind: ClassifiedKind } | null {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'captured' || p.classified_change_kind !== null) return null;
  if (effectiveVersion(tx.db, p.project)?.id !== args.effective) return null;
  const c = buildClassification(tx, p.project, args.effective, args.inputs);
  const status = c.change_kind === 'tightening' ? 'classified' : 'awaiting_human';
  writeClassification(tx, p, c);
  tx.db.prepare('UPDATE "protected_proposals" SET "status" = ?, "classified_tree" = ? WHERE "id" = ?').run(status, args.tree ?? null, p.id);
  tx.emit('protected.classified', { project: p.project, proposal: p.id }, { change_kind: c.change_kind, from: p.status, to: status, classifier_version: c.classifier_version });
  // D2 (DECISIONS item 57): a tightening the approved brief authorizes is
  // approved by its policy, whatever the classifier's authority, and no
  // question is raised; otherwise the owner's question, its evidence naming
  // why the policy did not cover it (a rapid prototype's only).
  const policy = policyTightening(tx, getProposal(tx, p.id)!, c);
  if (policy.approved) return { proposal: p.id, change_kind: c.change_kind };
  raiseQuestion(tx, { project: p.project, kind: CORRECTION_KIND[c.change_kind] as DecisionKind, subjectType: 'protected_proposal', subjectId: p.id, ...policyEvidence(policy) });
  // Under `authoritative` (D3 §3.3; D6 §6.2; SEAM.md §351) a tightening is
  // the Reviewer's to approve: its review work, about the proposal, from
  // ("protected_proposal", <proposal>, 1). Under `recommend` none is made:
  // the proposal reaches the owner with no role chained.
  if (c.change_kind === 'tightening' && authorityNow() === 'authoritative') {
    observeTrigger(tx, { project: p.project, kind: 'review', trigger_source: 'protected_proposal', trigger_id: p.id, trigger_generation: 1, subject: { proposal: p.id }, chain: 0 }, {});
  }
  return { proposal: p.id, change_kind: c.change_kind };
}

// Classified again (the driver's ruling on loop run 1, item 3): the
// effective protected version moved past a pending proposal's
// classification while it waited for its decision. Its changes, rebased onto
// the new effective revision (checks/classify-inputs.ts classifiedTree), are
// classified as at capture; the question of its old class is invalidated
// and the question of its class now is raised, a new generation bound to
// the new classification. Only while the inputs were read at the version
// still in effect and the proposal is still pending with the class it had.
export function reclassifyProposal(tx: Tx, args: { proposal: string; effective: string; inputs: ClassifyInputs; tree: string }): { proposal: string; change_kind: ClassifiedKind } | null {
  const p = getProposal(tx, args.proposal);
  if (!p || (p.status !== 'classified' && p.status !== 'awaiting_human')) return null;
  if (effectiveVersion(tx.db, p.project)?.id !== args.effective) return null;
  const json = classificationJson(tx.db, p.id);
  if (!engineClassified(json) || json!.effective_version === args.effective) return null;
  const c = buildClassification(tx, p.project, args.effective, args.inputs);
  const status = c.change_kind === 'tightening' ? 'classified' : 'awaiting_human';
  writeClassification(tx, p, c);
  tx.db.prepare('UPDATE "protected_proposals" SET "status" = ?, "classified_tree" = ? WHERE "id" = ?').run(status, args.tree, p.id);
  tx.emit('protected.classified', { project: p.project, proposal: p.id }, { change_kind: c.change_kind, from: p.status, to: status, classifier_version: c.classifier_version, reclassified: true, effective_version: args.effective });
  const kinds = Object.values(CORRECTION_KIND);
  for (const d of tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'open'`).all(p.id) as DecisionRow[]) {
    if (kinds.includes(d.kind)) invalidateDecision(tx, d, `the effective protected version moved to ${args.effective}: the proposal is classified again`);
  }
  const policy = policyTightening(tx, getProposal(tx, p.id)!, c);
  if (policy.approved) return { proposal: p.id, change_kind: c.change_kind };
  raiseQuestion(tx, { project: p.project, kind: CORRECTION_KIND[c.change_kind] as DecisionKind, subjectType: 'protected_proposal', subjectId: p.id, ...policyEvidence(policy) });
  return { proposal: p.id, change_kind: c.change_kind };
}

// A proposal whose changes do not rebase onto the effective revision (the
// driver's ruling on loop run 1): a path the effective version changed
// another way. Before its approval, it is refused for repair as an
// application conflict is: rejected naming the conflict, every open
// question of it withdrawn, and the item that made it takes its repair (a
// new run from the current head).
export function classificationConflicts(tx: Tx, args: { proposal: string; revision: string; reason: string }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || (p.status !== 'captured' && p.status !== 'classified' && p.status !== 'awaiting_human')) return false;
  for (const d of tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'open'`).all(p.id) as DecisionRow[]) {
    invalidateDecision(tx, d, `the proposal does not rebase onto the effective protected version at ${args.revision}: ${args.reason}`);
  }
  tx.db.prepare(`UPDATE "protected_proposals" SET "status" = 'rejected' WHERE "id" = ?`).run(p.id);
  tx.emit('protected.rejected', { project: p.project, proposal: p.id }, { decision: null, cause: 'rebase_conflict', revision: args.revision, reason: args.reason });
  settleProposalFindings(tx, p.id);
  correctionProposalDecided(tx, { proposal: p.id, applied: false });
  return true;
}

// ---- a Reviewer's approval (E13; D3 §3.3; Q5; SEAM.md §§121, 218) -------------------------------

// A Reviewer's run "approves" a proposal. Under `classifier_authority`
// `authoritative` naming the running classifier, its approval of a
// classified tightening is recorded as the approval, bound to the
// correction manifest as it now stands, and the ticks after apply it once
// that binding is revalidated, and, where it changes `required_checks`, only
// with a validation-scope approval recorded. Otherwise (K8) it is a recommendation,
// recorded on the proposal, applying nothing: the human's question stays
// open. A Reviewer's approval of anything else is not recorded.
export function reviewerApprove(tx: Tx, args: { proposal: string; run: string }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'classified' || p.classified_change_kind !== 'tightening') return false;
  // An import that leaves the protected root undeclared (D6 §8.3; B13) is
  // applied by no one's approval.
  if (proposalBoundaryErrors(tx.db, p.id).length > 0) return false;
  // A change to `required_checks` also needs the validation-scope approval
  // (D3 §3.2; SEAM.md §69; the human's `approve` carries APPROVAL_MISSING
  // without it): with none recorded, even an authoritative Reviewer's
  // approval applies nothing and is a recommendation (the review's S2).
  const scopeMissing =
    p.changes_required_set === 1 && tx.db.prepare('SELECT 1 FROM "scope_approvals" WHERE "proposal" = ? LIMIT 1').get(p.id) === undefined;
  if (authorityNow() === 'authoritative' && !scopeMissing) {
    approveProposal(tx, p, args.run, 'reviewer');
    const binding = correctionManifest(tx, p.id);
    tx.db.prepare('UPDATE "protected_proposals" SET "approval_binding" = ? WHERE "id" = ?').run(JSON.stringify(binding), p.id);
    // The approval is the Reviewer's: the human's question of the class no
    // longer stands (a withdrawn approval raises it again).
    const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "kind" = 'check_correction_tightening' AND "status" = 'open'`).all(p.id) as DecisionRow[];
    for (const d of open) invalidateDecision(tx, d, 'approved by the Reviewer under authoritative');
    return true;
  }
  const row = tx.db.prepare('SELECT "recommendations" FROM "protected_proposals" WHERE "id" = ?').get(p.id) as { recommendations: string };
  const list = JSON.parse(row.recommendations) as { run: string }[];
  if (list.some((r) => r.run === args.run)) return false;
  // Provenance `claimed` (D3 §3.3; D2-C03): a recommendation on the
  // check_correction_tightening decision the human answers.
  list.push({ run: args.run, authority: 'reviewer', recommends: 'approve', provenance: 'claimed', at: tx.at } as { run: string });
  tx.db.prepare('UPDATE "protected_proposals" SET "recommendations" = ? WHERE "id" = ?').run(JSON.stringify(list), p.id);
  return true;
}

// ---- revalidation of the binding (D3 §3.3; K8; T10; SEAM.md §218) --------------------------------

// The facts the binding is read with now: the head the main thread read,
// and the class and discovery the classifier gives again. A class the
// fixture set stands for the class (ruling 1); the discovery is read again
// whoever classified. null when nothing was read again (no inputs): the
// binding is then never taken to hold, and nothing is invalidated on it
// (the review's M1). `current` is false when the inputs were read at
// another effective version than the one in force in this transaction:
// their classification is not kept (M2).
interface Read {
  facts: Facts;
  fresh: StoredClassification | null;
  current: boolean;
}
function freshFacts(tx: Tx, p: ProposalRow, inputs: ClassifyInputs | null | undefined, inputsVersion: string | undefined, head: string | null | undefined): Read | null {
  const facts: Facts = head === undefined ? {} : { head };
  const eff = effectiveVersion(tx.db, p.project);
  if (!inputs || !eff) return null;
  if (inputsVersion !== eff.id) return { facts, fresh: null, current: false };
  const fresh = buildClassification(tx, p.project, eff.id, inputs);
  const mine = engineClassified(classificationJson(tx.db, p.id));
  return { facts: { ...facts, classification: mine ? fresh.change_kind : p.classified_change_kind, discovery: fresh.discovery }, fresh, current: true };
}

// Whether the binding holds on what was read: 'holds'; 'changed' (withdraw);
// or 'unread' (nothing read again, or read at another effective version
// with the rest unchanged: not begun now, nothing invalidated).
function judge(tx: Tx, p: ProposalRow, intent: string | null, read: Read | null): 'holds' | 'changed' | 'unread' {
  if (read === null) return 'unread';
  const holds = bindingHolds(tx, p, intent, read.facts);
  if (!holds) return 'changed';
  return read.current ? 'holds' : 'unread';
}

// What was read again is kept, so the next generation of the human's
// question shows it: the engine's classification replaced whole; under a
// fixture's class, its discovery only.
function keepFresh(tx: Tx, p: ProposalRow, fresh: StoredClassification | null, tree?: string): void {
  // Read at another effective version: not kept (M2).
  if (fresh === null) return;
  const json = classificationJson(tx.db, p.id);
  if (engineClassified(json)) {
    writeClassification(tx, p, fresh);
    if (tree !== undefined) tx.db.prepare('UPDATE "protected_proposals" SET "classified_tree" = ? WHERE "id" = ?').run(tree, p.id);
  } else tx.db.prepare('UPDATE "protected_proposals" SET "classification" = ? WHERE "id" = ?').run(JSON.stringify({ ...(json ?? {}), discovery: fresh.discovery }), p.id);
}

// Does the application's binding still hold? The human's binding is its
// intent's preconditions (the manifest at the answer); a Reviewer's, the
// manifest at its approval, and, for a Reviewer, the authority must still
// be in force (Q5: losing the match stops a pending application).
function bindingHolds(tx: Tx, p: ProposalRow, intent: string | null, facts: Facts): boolean {
  const now = correctionManifest(tx, p.id, facts);
  if (intent !== null) {
    const row = tx.db.prepare('SELECT "preconditions" FROM "effect_intents" WHERE "id" = ?').get(intent) as { preconditions: string } | undefined;
    return row !== undefined && canonical(now) === canonical(JSON.parse(row.preconditions));
  }
  const bound = tx.db.prepare('SELECT "approval_binding" FROM "protected_proposals" WHERE "id" = ?').get(p.id) as { approval_binding: string | null };
  if (bound.approval_binding === null) return false;
  // D2: the brief's policy approval holds while the brief still covers the
  // proposal as it is read again (its class included) and the binding is
  // unchanged; the classifier's authority is not its source.
  if (p.approver_authority === 'policy') {
    const fresh = facts.classification ?? p.classified_change_kind;
    if (fresh !== 'tightening' || policyCoverage(tx, p).reason !== null) return false;
    return canonical(now) === canonical(JSON.parse(bound.approval_binding));
  }
  if (authorityNow() !== 'authoritative') return false;
  return canonical(now) === canonical(JSON.parse(bound.approval_binding));
}

// A Reviewer's approval withdrawn: the proposal awaits an approval again,
// and the human's question of its class is open, bound to the inputs as
// they now are (the driver's ruling 5).
export function withdrawReviewerApproval(tx: Tx, proposal: string): void {
  const p = getProposal(tx, proposal);
  if (!p || p.status !== 'approved' || (p.approver_authority !== 'reviewer' && p.approver_authority !== 'policy')) return;
  const status = p.classified_change_kind === 'tightening' ? 'classified' : 'awaiting_human';
  tx.db
    .prepare('UPDATE "protected_proposals" SET "status" = ?, "approver" = NULL, "approver_authority" = NULL, "approved_at" = NULL, "approval_binding" = NULL WHERE "id" = ?')
    .run(status, p.id);
  const kind = CORRECTION_KIND[p.classified_change_kind ?? ''] as DecisionKind | undefined;
  const evidence = p.approver_authority === 'policy' ? { evidence: { policy_not_covered: 'policy_approval_withdrawn: the binding changed before the application' } } : {};
  if (kind) raiseQuestion(tx, { project: p.project, kind, subjectType: 'protected_proposal', subjectId: p.id, ...evidence });
}

// Immediately before an application's journal intent (D1 §10.5; D3 §3.3):
// every bound input read again and the proposal classified again. Any
// difference, the class the same or not, withdraws the approval: the
// human's intent invalidated EFFECT_PRECONDITION_CHANGED with its next
// generation raised, or the Reviewer's approval withdrawn and the human's
// question open. Returns whether the application may begin.
export function revalidateApplication(
  tx: Tx,
  args: { proposal: string; intent: string | null; head?: string | null; inputs?: ClassifyInputs | null; inputsVersion?: string; inputsTree?: string },
): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'approved') return false;
  if (args.intent !== null) {
    const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
    if (row?.status !== 'pending') return false;
  }
  const read = freshFacts(tx, p, args.inputs, args.inputsVersion, args.head);
  const verdict = judge(tx, p, args.intent, read);
  if (verdict !== 'changed') return verdict === 'holds';
  keepFresh(tx, p, read!.fresh, args.inputsTree);
  if (args.intent !== null) invalidateIntent(tx, args.intent);
  else withdrawReviewerApproval(tx, p.id);
  return false;
}

// The same check before a replayed protected operation's effect (D3 §3.3:
// "a replay after a restart is revalidated the same way"): an operation of
// the application this engine did not itself just intend. A binding that
// no longer holds refuses the operation before any effect; its failure
// withdraws what it was for (queue.effectFailed: the intended version
// removed, the intent invalidated or the Reviewer's approval withdrawn).
// Returns whether the operation may go on.
export function revalidateOperation(tx: Tx, args: { operation: string; inputs: ClassifyInputs | null; inputsVersion?: string; inputsTree?: string; incarnation: string }): boolean {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized') return true;
  const inputs = op.inputs as { purpose?: string; proposal?: string; intent?: string | null };
  if (inputs.purpose !== 'protected' || !inputs.proposal) return true;
  const p = getProposal(tx, inputs.proposal);
  if (!p || p.status !== 'approved') return true;
  // The human's intent: named by the branch update's inputs, or, for the
  // application's commit, the intent that operation executes. A Reviewer's
  // application has none.
  const intent =
    inputs.intent ??
    (tx.db.prepare(`SELECT "id" FROM "effect_intents" WHERE "operation" = ? AND "kind" = 'protected_application'`).get(op.id) as { id: string } | undefined)?.id ??
    null;
  if (intent === null && p.approver_authority !== 'reviewer' && p.approver_authority !== 'policy') return true;
  // An intent already done or invalidated is not this check's.
  if (intent !== null) {
    const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(intent) as { status: string } | undefined;
    if (!row || row.status === 'done' || row.status === 'invalidated') return true;
  }
  const read = freshFacts(tx, p, args.inputs, args.inputsVersion, undefined);
  const verdict = judge(tx, p, intent, read);
  if (verdict !== 'changed') return verdict === 'holds';
  keepFresh(tx, p, read!.fresh, args.inputsTree);
  refuseOperation(tx, {
    operation: op.id,
    detail: { reason: 'precondition_changed', text: "the protected application's binding changed before its replay: EFFECT_PRECONDITION_CHANGED" },
    incarnation: args.incarnation,
  });
  return false;
}

// What the main thread reads to revalidate an operation's application.
export function operationApplication(db: Db, args: { operation: string }): { proposal: string; repo: string; effective: string | null; revision: string | null; base: string; tree: string } | null {
  const row = db.prepare('SELECT "finalizer_inputs" FROM "operations" WHERE "id" = ?').get(args.operation) as { finalizer_inputs: string } | undefined;
  if (!row) return null;
  const inputs = JSON.parse(row.finalizer_inputs) as { purpose?: string; proposal?: string };
  if (inputs.purpose !== 'protected' || !inputs.proposal) return null;
  const p = db.prepare('SELECT p."base_revision", p."tree_id", p."project", r."dev_repo_path" FROM "protected_proposals" p JOIN "projects" r ON r."id" = p."project" WHERE p."id" = ?').get(inputs.proposal) as
    | { base_revision: string; tree_id: string; project: string; dev_repo_path: string }
    | undefined;
  if (!p) return null;
  const eff = effectiveVersion(db, p.project);
  return { proposal: inputs.proposal, repo: p.dev_repo_path, effective: eff?.id ?? null, revision: eff?.authorized_revision ?? null, base: p.base_revision, tree: p.tree_id };
}

// The tree an application commits is the proposal's changes rebased onto
// where the integration branch is (decisions/effects.applyProposal); what
// was classified, bound and revalidated is the proposal's own tree. When
// the two protected sets differ, what would be applied is not what was
// approved: the application is not made, and the approval is withdrawn as
// for any failed precondition, the human's intent invalidated
// EFFECT_PRECONDITION_CHANGED with its next generation raised, or a
// Reviewer's approval withdrawn and the human's question open (the
// review's M3).
export function applicationDiverged(tx: Tx, args: { proposal: string; intent: string | null }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'approved') return false;
  if (args.intent !== null) {
    const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
    if (row?.status !== 'pending') return false;
    invalidateIntent(tx, args.intent);
    return true;
  }
  if (p.approver_authority !== 'reviewer' && p.approver_authority !== 'policy') return false;
  withdrawReviewerApproval(tx, p.id);
  return true;
}

// An approved proposal that cannot be applied onto the head as it now is:
// its changes conflict with what moved the branch (under D6 K2, another
// run's integration or another application). It is never left approved
// with nothing to decide (the driver's ruling on M401's T1 run, slice 37):
// the proposal is rejected naming the conflict, an intent pending for it is
// invalidated and every open question of it withdrawn, and a correction or
// authoring item waiting for it takes its repair (a new run from the
// current head), then parks with its blocker.
export function applicationConflicts(tx: Tx, args: { proposal: string; intent: string | null; head: string; reason: string }): boolean {
  const p = getProposal(tx, args.proposal);
  if (!p || p.status !== 'approved') return false;
  if (args.intent !== null) {
    const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
    if (row?.status === 'pending') invalidateIntent(tx, args.intent);
  }
  for (const d of tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'open'`).all(p.id) as DecisionRow[]) {
    invalidateDecision(tx, d, `the proposal cannot be applied onto ${args.head}: ${args.reason}`);
  }
  tx.db.prepare(`UPDATE "protected_proposals" SET "status" = 'rejected' WHERE "id" = ?`).run(p.id);
  tx.emit('protected.rejected', { project: p.project, proposal: p.id }, { decision: null, cause: 'application_conflict', head: args.head, reason: args.reason });
  settleProposalFindings(tx, p.id);
  correctionProposalDecided(tx, { proposal: p.id, applied: false });
  return true;
}

// ---- D2: the approved brief's own tightenings (DECISIONS item 57) ------------------------------

// Why the brief's policy does not cover a proposal, or null when it does:
// the project is a rapid prototype whose current iteration's brief is
// approved and its work open (policy-fix.ts briefScope); the proposal was
// made by a run of that iteration (its own authoring or correction, never
// a predecessor's); its import boundary is declared; and every check it
// adds or changes covers criteria of the brief's specification revision
// only, at least one. `criteria` and `checks`: what it was judged on.
// (What can execute and what is required are the class's: a tightening
// changes no execution field and no governed field, check_commands and
// runner_config among them, and only adds required keys with their checks;
// classify.ts.)
interface Coverage {
  reason: string | null;
  iteration: string | null;
  decision: string | null;
  spec_revision: string | null;
  criteria: string[];
  checks: string[];
}
export function policyCoverage(tx: Tx, p: ProposalRow, c?: Pick<StoredClassification, 'affected_checks' | 'discovery' | 'change_kind'>): Coverage {
  const none = (reason: string, extra: Partial<Coverage> = {}): Coverage => ({ reason, iteration: null, decision: null, spec_revision: null, criteria: [], checks: [], ...extra });
  const scope = briefScope(tx.db, p.project);
  if (scope === null) return none('not_rapid_prototype');
  if ('refused' in scope) return none(scope.refused);
  const it = scope.iteration;
  const at = { iteration: it.id, decision: it.brief_decision, spec_revision: it.brief_spec_revision };
  const cls = c ?? (classificationJson(tx.db, p.id) as unknown as Pick<StoredClassification, 'affected_checks' | 'discovery' | 'change_kind'> | null);
  if (!cls || !engineClassified(cls as unknown as Record<string, unknown>) && c === undefined) return none('not_classified_by_the_engine', at);
  if (cls.change_kind !== 'tightening') return none(`classified_${cls.change_kind}`, at);
  if (p.proposed_by !== 'verifier_run' || runIteration(tx.db, p.run) !== it.id) return none('not_this_iterations_authoring', at);
  // The plan the proposal's work belongs to must be this iteration's own
  // (Verifier 2 on M636 (f): a predecessor's narrowed gap authoring ran
  // while the next iteration was current): its bundle made by a run of the
  // iteration; a correction's, the finding's run's.
  const owner = workIteration(tx.db, p.run);
  if (owner.iteration !== it.id) return none(`not_this_iterations_plan: ${owner.basis}`, at);
  if (proposalBoundaryErrors(tx.db, p.id).length > 0) return none('import_boundary_undeclared', at);
  const affected = (cls.affected_checks ?? []).map((a) => a.check).sort();
  const byKey = new Map((cls.discovery?.checks ?? []).map((x) => [x.key, x]));
  const criteria = new Set<string>();
  for (const key of affected) {
    const def = byKey.get(key);
    if (!def) return none(`check_not_discovered: ${key}`, { ...at, checks: affected });
    if (def.criteria.length === 0) return none(`check_covers_no_criterion: ${key}`, { ...at, checks: affected });
    for (const k of def.criteria) {
      if (!scope.criteria.has(k)) return none(`criterion_outside_brief: ${k} (check ${key})`, { ...at, checks: affected });
      criteria.add(k);
    }
  }
  if (affected.length === 0) return none('no_check_changed', at);
  return { reason: null, ...at, criteria: [...criteria].sort(), checks: affected };
}

type PolicyResult = { approved: true } | { approved: false; reason: string | null };

// The engine's classification recorded: a covered tightening is approved
// under the brief's authority (approver `policy:rapid_prototype`, authority
// `policy`), bound to the correction manifest as it stands, the act recorded
// in delegated_actions (tightening_applied, authorized by the brief's
// decision, its scope the criteria, checks, diff and tree), and the ticks
// after apply it once its binding is revalidated, as a Reviewer's is. The
// classifier's authority is not consulted: the brief is the owner's own
// authorization (the driver's design choice, flagged).
function policyTightening(tx: Tx, p: ProposalRow, c: StoredClassification): PolicyResult {
  if (p.status !== 'classified' || c.change_kind !== 'tightening') {
    const cov = policyCoverage(tx, p, c);
    return { approved: false, reason: cov.reason === 'not_rapid_prototype' ? null : cov.reason };
  }
  const cov = policyCoverage(tx, p, c);
  if (cov.reason !== null) return { approved: false, reason: cov.reason === 'not_rapid_prototype' ? null : cov.reason };
  approveProposal(tx, p, POLICY_ACTOR, 'policy', { brief_decision: cov.decision, iteration: cov.iteration, spec_revision: cov.spec_revision });
  const binding = correctionManifest(tx, p.id);
  tx.db.prepare('UPDATE "protected_proposals" SET "approval_binding" = ? WHERE "id" = ?').run(JSON.stringify(binding), p.id);
  recordDelegatedAction(tx, {
    project: p.project,
    iteration: cov.iteration,
    kind: 'tightening_applied',
    subject_type: 'protected_proposal',
    subject_id: p.id,
    authorized_by_kind: 'decision',
    authorized_by: cov.decision,
    performed_by: POLICY_ACTOR,
    scope: { criteria: cov.criteria, checks: cov.checks, spec_revision: cov.spec_revision, diff_hash: p.diff_hash, base_revision: p.base_revision, tree: p.tree_id },
    basis: { change_kind: c.change_kind, classifier_version: c.classifier_version, classifier_authority: c.classifier_authority, effective_version: c.effective_version, elements: c.elements, changes_required_set: p.changes_required_set === 1, run: p.run },
  });
  return { approved: true };
}

const policyEvidence = (r: PolicyResult): { evidence?: Record<string, unknown> } => (!r.approved && r.reason !== null ? { evidence: { policy_not_covered: r.reason } } : {});

// The iteration the work behind a proposal's run belongs to, read from
// recorded relationships, never from time: a check authoring's plan (its
// subject's phase_plan, or a gap item's trigger plan) is the iteration's
// whose run made that plan's bundle (plan_bundles.run → runs.iteration); a
// check correction's, the iteration of the run that raised its finding.
// Unknown (no plan, no bundle, no run): iteration null, the basis saying so.
function workIteration(db: Tx['db'], run: string | null): { iteration: string | null; basis: string } {
  if (run === null) return { iteration: null, basis: 'the proposal names no run' };
  const w = db.prepare('SELECT w."id", w."kind", w."subject", w."trigger_source", w."trigger_id" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ?').get(run) as
    | { id: string; kind: string; subject: string; trigger_source: string; trigger_id: string }
    | undefined;
  if (!w) return { iteration: null, basis: `run ${run} has no work item` };
  let subject: { phase_plan?: unknown; finding?: unknown } = {};
  try {
    subject = (JSON.parse(w.subject) as typeof subject) ?? {};
  } catch {
    subject = {};
  }
  if (w.kind === 'check_correction' && typeof subject.finding === 'string') {
    const it = (db.prepare('SELECT r."iteration" FROM "findings" f JOIN "runs" r ON r."id" = f."source_run" WHERE f."id" = ?').get(subject.finding) as { iteration: string | null } | undefined)?.iteration ?? null;
    return { iteration: it, basis: `work ${w.id} corrects finding ${subject.finding}, raised by a run of ${it ?? 'no iteration'}` };
  }
  const plan = typeof subject.phase_plan === 'string' ? subject.phase_plan : w.trigger_source === 'authoring_gap' ? w.trigger_id : null;
  if (plan === null) return { iteration: null, basis: `work ${w.id} names no plan` };
  const it = (db.prepare('SELECT r."iteration" FROM "phase_plans" p JOIN "plan_bundles" b ON b."id" = p."bundle" JOIN "runs" r ON r."id" = b."run" WHERE p."id" = ?').get(plan) as { iteration: string | null } | undefined)?.iteration ?? null;
  return { iteration: it, basis: `work ${w.id} belongs to plan ${plan}, whose bundle ${it === null ? 'was made by no run of an iteration' : `was made in iteration ${it}`}` };
}
