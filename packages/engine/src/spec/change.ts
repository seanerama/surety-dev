// The specification change, its thin path (D6 §4.2 to §4.5; K8; B05;
// SEAM.md §353; slice 36 pins the rest):
//
// - the owner's request (`POST /v1/projects/:p/spec/change-requests`): a
//   `spec_change_requests` row and `spec_change` work;
// - the Spec Writer's one-shot (runs/accept.ts): its `.surety/spec/` change
//   committed, parsed and put on the side ref `refs/surety/spec-change/<seq>`
//   through the journal; that finalizer records the proposal, its impact,
//   and raises `spec_change` about the request;
// - `approve` records the effect intent (decisions/effects.ts): the side
//   revision onto the integration branch through the journal (rebased if
//   the head moved), whose finalizer is the approval's one effect: the
//   revision n+1 (spec/approval.ts), the spec-evidence generation advanced,
//   the listed results invalidated `spec_changed`, an obligation per listed
//   check, `check_correction` work for the Verifier, and `replan` work when
//   the change touches the current or a later phase.
//
// An obligation blocks every gate naming its check (ACCEPTANCE_SCOPE_INCOMPLETE)
// until the correction the request's `check_correction` work proposed is
// applied; a result of an execution registered under an earlier generation
// than an obligation on its check is history (D6 §4.5).
//
// Not built in this slice: one proposal at a time per project (D6 §4.2), a
// request from a finding's `change_spec`, `reject`'s keep ref beyond the
// side ref itself, the ADR and module dependency classes of the impact.

import { Refusal } from '../refusal.js';
import { canonical, illegal, notFound, parseJson, sha256 } from '../store/transitions/common.js';
import type { CommandResult } from '../store/transitions/control.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { checksOfVersion, markStale } from '../store/transitions/evidence.js';
import { intendCommit } from '../store/transitions/accept.js';
import { intendOperation, type IntentResult } from '../store/transitions/journal.js';
import { effectiveVersion, invalidateResults } from '../store/transitions/protected.js';
import { type KindSpec, consumed, raiseQuestion, recordApproval, recordIntent, revalidateIntent } from '../store/transitions/queue.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import { policyRevision } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';
import { approveSpec, recordSemantics } from './approval.js';
import type { SemanticFinding, SpecRepresentation } from './semantics.js';

type Db = Tx['db'];

export interface RequestRow {
  id: string;
  project: string;
  seq: number;
  spec_revision: string | null;
  text: string | null;
  request_text: string;
  source: string;
  status: 'requested' | 'proposed' | 'approved' | 'rejected' | 'failed';
  work_item: string | null;
  proposal_revision: string | null;
  proposal_blob: string | null;
  side_ref: string | null;
  impact: string | null;
  impact_value: string | null;
  approved_revision: string | null;
}

export const getRequest = (db: Db, id: string): RequestRow | undefined => db.prepare('SELECT * FROM "spec_change_requests" WHERE "id" = ?').get(id) as RequestRow | undefined;
export const sideRef = (seq: number): string => `refs/surety/spec-change/${seq}`;

const currentSpec = (db: Db, project: string): { id: string; version: number; semantics: string | null; semantic_digest: string | null } | undefined =>
  db.prepare('SELECT "id", "version", "semantics", "semantic_digest" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as
    | { id: string; version: number; semantics: string | null; semantic_digest: string | null }
    | undefined;

// ---- the request (D6 §4.2) ----------------------------------------------------------------

// POST /v1/projects/:p/spec/change-requests {text}: the request recorded
// against the current approved version, and its `spec_change` work.
export function requestSpecChange(tx: Tx, args: { project: string; text: string; record: string | null }): CommandResult {
  if (!tx.db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  const spec = currentSpec(tx.db, args.project);
  if (!spec) {
    throw new Refusal(409, 'illegal_transition', `Project ${args.project} has no approved specification to change.`, 'Approve a specification first (a Spec Writer session and spec_approval).', { project: args.project });
  }
  const { seq } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "spec_change_requests" WHERE "project" = ?').get(args.project) as { seq: number };
  const id = tx.newId('scr_');
  tx.db
    .prepare(
      `INSERT INTO "spec_change_requests" ("id", "created_at", "project", "seq", "spec_revision", "text", "request_text", "source", "status")
       VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', 'requested')`,
    )
    .run(id, tx.at, args.project, seq, spec.id, args.record, args.text);
  const work = observeTrigger(tx, { project: args.project, kind: 'spec_change', trigger_source: 'spec_change_request', trigger_id: id, trigger_generation: 1, subject: { request: id }, chain: 0 }, { request: id });
  tx.db.prepare('UPDATE "spec_change_requests" SET "work_item" = ? WHERE "id" = ?').run(work.work_item.id, id);
  tx.emit('spec.change_requested', { project: args.project, spec_change_request: id }, { seq, spec_revision: spec.id, work_item: work.work_item.id, source: 'owner' });
  return { status: 201, body: { request: { id, seq, status: 'requested' }, work_item: { id: work.work_item.id } }, effects: [{ kind: 'tick' }] };
}

// The request a `spec_change` run's work names (runs/accept.ts).
export function requestOfRun(db: Db, run: string): RequestRow | null {
  const row = db.prepare('SELECT w."subject" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ?').get(run) as { subject: string } | undefined;
  const id = parseJson<{ request?: string }>(row?.subject ?? null)?.request;
  return id ? (getRequest(db, id) ?? null) : null;
}

// ---- the impact (D6 §4.4) ------------------------------------------------------------------

export interface Impact {
  approved_digest: string | null;
  proposed_digest: string | null;
  requirements: { key: string; changes: string[] }[];
  affected_criteria: string[];
  removed_criteria: string[];
  added_criteria: string[];
  checks: { obligations: { check: string; key: string; criteria: string[] }[]; criterion_unknown: { check: string; key: string; criteria: string[] }[]; uncovered: string[] };
  stages: { stage: string; number: number; status: string; phase_plan: string }[];
  phases: number[];
  touches_current: boolean;
  evidence: { results: string[]; evaluations: string[] };
  work: string[];
  claimed: unknown;
  dependency_manifest: Record<string, unknown>;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

// What every material dependency of the impact is now (B05; A.3): the
// generations of the active plans, the requirements' registration and the
// effective protected version.
export function dependencyManifest(db: Db, project: string): Record<string, unknown> {
  const plans = db.prepare(`SELECT "id", "generation", "status" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 ORDER BY "phase_number"`).all(project);
  const reqs = db.prepare('SELECT "key", "spec_revision", "status" FROM "requirements" WHERE "project" = ? ORDER BY "key"').all(project);
  return { plans, requirements: sha256(canonical(reqs)), protected_version: effectiveVersion(db, project)?.id ?? null };
}

export function computeImpact(db: Db, args: { project: string; proposed: SpecRepresentation; proposedDigest: string | null; claimed: unknown }): Impact {
  const spec = currentSpec(db, args.project);
  const row = spec?.semantics ? (db.prepare('SELECT "representation" FROM "spec_semantics" WHERE "id" = ?').get(spec.semantics) as { representation: string | null } | undefined) : undefined;
  const approved = parseJson<SpecRepresentation>(row?.representation ?? null);
  // An impact the engine cannot compute refuses the proposal (D6 §4.4):
  // never an empty impact.
  if (!approved) throw illegal('computing a spec change impact with no readable approved representation', { project: args.project });
  const before = new Map(approved.requirements.map((r) => [r.key, r]));
  const after = new Map(args.proposed.requirements.map((r) => [r.key, r]));
  const requirements: Impact['requirements'] = [];
  const affected: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const affectedKeys: string[] = [];
  for (const key of uniq([...before.keys(), ...after.keys()]).sort()) {
    const a = before.get(key);
    const b = after.get(key);
    const changes: string[] = [];
    if (!a && b) {
      changes.push('added');
      added.push(...b.criteria.map((c) => c.id));
    } else if (a && !b) {
      changes.push('withdrawn');
      removed.push(...a.criteria.map((c) => c.id));
    } else if (a && b) {
      const ac = new Map(a.criteria.map((c) => [c.id, c.text]));
      const bc = new Map(b.criteria.map((c) => [c.id, c.text]));
      if (a.statement.trim() !== b.statement.trim()) {
        changes.push('text_changed');
        // A statement change affects every criterion of the requirement (B05).
        affected.push(...[...bc.keys()].filter((c) => ac.has(c)));
      }
      const plus = [...bc.keys()].filter((c) => !ac.has(c));
      const minus = [...ac.keys()].filter((c) => !bc.has(c));
      const changed = [...bc.keys()].filter((c) => ac.has(c) && (ac.get(c) ?? '').trim() !== (bc.get(c) ?? '').trim());
      if (plus.length > 0) changes.push('criteria_added');
      if (minus.length > 0) changes.push('criteria_removed');
      if (changed.length > 0) changes.push('criteria_changed');
      added.push(...plus);
      removed.push(...minus);
      affected.push(...changed);
      if (canonical([...a.sensitive_areas].sort()) !== canonical([...b.sensitive_areas].sort())) changes.push('areas_changed');
    }
    if (changes.length > 0) {
      requirements.push({ key, changes });
      affectedKeys.push(key);
    }
  }
  const affectedCriteria = uniq(affected).sort();
  const effective = effectiveVersion(db, args.project);
  const checks = effective ? checksOfVersion(db, effective.id) : [];
  const covers = (c: { criteria?: string }): string[] => parseJson<string[]>(c.criteria ?? null) ?? [];
  const obligations = checks.filter((c) => covers(c).some((x) => affectedCriteria.includes(x))).map((c) => ({ check: c.id, key: c.key, criteria: covers(c).filter((x) => affectedCriteria.includes(x)).sort() }));
  const unknown = checks.filter((c) => covers(c).some((x) => removed.includes(x))).map((c) => ({ check: c.id, key: c.key, criteria: covers(c).filter((x) => removed.includes(x)).sort() }));
  const uncovered = uniq(added).filter((x) => !checks.some((c) => covers(c).includes(x))).sort();
  const listedKeys = uniq([...obligations, ...unknown].map((c) => c.key));
  const results = listedKeys.length === 0
    ? []
    : (db
        .prepare(`SELECT r."id" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND r."invalidated_at" IS NULL AND c."key" IN (SELECT value FROM json_each(?)) ORDER BY r."execution_seq"`)
        .all(args.project, JSON.stringify(listedKeys)) as { id: string }[]).map((r) => r.id);
  const evaluations = results.length === 0
    ? []
    : (db.prepare(`SELECT DISTINCT g."id" FROM "gate_evaluations" g WHERE g."project" = ? AND g."stale" = 0 AND EXISTS (SELECT 1 FROM json_each(g."inputs_snapshot", '$.results') j WHERE j.value IN (SELECT value FROM json_each(?)))`).all(args.project, JSON.stringify(results)) as { id: string }[]).map((g) => g.id);
  const reqIds = new Map((db.prepare('SELECT "id", "key", "assigned_phase" FROM "requirements" WHERE "project" = ?').all(args.project) as { id: string; key: string; assigned_phase: number | null }[]).map((r) => [r.key, r]));
  const affectedIds = affectedKeys.map((k) => reqIds.get(k)?.id).filter((x): x is string => typeof x === 'string');
  const stageRows = db.prepare(`SELECT "id", "number", "status", "phase_plan", "implements" FROM "stages" WHERE "project" = ? AND "cancelled_at" IS NULL ORDER BY rowid`).all(args.project) as {
    id: string;
    number: number;
    status: string;
    phase_plan: string;
    implements: string;
  }[];
  const stages = stageRows.filter((s) => (parseJson<string[]>(s.implements) ?? []).some((x) => affectedIds.includes(x) || affectedKeys.includes(x))).map((s) => ({ stage: s.id, number: s.number, status: s.status, phase_plan: s.phase_plan }));
  const phaseOf = (k: string): number | null => reqIds.get(k)?.assigned_phase ?? after.get(k)?.phase_hint ?? null;
  const phases = uniq(affectedKeys.map(phaseOf).filter((p): p is number => p !== null)).sort((a, b) => a - b);
  const { done } = db.prepare(`SELECT COALESCE(MAX("phase_number"), 0) AS done FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed' AND "active" = 1`).get(args.project) as { done: number };
  const touchesCurrent = affectedKeys.some((k) => {
    const p = phaseOf(k);
    return p === null || p > done;
  });
  const work = stages.length === 0
    ? []
    : (db
        .prepare(`SELECT w."id" FROM "work_items" w WHERE w."project" = ? AND w."status" NOT IN ('complete', 'cancelled') AND json_extract(w."subject", '$.stage') IN (SELECT value FROM json_each(?)) ORDER BY w."seq"`)
        .all(args.project, JSON.stringify(stages.map((s) => s.stage))) as { id: string }[]).map((w) => w.id);
  return {
    approved_digest: spec?.semantic_digest ?? null,
    proposed_digest: args.proposedDigest,
    requirements,
    affected_criteria: affectedCriteria,
    removed_criteria: uniq(removed).sort(),
    added_criteria: uniq(added).sort(),
    checks: { obligations, criterion_unknown: unknown, uncovered },
    stages,
    phases,
    touches_current: touchesCurrent,
    evidence: { results, evaluations },
    work,
    claimed: args.claimed,
    dependency_manifest: dependencyManifest(db, args.project),
  };
}

// The main thread's read before the side ref's intent (runs/accept.ts).
export function impactRead(db: Db, args: { project: string; representation: SpecRepresentation; digest: string | null; claimed: unknown }): Impact {
  return computeImpact(db, { project: args.project, proposed: args.representation, proposedDigest: args.digest, claimed: args.claimed });
}

// ---- the proposal on its side ref (D6 §4.3) ------------------------------------------------

export interface ProposalInputs {
  purpose: 'spec_change';
  ref: string;
  ref_kind: 'keep';
  new_oid: string;
  request: string;
  run: string;
  blob: string;
  digest: string | null;
  representation: SpecRepresentation | null;
  findings: SemanticFinding[];
  readable: boolean;
  impact: Impact;
  impact_record: string | null;
}

export function intendProposal(
  tx: Tx,
  args: { run: string; repo: string; commit: string; blob: string; digest: string | null; representation: SpecRepresentation | null; findings: SemanticFinding[]; readable: boolean; impact: Impact; impact_record: string | null; deadlineSeconds: number },
): IntentResult {
  const r = requestOfRun(tx.db, args.run);
  if (!r) throw illegal('a spec_change run whose work names no request', { run: args.run });
  const ref = sideRef(r.seq);
  // The side ref is a registered ref of the engine's (D6 §4.3). D6 A.2's
  // `spec_change` RefKind is not in this engine's registry kinds yet; the
  // ref is registered as a keep ref, which makes the revision reachable and
  // is never moved.
  const inputs: ProposalInputs = {
    purpose: 'spec_change',
    ref,
    ref_kind: 'keep',
    new_oid: args.commit,
    request: r.id,
    run: args.run,
    blob: args.blob,
    digest: args.digest,
    representation: args.representation,
    findings: args.findings,
    readable: args.readable,
    impact: args.impact,
    impact_record: args.impact_record,
  };
  return intendOperation(tx, {
    project: r.project,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: null, new_oid: args.commit, run: args.run },
    target: { repo: args.repo, ref },
    subject: { spec_change_request: r.id, new_oid: args.commit },
    finalizer: inputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
    run: args.run,
  });
}

// The side ref is written: the proposal recorded, its representation, its
// impact, and `spec_change` raised about the request; the work awaits it.
export function finalizeProposal(tx: Tx, op: { id: string; project: string }, inputs: ProposalInputs): Record<string, unknown> {
  const r = getRequest(tx.db, inputs.request);
  if (!r) throw notFound('spec_change_request', inputs.request);
  if (r.status !== 'requested') return { request: r.id };
  recordSemantics(tx, { project: op.project, run: inputs.run, blob: inputs.blob, digest: inputs.digest, representation: inputs.representation, findings: inputs.findings, readable: inputs.readable });
  tx.db
    .prepare(`UPDATE "spec_change_requests" SET "status" = 'proposed', "proposal_revision" = ?, "proposal_blob" = ?, "side_ref" = ?, "impact" = ?, "impact_value" = ? WHERE "id" = ?`)
    .run(inputs.new_oid, inputs.blob, inputs.ref, inputs.impact_record, JSON.stringify(inputs.impact), r.id);
  tx.emit('spec.change_proposed', { project: op.project, spec_change_request: r.id }, { revision: inputs.new_oid, side_ref: inputs.ref, blob: inputs.blob, impact: inputs.impact_record, operation: op.id });
  const d = raiseQuestion(tx, { project: op.project, kind: 'spec_change', subjectType: 'spec_change_request', subjectId: r.id });
  const item = r.work_item ? getWorkItem(tx, r.work_item) : undefined;
  if (d && item && item.status === 'executing') {
    transitionWork(tx, item, 'awaiting_decision', { blocker: JSON.stringify({ reason: 'spec_change', raised_at: tx.at, decision: d.id }) }, { spec_change_request: r.id, decision: d.id });
  }
  return { request: r.id, decision: d?.id ?? null };
}

// The impact as it stands now (D6 §4.4: preview and effect recompute it):
// the proposal's representation, recorded with the run's semantics, against
// the approved version and the records as they are.
export function currentImpact(db: Db, r: RequestRow): Impact | null {
  if (r.proposal_blob === null) return null;
  const sem = db
    .prepare(`SELECT s."representation", s."semantic_digest" FROM "spec_semantics" s JOIN "runs" u ON u."id" = s."run" WHERE u."work_item" = ? AND s."git_blob" = ? ORDER BY s."created_at" DESC, s."id" DESC LIMIT 1`)
    .get(r.work_item, r.proposal_blob) as { representation: string | null; semantic_digest: string | null } | undefined;
  const representation = parseJson<SpecRepresentation>(sem?.representation ?? null);
  if (!representation) return null;
  try {
    return computeImpact(db, { project: r.project, proposed: representation, proposedDigest: sem?.semantic_digest ?? null, claimed: parseJson<Impact>(r.impact_value)?.claimed ?? null });
  } catch {
    return null;
  }
}

// ---- the decision (D6 §4.5; floor) ---------------------------------------------------------

export const SPEC_CHANGE_KEYS = ['spec_version', 'proposal_revision', 'protected_version', 'impact', 'dependency_manifest', 'policy_revision'];

function changeManifest(db: Db, id: string): Record<string, unknown> {
  const r = getRequest(db, id);
  const project = r?.project ?? null;
  const spec = project === null ? undefined : currentSpec(db, project);
  const impact = r ? currentImpact(db, r) : null;
  return {
    request: id,
    spec_version: spec?.version ?? null,
    proposal_revision: r?.proposal_revision ?? null,
    protected_version: project === null ? null : (effectiveVersion(db, project)?.id ?? null),
    // What the approval decides on: the requirements and criteria changed,
    // the checks that would owe a correction, the phases touched. The listed
    // evidence is recomputed at the effect (results come and go every tick).
    impact:
      impact === null
        ? null
        : sha256(canonical({ digests: [impact.approved_digest, impact.proposed_digest], requirements: impact.requirements, affected: impact.affected_criteria, removed: impact.removed_criteria, added: impact.added_criteria, checks: impact.checks, phases: impact.phases, touches_current: impact.touches_current })),
    dependency_manifest: project === null ? null : dependencyManifest(db, project),
    policy_revision: project === null ? null : policyRevision(db, project),
  };
}

export function specChangeKind(): KindSpec {
  return {
    preview(tx, d) {
      const r = getRequest(tx.db, d.subject_id);
      if (!r || r.status !== 'proposed' || r.proposal_revision === null) return null;
      const manifest = changeManifest(tx.db, r.id);
      const impact = currentImpact(tx.db, r);
      if (impact === null) return null;
      const listed = impact.checks.obligations.map((c) => c.key);
      return {
        manifest,
        question: `Approve specification change ${r.seq} as version ${Number(manifest.spec_version) + 1}? It changes ${impact.requirements.map((q) => `${q.key} (${q.changes.join(', ')})`).join('; ') || 'nothing the engine can name'}; ${listed.length} check(s) would owe a correction (${listed.join(', ') || 'none'}), ${impact.evidence.results.length} result(s) would be invalidated${impact.touches_current ? ', and the current phase is touched, so a replan follows' : ''}.`,
        options: [
          {
            key: 'approve',
            label: 'Approve',
            consequence: 'The proposed specification is integrated as the next approved version; the listed results are invalidated, the listed checks owe a correction, and the Verifier and (where a current or later phase is touched) the Architect are given work.',
            effect: { request: r.id, revision: r.proposal_revision, spec_version: Number(manifest.spec_version) + 1 },
          },
          { key: 'reject', label: 'Reject', consequence: 'The proposal stays on its side ref as history; nothing of the specification changes.', effect: { request: r.id } },
        ],
        evidence: [...(r.impact ? [{ record: r.impact, provenance: 'observed' as const }] : []), { record: String(r.proposal_blob), path: '.surety/spec/spec.md', provenance: 'claimed' as const } as never],
        ...(r.work_item ? { blockedWorkItems: [r.work_item] } : {}),
      };
    },
    manifest: (tx, d) => changeManifest(tx.db, d.subject_id),
    // A dependency that changes (a new protected version, a plan's
    // generation) raises the next generation with the impact recomputed.
    reraise: true,
    answer(tx, d, option, note) {
      consumeDecision(tx, d, option, note);
      const r = getRequest(tx.db, d.subject_id);
      if (!r) throw notFound('spec_change_request', d.subject_id);
      if (option !== 'approve') {
        tx.db.prepare(`UPDATE "spec_change_requests" SET "status" = 'rejected' WHERE "id" = ?`).run(r.id);
        settleWork(tx, r, 'rejected');
        return consumed(d);
      }
      const approval = recordApproval(tx, d, { consequence: `specification change ${r.seq} approved`, subjectType: 'spec_change_request', subjectId: r.id });
      return consumed(d, [recordIntent(tx, d, { approval, kind: 'spec_change_application', plan: { request: r.id } })]);
    },
    // An effect whose precondition failed: the question is asked again
    // against what is there now.
    withdraw: () => true,
  };
}

function settleWork(tx: Tx, r: RequestRow, cause: string): void {
  const item = r.work_item ? getWorkItem(tx, r.work_item) : undefined;
  if (!item || item.status === 'complete' || item.status === 'cancelled') return;
  // The proposal path (work-table.ts): executing → awaiting_decision → complete.
  let it = item;
  if (it.status === 'executing') it = transitionWork(tx, it, 'awaiting_decision', {}, { spec_change_request: r.id, cause });
  if (it.status === 'awaiting_decision') transitionWork(tx, it, 'complete', { blocker: null }, { spec_change_request: r.id, cause });
}

// ---- the application (D6 §4.5) -------------------------------------------------------------

export interface ApplicationFacts {
  intent: string;
  status: string;
  project: string;
  repo: string;
  ref: string;
  head: string | null;
  request: string;
  revision: string | null;
}

export function applicationFacts(tx: Tx, args: { intent: string }): ApplicationFacts | null {
  const row = tx.db.prepare('SELECT "id", "project", "status", "plan" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { id: string; project: string; status: string; plan: string } | undefined;
  if (!row) return null;
  const plan = JSON.parse(row.plan) as { request: string };
  const r = getRequest(tx.db, plan.request);
  if (!r) return null;
  const p = projectRepoRow(tx, row.project);
  const ref = integrationRef(p.integration_branch);
  return { intent: row.id, status: row.status, project: row.project, repo: p.dev_repo_path, ref, head: registryRow(tx, row.project, ref)?.expected_oid ?? null, request: r.id, revision: r.proposal_revision };
}

export interface AppliedInputs {
  purpose: 'spec_applied';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  request: string;
  intent: string;
}

// The intent begins (decisions/effects.ts): its preconditions read again,
// then the integration branch moved to the proposal (or its rebase onto the
// head, committed first) by a journaled compare-and-swap.
export function beginApplication(tx: Tx, args: { intent: string; head: string; commit: { sha: string; tree: string; content: string } | null; deadlineSeconds: number }): IntentResult | null {
  if (!revalidateIntent(tx, args.intent, {})) return null;
  const facts = applicationFacts(tx, { intent: args.intent });
  if (!facts || facts.revision === null || facts.head !== args.head) return null;
  const target = args.commit?.sha ?? facts.revision;
  const follow = {
    project: facts.project,
    kind: 'ref_update' as const,
    payload: { repo: facts.repo, ref: facts.ref, old_oid: args.head, new_oid: target },
    target: { repo: facts.repo, ref: facts.ref },
    subject: { spec_change_request: facts.request, old_oid: args.head, new_oid: target },
    finalizer: { purpose: 'spec_applied', ref: facts.ref, ref_kind: 'integration', new_oid: target, request: facts.request, intent: args.intent } satisfies AppliedInputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
  };
  const made = args.commit === null
    ? intendOperation(tx, follow)
    : intendCommit(tx, {
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
    tx.emit('intent.executing', { project: facts.project, intent: args.intent, operation: made.operation }, { kind: 'spec_change_application' });
  }
  return made;
}

// The approval's one effect (D6 §4.5; B05; D6-C05), in the finalizer of the
// integration branch's move.
export function finalizeApplied(tx: Tx, op: { id: string; project: string }, inputs: AppliedInputs): Record<string, unknown> {
  const r = getRequest(tx.db, inputs.request);
  if (!r) throw notFound('spec_change_request', inputs.request);
  if (r.status === 'approved') return { request: r.id };
  const run = tx.db.prepare('SELECT "id" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(r.work_item) as { id: string } | undefined;
  const intent = tx.db.prepare('SELECT "decision" FROM "effect_intents" WHERE "id" = ?').get(inputs.intent) as { decision: string } | undefined;
  if (!run || !intent) throw illegal('applying a spec change with no run or no decision', { spec_change_request: r.id });
  const impact = currentImpact(tx.db, r) ?? (parseJson<Impact>(r.impact_value) as Impact);
  const made = approveSpec(tx, { project: op.project, run: run.id, decision: intent.decision });
  const generation = (tx.db.prepare('SELECT "spec_evidence_generation" FROM "projects" WHERE "id" = ?').get(op.project) as { spec_evidence_generation: number }).spec_evidence_generation;
  tx.db.prepare(`UPDATE "spec_change_requests" SET "status" = 'approved', "approved_revision" = ? WHERE "id" = ?`).run(made.spec_revision, r.id);
  // (The impact was recomputed above, against the records as they were
  // before the new version: D6 §4.4.)
  tx.db.prepare('UPDATE "spec_change_requests" SET "impact_value" = ? WHERE "id" = ?').run(JSON.stringify(impact), r.id);
  invalidateResults(tx, op.project, impact.evidence.results, 'spec_changed');
  // An unresolved obligation per listed check (A.3).
  const insert = tx.db.prepare(
    `INSERT INTO "check_obligations" ("id", "created_at", "project", "check", "key", "criteria", "generation", "reason", "request") VALUES (?, ?, ?, ?, ?, ?, ?, 'spec_changed', ?)`,
  );
  for (const c of impact.checks.obligations) insert.run(tx.newId('obl_'), tx.at, op.project, c.check, c.key, JSON.stringify(c.criteria), generation, r.id);
  // The Verifier's correction, naming the affected and uncovered criteria
  // (D3 §2.11's route).
  if (impact.checks.obligations.length > 0 || impact.checks.uncovered.length > 0 || impact.checks.criterion_unknown.length > 0) {
    observeTrigger(tx, { project: op.project, kind: 'check_correction', trigger_source: 'spec_obligation', trigger_id: r.id, trigger_generation: 1, subject: { request: r.id }, chain: 0 }, { spec_change_request: r.id });
  }
  // The Architect's replan when the current or a later phase is touched
  // (F §3.10.7), the impact its triggering evidence.
  if (impact.touches_current) {
    const open = tx.db.prepare(`SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "completed_at" IS NULL ORDER BY "phase_number" LIMIT 1`).get(op.project) as { id: string } | undefined;
    observeTrigger(tx, { project: op.project, kind: 'replan', trigger_source: 'spec_change', trigger_id: r.id, trigger_generation: 1, subject: open ? { phase_plan: open.id, request: r.id } : { request: r.id }, chain: 0 }, { spec_change_request: r.id });
  }
  settleWork(tx, getRequest(tx.db, r.id)!, 'approved');
  tx.emit('spec.change_approved', { project: op.project, spec_change_request: r.id }, { spec_revision: made.spec_revision, version: made.version, generation, obligations: impact.checks.obligations.length, results: impact.evidence.results.length, operation: op.id });
  markStale(tx, { project: op.project });
  return { request: r.id, spec_revision: made.spec_revision };
}

// ---- obligations (D6 §4.5) ------------------------------------------------------------------

// The unresolved obligations of a project's checks, by check key.
export function unresolvedObligations(db: Db, project: string): Map<string, number> {
  const rows = db.prepare(`SELECT "key", MAX("generation") AS g FROM "check_obligations" WHERE "project" = ? AND "resolved_at" IS NULL GROUP BY "key"`).all(project) as { key: string; g: number }[];
  return new Map(rows.map((r) => [r.key, r.g]));
}

// The highest generation of any obligation, resolved or not, on a check key:
// a result registered under an earlier generation is history (D6 §4.5).
export function obligationGeneration(db: Db, project: string, key: string): number | null {
  const row = db.prepare(`SELECT MAX("generation") AS g FROM "check_obligations" WHERE "project" = ? AND "key" = ?`).get(project, key) as { g: number | null };
  return row.g;
}

// A correction applied that the request's `check_correction` work proposed
// resolves the request's obligations (D6 §4.5: "a protected correction
// applied that names the criteria"; the work names them).
export function resolveByCorrection(tx: Tx, args: { project: string; proposal: string }): void {
  const row = tx.db
    .prepare(
      `SELECT w."subject" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" JOIN "work_items" w ON w."id" = r."work_item"
       WHERE p."id" = ? AND w."kind" = 'check_correction'`,
    )
    .get(args.proposal) as { subject: string } | undefined;
  const request = row ? parseJson<{ request?: string }>(row.subject)?.request : undefined;
  if (!request) return;
  const changed = tx.db.prepare(`UPDATE "check_obligations" SET "resolved_by" = ?, "resolved_at" = ? WHERE "project" = ? AND "request" = ? AND "resolved_at" IS NULL`).run(args.proposal, tx.at, args.project, request).changes;
  if (changed > 0) markStale(tx, { project: args.project });
}
