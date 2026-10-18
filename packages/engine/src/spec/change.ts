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
import { resultState } from '../store/transitions/deploy.js';
import { intendCommit } from '../store/transitions/accept.js';
import { intendOperation, type IntentResult } from '../store/transitions/journal.js';
import { completeIntent, effectiveVersion, invalidateResults } from '../store/transitions/protected.js';
import { type KindSpec, consumed, invalidateIntent, raiseQuestion, recordApproval, recordIntent, revalidateIntent } from '../store/transitions/queue.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import { parkWork } from '../store/transitions/runs.js';
import { policyRevision, projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { type WorkRow, getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';
import { ADR_FILE } from '../plan/schemas.js';
import { type SemanticsRow, approveSpec, approvedRepresentation, recordSemantics, specBlockers, vanishedKeys } from './approval.js';
import { compareKeys } from './keys.js';
import { type SemanticFinding, type SpecRepresentation, liveRepresentation } from './semantics.js';
import { DESIGN_BATCH_DEFERRED, requestVerdictBlockers, approveDesign, deferredBatches, designBatchState, designBindingsChanged, getRevision, pendingCorrections, raiseDesignBatch, reraiseDesignBatch, revisionOfRequest } from '../design/approval.js';
import { blobsHash } from '../design/store.js';
import { designHumanCriteria, humanCriteriaOfChange } from '../design/criterion-map.js';
import { latestCheck } from '../design/records.js';
import { type DesignClass, specDesignClass, staleScreens } from '../design/stale.js';
import { reviewDesignDue } from '../design/due.js';

const designTreeHash = (db: Db, project: string): string | null => {
  const c = latestCheck(db, { project });
  return c ? blobsHash(c.blobs) : null;
};

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
  failure: string | null;
  last_refusal: string | null;
}

// The request's work parked after its repairs (store/transitions/runs.ts
// parkWork): the request `failed`, with the park's reason and its last run's.
export function requestFailed(tx: Tx, args: { workItem: string; reason: string }): void {
  const r = tx.db.prepare(`SELECT * FROM "spec_change_requests" WHERE "work_item" = ? AND "status" = 'requested'`).get(args.workItem) as RequestRow | undefined;
  if (!r) return;
  const last = tx.db.prepare('SELECT "reason_text" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(args.workItem) as { reason_text: string | null } | undefined;
  const failure = last?.reason_text ? `${args.reason}: ${last.reason_text}` : args.reason;
  tx.db.prepare(`UPDATE "spec_change_requests" SET "status" = 'failed', "failure" = ? WHERE "id" = ?`).run(failure, r.id);
  tx.emit('spec.change_failed', { project: r.project, spec_change_request: r.id }, { work_item: args.workItem, reason: args.reason, failure });
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

// D3 §5 X2's `change_spec` answer about a finding (D6 §4.2; M431 (c)): a
// request with source `finding` naming it, its text the finding's message,
// and its `spec_change` work, dispatched like the owner's (one proposal at a
// time). Returns the request, or null when the project has no approved
// specification to change: then, as before, a `spec_change` item about the
// finding is recorded and never dispatched (the driver's ruling Q14).
export function requestFromFinding(tx: Tx, args: { project: string; finding: string; decision: string }): string | null {
  const spec = currentSpec(tx.db, args.project);
  if (!spec) {
    observeTrigger(tx, { project: args.project, kind: 'spec_change', trigger_source: 'spec_change', trigger_id: args.finding, trigger_generation: 1, subject: { finding: args.finding }, chain: 0, engineRaised: true }, { finding: args.finding, decision: args.decision });
    return null;
  }
  const open = tx.db.prepare(`SELECT "id" FROM "spec_change_requests" WHERE "project" = ? AND "finding" = ? AND "status" IN ('requested', 'proposed')`).get(args.project, args.finding) as { id: string } | undefined;
  if (open) return open.id;
  const f = tx.db.prepare('SELECT "message" FROM "findings" WHERE "id" = ? AND "project" = ?').get(args.finding, args.project) as { message: string } | undefined;
  if (!f) throw notFound('finding', args.finding);
  const { seq } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "spec_change_requests" WHERE "project" = ?').get(args.project) as { seq: number };
  const id = tx.newId('scr_');
  tx.db
    .prepare(
      `INSERT INTO "spec_change_requests" ("id", "created_at", "project", "seq", "spec_revision", "text", "request_text", "source", "status", "finding")
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'finding', 'requested', ?)`,
    )
    .run(id, tx.at, args.project, seq, spec.id, f.message, args.finding);
  // A finding asked about again after an earlier request of it ended is a
  // new generation of the same trigger.
  const { n } = tx.db.prepare('SELECT COUNT(*) AS n FROM "spec_change_requests" WHERE "project" = ? AND "finding" = ?').get(args.project, args.finding) as { n: number };
  const work = observeTrigger(
    tx,
    { project: args.project, kind: 'spec_change', trigger_source: 'spec_change', trigger_id: args.finding, trigger_generation: n, subject: { request: id }, chain: 0 },
    { request: id, finding: args.finding, decision: args.decision },
  );
  tx.db.prepare('UPDATE "spec_change_requests" SET "work_item" = ? WHERE "id" = ?').run(work.work_item.id, id);
  tx.emit('spec.change_requested', { project: args.project, spec_change_request: id }, { seq, spec_revision: spec.id, work_item: work.work_item.id, source: 'finding', finding: args.finding, decision: args.decision });
  return id;
}

// The `change_spec` answer about a set of conflicts: one request per
// distinct conflict (the same criterion and message reported again, by a
// repair of the same work, is one conflict), naming its earliest finding.
export function requestsFromFindings(tx: Tx, args: { project: string; findings: string[]; decision: string }): (string | null)[] {
  const rows = args.findings
    .map((id) => tx.db.prepare('SELECT "id", "seq", "criterion", "message" FROM "findings" WHERE "id" = ? AND "project" = ?').get(id, args.project) as { id: string; seq: number; criterion: string | null; message: string } | undefined)
    .filter((f): f is { id: string; seq: number; criterion: string | null; message: string } => f !== undefined)
    .sort((a, b) => a.seq - b.seq);
  const seen = new Set<string>();
  const out: (string | null)[] = [];
  for (const f of rows) {
    const k = canonical([f.criterion, f.message]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(requestFromFinding(tx, { project: args.project, finding: f.id, decision: args.decision }));
  }
  return out;
}

// A retrofit replan's requests (D6 §8.3; B.7): each an ordinary request,
// source `replan`, its spec_change work registered as the owner's is; the
// owner approves its proposal like any. A request the same replan work
// already made with the same keys and text, still open, is not made twice.
export function requestsFromReplan(tx: Tx, args: { project: string; run: string; requests: { keys: string[]; text: string }[] }): string[] {
  const spec = currentSpec(tx.db, args.project);
  if (!spec) return [];
  // Only an adopted project's replan asks (the slice-32 review's M4).
  if ((tx.db.prepare('SELECT "adoption" FROM "projects" WHERE "id" = ?').get(args.project) as { adoption: string | null } | undefined)?.adoption == null) return [];
  const out: string[] = [];
  for (const r of args.requests) {
    const keys = JSON.stringify([...r.keys].sort());
    const open = tx.db.prepare(`SELECT "id" FROM "spec_change_requests" WHERE "project" = ? AND "source" = 'replan' AND "keys" = ? AND "request_text" = ? AND "status" IN ('requested', 'proposed')`).get(args.project, keys, r.text) as { id: string } | undefined;
    if (open) continue;
    const { seq } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "spec_change_requests" WHERE "project" = ?').get(args.project) as { seq: number };
    const id = tx.newId('scr_');
    tx.db
      .prepare(
        `INSERT INTO "spec_change_requests" ("id", "created_at", "project", "seq", "spec_revision", "text", "request_text", "source", "status", "run", "keys")
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'replan', 'requested', ?, ?)`,
      )
      .run(id, tx.at, args.project, seq, spec.id, r.text, args.run, keys);
    const work = observeTrigger(tx, { project: args.project, kind: 'spec_change', trigger_source: 'spec_change_request', trigger_id: id, trigger_generation: 1, subject: { request: id }, chain: 0 }, { request: id });
    tx.db.prepare('UPDATE "spec_change_requests" SET "work_item" = ? WHERE "id" = ?').run(work.work_item.id, id);
    tx.emit('spec.change_requested', { project: args.project, spec_change_request: id }, { seq, spec_revision: spec.id, work_item: work.work_item.id, source: 'replan', run: args.run, keys: r.keys });
    out.push(id);
  }
  return out;
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
  checks: {
    obligations: { check: string; key: string; criteria: string[] }[];
    criterion_unknown: { check: string; key: string; criteria: string[] }[];
    uncovered: string[];
    // The added design criteria of kind `human` (D7 §7.2, §7.3; the
    // driver's ruling on M519's F1): judged by a person, never uncovered,
    // owing no check. Present only when the change adds one.
    judged_by_person?: string[];
  };
  stages: { stage: string; number: number; status: string; phase_plan: string }[];
  phases: number[];
  touches_current: boolean;
  // A phase after the current one (the slice-36 review's M1).
  touches_later: boolean;
  evidence: { results: string[]; evaluations: string[] };
  work: string[];
  // D6 §4.4 (B05): the findings naming a removed, changed or affected
  // criterion; the ADRs whose text cites an affected key (a textual
  // dependency, not semantic analysis); the modules whose sensitive areas
  // the change alters (structural); the requirements whose independence is
  // not established (a statement changed, the key cited by no ADR), whose
  // scope is therefore the conservative one.
  findings: string[];
  adrs: { key: string; class: 'textual'; cites: string[] }[];
  modules: { name: string; class: 'structural' }[];
  uncertain_scope: { key: string; reason: string }[];
  // D7 §9.1 (G8; SEAM.md §515): the design class, the approved screens the
  // change stales and the requirements it makes newly UI.
  design?: DesignClass;
  claimed: unknown;
  dependency_manifest: DependencyManifest;
}

// The dependency generations the impact is bound to (B05; A.3): each
// subject it lists, by class, with what it is now. Preview and effect
// recompute it; a material change to a listed subject makes the answer stale.
export type ManifestEntry = { id: string; generation: number | string | null };
export interface DependencyManifest {
  plans: ManifestEntry[];
  requirements: ManifestEntry[];
  checks: ManifestEntry[];
  findings: ManifestEntry[];
  results: ManifestEntry[];
  work: ManifestEntry[];
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
// A short digest of a subject's material fields: its generation where the
// row keeps no counter of its own.
const digestOf = (v: unknown): string => sha256(canonical(v)).slice(0, 16);

// A proposal the engine refuses before any impact (D6 §4.4): a key or a
// criterion renumbered, a withdrawn key used again, an approved
// representation it cannot read. The run fails `invalid_result` naming it.
export class ImpactRefused extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

// The ADRs of the approved architecture with their approved texts (as
// plan/bundle.ts's approvedAdrs), read from the store.
function approvedAdrTexts(db: Db, project: string): { key: string; text: string }[] {
  const arch = db.prepare('SELECT "blobs" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { blobs: string } | undefined;
  if (!arch) return [];
  const keys = new Set(Object.keys(parseJson<Record<string, string>>(arch.blobs) ?? {}).flatMap((p) => ADR_FILE.exec(p)?.[1] ?? []));
  return (db.prepare(`SELECT "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'adr' ORDER BY "key"`).all(project) as { key: string; text: string }[]).filter((a) => keys.has(a.key));
}

// The requirement keys an ADR's body cites (`R<n>`, or a criterion `R<n>.<m>`
// of it), its front matter apart.
function citedKeys(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return uniq([...body.matchAll(/\bR([1-9][0-9]*)(?:\.[0-9]+)?\b/g)].map((m) => `R${m[1]}`));
}

export function computeImpact(db: Db, args: { project: string; proposed: SpecRepresentation; proposedDigest: string | null; claimed: unknown; request?: string | null }): Impact {
  const spec = currentSpec(db, args.project);
  const row = spec?.semantics ? (db.prepare('SELECT "representation" FROM "spec_semantics" WHERE "id" = ?').get(spec.semantics) as { representation: string | null } | undefined) : undefined;
  const approved = liveRepresentation(parseJson<SpecRepresentation>(row?.representation ?? null));
  // An impact the engine cannot compute refuses the proposal (D6 §4.4):
  // never an empty impact.
  if (!approved) throw new ImpactRefused('spec_semantics_unreadable', 'the approved specification\'s representation cannot be read, so the impact cannot be computed');
  // A key renumbered is a refusal of the diff, not an impact (D6 §4.4); a
  // withdrawn key is never used again (TPL §4).
  const keys = compareKeys(approved, liveRepresentation(args.proposed));
  if (keys.renumbered.length > 0) throw new ImpactRefused('spec_keys_renumbered', keys.renumbered.map((r) => `${r.from} -> ${r.key}`).join(', '));
  const vanished = vanishedKeys(db, args.project, approved);
  const reused = liveRepresentation(args.proposed).requirements.map((q) => q.key).filter((k) => vanished.includes(k));
  if (reused.length > 0) throw new ImpactRefused('spec_key_reused', reused.join(', '));
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
  // A design criterion of kind `human` is a person's to judge, never a
  // check's: never uncovered (the driver's ruling on M519's F1).
  const human = humanCriteriaOfChange(db, {
    project: args.project,
    request: args.request ?? null,
    rep: args.proposed,
    added_criteria: uniq(added),
    added_requirements: requirements.filter((q) => q.changes.includes('added')).map((q) => q.key),
  });
  const judged = uniq(added).filter((x) => human.has(x)).sort();
  const uncovered = uniq(added).filter((x) => !human.has(x) && !checks.some((c) => covers(c).includes(x))).sort();
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
  // Before any roadmap there is no phase, current or later, to touch (D6 §4.5).
  const hasRoadmap = db.prepare('SELECT 1 FROM "roadmap_revisions" WHERE "project" = ? LIMIT 1').get(args.project) !== undefined;
  // The current phase: the open plan's (published, active, not complete),
  // else the first not completed (the slice-36 review's M1). The change
  // touches it when an affected requirement is in it or has no phase yet (a
  // requirement a change adds is in none until the roadmap places it); it
  // touches a later phase when one is beyond it. Only the first is an early
  // replacement of the current plan; either registers a replan (F §3.10.7).
  const touch = phasesTouched(db, args.project, affectedKeys.map((k) => reqIds.get(k)?.assigned_phase ?? null));
  const touchesCurrent = hasRoadmap && touch.current;
  const touchesLater = hasRoadmap && touch.later;
  const work = stages.length === 0
    ? []
    : (db
        .prepare(`SELECT w."id" FROM "work_items" w WHERE w."project" = ? AND w."status" NOT IN ('complete', 'cancelled') AND json_extract(w."subject", '$.stage') IN (SELECT value FROM json_each(?)) ORDER BY w."seq"`)
        .all(args.project, JSON.stringify(stages.map((s) => s.stage))) as { id: string }[]).map((w) => w.id);
  // Findings naming a removed, changed or affected criterion.
  const named = uniq([...affectedCriteria, ...removed]);
  const findings = named.length === 0
    ? []
    : (db.prepare(`SELECT "id" FROM "findings" WHERE "project" = ? AND "criterion" IN (SELECT value FROM json_each(?)) ORDER BY "seq"`).all(args.project, JSON.stringify(named)) as { id: string }[]).map((f) => f.id);
  // The textual class: approved ADRs citing an affected key.
  const adrs = approvedAdrTexts(db, args.project)
    .map((a) => ({ key: a.key, class: 'textual' as const, cites: citedKeys(a.text).filter((k) => affectedKeys.includes(k)).sort() }))
    .filter((a) => a.cites.length > 0);
  const cited = new Set(adrs.flatMap((a) => a.cites));
  // The structural class: §6 modules whose areas differ, and the modules of
  // the stages implementing a requirement whose areas changed.
  const areas = (m: { sensitive_areas: string[] } | undefined) => canonical([...(m?.sensitive_areas ?? [])].sort());
  const beforeModules = new Map(approved.modules.map((m) => [m.name, m]));
  const afterModules = new Map(args.proposed.modules.map((m) => [m.name, m]));
  const moduleNames = uniq([...beforeModules.keys(), ...afterModules.keys()]).filter((n) => areas(beforeModules.get(n)) !== areas(afterModules.get(n)));
  const areaKeys = requirements.filter((q) => q.changes.includes('areas_changed')).map((q) => q.key);
  const areaIds = areaKeys.map((k) => reqIds.get(k)?.id).filter((x): x is string => typeof x === 'string');
  const stageModuleIds = stageRows.filter((s) => (parseJson<string[]>(s.implements) ?? []).some((x) => areaIds.includes(x) || areaKeys.includes(x))).flatMap((s) => {
    const m = db.prepare('SELECT "modules" FROM "stages" WHERE "id" = ?').get(s.id) as { modules: string } | undefined;
    return parseJson<string[]>(m?.modules ?? null) ?? [];
  });
  for (const id of uniq(stageModuleIds)) {
    const m = db.prepare('SELECT "name" FROM "modules" WHERE "id" = ? OR ("project" = ? AND "name" = ?)').get(id, args.project, id) as { name: string } | undefined;
    if (m) moduleNames.push(m.name);
  }
  const modules = uniq(moduleNames).sort().map((name) => ({ name, class: 'structural' as const }));
  // Where independence is not established (D6 §4.4): a statement changed
  // and no ADR cites the key; its scope is every check of its criteria.
  const uncertain = requirements
    .filter((q) => q.changes.includes('text_changed') && !cited.has(q.key))
    .map((q) => ({ key: q.key, reason: `the statement of ${q.key} changed and no ADR cites it: every check of its criteria is in scope` }));
  const listedChecks = [...obligations, ...unknown].map((c) => c.check);
  return {
    approved_digest: spec?.semantic_digest ?? null,
    proposed_digest: args.proposedDigest,
    requirements,
    affected_criteria: affectedCriteria,
    removed_criteria: uniq(removed).sort(),
    added_criteria: uniq(added).sort(),
    checks: { obligations, criterion_unknown: unknown, uncovered, ...(judged.length > 0 ? { judged_by_person: judged } : {}) },
    stages,
    phases,
    touches_current: touchesCurrent,
    touches_later: touchesLater,
    evidence: { results, evaluations },
    work,
    findings,
    adrs,
    modules,
    uncertain_scope: uncertain,
    design: specDesignClass(db, { project: args.project, changes: requirements, before: approved, after: liveRepresentation(args.proposed) }),
    claimed: args.claimed,
    dependency_manifest: dependencyManifest(db, { project: args.project, phases, stages: stages.map((s) => s.stage), keys: affectedKeys, checks: listedChecks, findings, results, work }),
  };
}

// Whether requirements placed in these phases (null: none yet) touch the
// project's current phase or a later one (the slice-36 review's M1). The
// current phase is the open plan's (published, active, not complete), else
// the first not completed.
export function phasesTouched(db: Db, project: string, placed: (number | null)[]): { current: boolean; later: boolean; phase: number } {
  const { done } = db.prepare(`SELECT COALESCE(MAX("phase_number"), 0) AS done FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed' AND "active" = 1`).get(project) as { done: number };
  const open = db.prepare(`SELECT "phase_number" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 AND "completed_at" IS NULL ORDER BY rowid DESC LIMIT 1`).get(project) as { phase_number: number } | undefined;
  const phase = open?.phase_number ?? done + 1;
  return { current: placed.some((p) => p === null || p === phase), later: placed.some((p) => p !== null && p > phase), phase };
}

// What each subject the impact lists is now (B05; A.3; SEAM.md §418): the
// active plans of the phases it names or holding its stages, at their
// generation; its requirements, findings and open work by a digest of what
// is material about them; its checks at their protected version; every
// result of its checks not invalidated, at the spec-evidence generation it
// was registered under (null where that is not recorded).
export function dependencyManifest(
  db: Db,
  args: { project: string; phases: number[]; stages: string[]; keys: string[]; checks: string[]; findings: string[]; results: string[]; work: string[] },
): DependencyManifest {
  const list = (xs: string[]) => JSON.stringify(xs);
  const plans = db
    .prepare(
      `SELECT "id", "generation" FROM "phase_plans" WHERE "project" = ? AND "active" = 1
         AND ("phase_number" IN (SELECT value FROM json_each(?)) OR "id" IN (SELECT "phase_plan" FROM "stages" WHERE "id" IN (SELECT value FROM json_each(?))))
       ORDER BY "phase_number", "id"`,
    )
    .all(args.project, JSON.stringify(args.phases), list(args.stages)) as { id: string; generation: number }[];
  const requirements = (
    db.prepare('SELECT "id", "spec_revision", "status", "assigned_phase", "withdrawn_at" FROM "requirements" WHERE "project" = ? AND "key" IN (SELECT value FROM json_each(?)) ORDER BY "key"').all(args.project, list(args.keys)) as {
      id: string;
    }[]
  ).map((r) => ({ id: r.id, generation: digestOf(r) }));
  const checks = (
    db.prepare(`SELECT c."id", v."seq" FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version" WHERE c."id" IN (SELECT value FROM json_each(?)) ORDER BY c."id"`).all(list(args.checks)) as {
      id: string;
      seq: number;
    }[]
  ).map((c) => ({ id: c.id, generation: c.seq }));
  const findings = (
    db.prepare(`SELECT "id", "status", "disposition", "effective_severity" FROM "findings" WHERE "id" IN (SELECT value FROM json_each(?)) ORDER BY "seq"`).all(list(args.findings)) as { id: string }[]
  ).map((f) => ({ id: f.id, generation: digestOf(f) }));
  const results = (
    db.prepare(`SELECT r."id", x."spec_generation" AS g FROM "check_results" r LEFT JOIN "check_executions" x ON x."id" = r."execution" WHERE r."id" IN (SELECT value FROM json_each(?)) ORDER BY r."execution_seq", r."id"`).all(list(args.results)) as {
      id: string;
      g: number | null;
    }[]
  ).map((r) => ({ id: r.id, generation: r.g }));
  // A work item's generation is its class (the driver's ruling on the
  // slice-36 report, kept in slice 37): active (awaiting a decision among
  // them), held (parked, or held by a Stop) or terminal. A parked item
  // retried changes it (M433 (a)); a build's routine progress does not, nor
  // does a dispatch hold (depends_on, the envelope, one replan at a time, a
  // correction's hold, a quarantine, a barrier): those are the `held`
  // column's, never the status.
  const work = (
    db.prepare(`SELECT "id", "status" FROM "work_items" WHERE "id" IN (SELECT value FROM json_each(?)) ORDER BY "seq"`).all(list(args.work)) as { id: string; status: string }[]
  ).map((w) => ({ id: w.id, generation: workClass(w.status) }));
  return { plans: plans.map((p) => ({ id: p.id, generation: p.generation })), requirements, checks, findings, results, work };
}

export function workClass(status: string): 'active' | 'held' | 'terminal' {
  if (status === 'parked' || status === 'held') return 'held';
  if (status === 'complete' || status === 'cancelled') return 'terminal';
  return 'active';
}

// The main thread's read before the side ref's intent (runs/accept.ts): the
// impact, or the reason the proposal is refused (D6 §4.4).
export function impactRead(db: Db, args: { project: string; representation: SpecRepresentation; digest: string | null; claimed: unknown; work_item?: string | null }): { impact: Impact } | { refused: string } {
  // The request the proposing run's item is for (a design's change names
  // its design's human criteria through it).
  const request = args.work_item ? ((db.prepare('SELECT "id" FROM "spec_change_requests" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(args.work_item) as { id: string } | undefined)?.id ?? null) : null;
  try {
    return { impact: computeImpact(db, { project: args.project, proposed: args.representation, proposedDigest: args.digest, claimed: args.claimed, request }) };
  } catch (err) {
    if (err instanceof ImpactRefused) return { refused: err.message };
    throw err;
  }
}

// ---- the proposal on its side ref (D6 §4.3) ------------------------------------------------

export interface ProposalInputs {
  purpose: 'spec_change';
  ref: string;
  ref_kind: 'spec_change';
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
  // The side ref is a registered ref of the engine's (D6 §4.3), of RefKind
  // `spec_change` (A.2): it makes the revision reachable and is never moved
  // by the engine; on `reject` it is kept as history.
  const inputs: ProposalInputs = {
    purpose: 'spec_change',
    ref,
    ref_kind: 'spec_change',
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
  // A design's change (D7 §7.4) waits while a correction of the protected
  // checks is undecided, or approved and not applied yet: its batch would be
  // bound to a version that may be replaced (objection 166). It is raised
  // once none is pending.
  if (r.source === 'design') {
    const pending = pendingCorrections(tx.db, op.project, r.id).map((c) => c.proposal);
    if (pending.length > 0) {
      deferDesignBatch(tx, getRequest(tx.db, r.id)!, pending);
      return { request: r.id, decision: null, deferred: pending };
    }
  }
  const added = inputs.impact.requirements.filter((q) => q.changes.includes('added')).map((q) => q.key);
  return { request: r.id, decision: raiseChangeQuestion(tx, getRequest(tx.db, r.id)!, { rep: inputs.representation, added }) };
}

// The change's question raised: for a design's change its batch first, its
// inventory compared at raise, a difference refusing the batch with nothing
// raised. The work awaits the question. Returns the spec_change raised.
function raiseChangeQuestion(tx: Tx, r: RequestRow, args: { rep: SpecRepresentation | null; added: string[] }): string | null {
  const item = r.work_item ? getWorkItem(tx, r.work_item) : undefined;
  if (r.source === 'design') {
    const batch = raiseDesignBatch(tx, { request: r.id, rep: args.rep, added: args.added });
    if (batch.refused !== null) {
      const failure = `design_batch_refused: ${batch.refused}`;
      tx.db.prepare(`UPDATE "spec_change_requests" SET "status" = 'failed', "failure" = ? WHERE "id" = ?`).run(failure, r.id);
      tx.emit('spec.change_failed', { project: r.project, spec_change_request: r.id }, { work_item: r.work_item, reason: 'design_batch_refused', failure });
      settleWork(tx, getRequest(tx.db, r.id)!, 'design_batch_refused');
      return null;
    }
  }
  const d = raiseQuestion(tx, { project: r.project, kind: 'spec_change', subjectType: 'spec_change_request', subjectId: r.id });
  if (d && r.source === 'design') tx.db.prepare('UPDATE "decisions" SET "batch_key" = (SELECT "batch_key" FROM "design_revisions" WHERE "spec_change_request" = ? ORDER BY rowid DESC LIMIT 1) WHERE "id" = ?').run(r.id, d.id);
  const blocker = d ? JSON.stringify({ reason: 'spec_change', raised_at: tx.at, decision: d.id }) : null;
  if (d && item && item.status === 'executing') {
    transitionWork(tx, item, 'awaiting_decision', { blocker }, { spec_change_request: r.id, decision: d.id });
  } else if (d && item && item.status === 'awaiting_decision') {
    // A deferred batch raised now: the work awaits this question.
    tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(blocker, item.id);
  }
  return d?.id ?? null;
}

// The batch held back (objection 166): the work awaits, its blocker naming
// the corrections it waits for; no question is raised.
function deferDesignBatch(tx: Tx, r: RequestRow, pending: string[]): void {
  const item = r.work_item ? getWorkItem(tx, r.work_item) : undefined;
  if (!item || item.status !== 'executing') return;
  const blocker = JSON.stringify({ reason: DESIGN_BATCH_DEFERRED, raised_at: tx.at, spec_change_request: r.id, pending_corrections: pending });
  transitionWork(tx, item, 'awaiting_decision', { blocker }, { spec_change_request: r.id, cause: DESIGN_BATCH_DEFERRED, pending_corrections: pending });
}

// At the design's tick: with no correction pending any more, each deferred
// batch is raised, bound to the version as it now is (objection 166).
export function raiseDeferredBatches(tx: Tx, project: string): string[] {
  const raised: string[] = [];
  for (const b of deferredBatches(tx.db, project)) {
    if (b.pending_corrections.length > 0) continue;
    const d = raiseDeferred(tx, b.spec_change_request);
    if (d) raised.push(d);
  }
  return raised;
}

function raiseDeferred(tx: Tx, request: string): string | null {
  const r = getRequest(tx.db, request);
  if (!r || r.status !== 'proposed') return null;
  const sem = proposalSemantics(tx.db, r);
  const rep = liveRepresentation(parseJson<SpecRepresentation>(sem?.representation ?? null));
  const added = (parseJson<Impact>(r.impact_value)?.requirements ?? []).filter((q) => q.changes.includes('added')).map((q) => q.key);
  return raiseChangeQuestion(tx, r, { rep, added });
}

// What a deferred batch's work waits on (store/transitions/awaiting.ts: no
// item awaits on nothing): the corrections pending; with none, the batch is
// raised now. False: nothing to wait on and nothing raised.
export function settleDeferredBatch(tx: Tx, item: string): boolean {
  const w = getWorkItem(tx, item);
  if (!w || w.status !== 'awaiting_decision') return true;
  const blocker = parseJson<{ spec_change_request?: string }>(w.blocker);
  const request = blocker?.spec_change_request ?? (tx.db.prepare('SELECT "id" FROM "spec_change_requests" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(item) as { id: string } | undefined)?.id ?? null;
  if (pendingCorrections(tx.db, w.project, request).length > 0) return true;
  if (request && raiseDeferred(tx, request) !== null) return true;
  return getWorkItem(tx, item)?.status !== 'awaiting_decision';
}

// The impact as it stands now (D6 §4.4: preview and effect recompute it):
// the proposal's representation, recorded with the run's semantics, against
// the approved version and the records as they are.
// The proposal's recorded representation (finalizeProposal's).
export function proposalSemantics(db: Db, r: RequestRow): SemanticsRow | undefined {
  if (r.proposal_blob === null) return undefined;
  return db
    .prepare(`SELECT s.* FROM "spec_semantics" s JOIN "runs" u ON u."id" = s."run" WHERE u."work_item" = ? AND s."git_blob" = ? ORDER BY s.rowid DESC, s."id" DESC LIMIT 1`)
    .get(r.work_item, r.proposal_blob) as SemanticsRow | undefined;
}

export function currentImpact(db: Db, r: RequestRow): Impact | null {
  const out = impactNow(db, r);
  return 'impact' in out ? out.impact : null;
}

// The impact as it stands now, or why it cannot be computed (D6 §4.4).
export function impactNow(db: Db, r: RequestRow): { impact: Impact } | { reason: string } {
  const sem = proposalSemantics(db, r);
  const representation = liveRepresentation(parseJson<SpecRepresentation>(sem?.representation ?? null));
  if (!representation) return { reason: "the proposal's representation cannot be read" };
  try {
    return { impact: computeImpact(db, { project: r.project, proposed: representation, proposedDigest: sem?.semantic_digest ?? null, claimed: parseJson<Impact>(r.impact_value)?.claimed ?? null, request: r.id }) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

// A pending proposal whose impact can no longer be computed is refused with
// the reason (D6 §4.4; the slice-36 review's S2): the request ends `failed`
// naming it, its work ends, and the one-at-a-time slot frees for the next.
function refuseProposal(tx: Tx, r: RequestRow, reason: string): void {
  if (r.status !== 'proposed') return;
  const failure = `spec_impact_uncomputable: the proposal is refused, its impact cannot be computed against the specification now approved: ${reason}`;
  tx.db.prepare(`UPDATE "spec_change_requests" SET "status" = 'failed', "failure" = ? WHERE "id" = ? AND "status" = 'proposed'`).run(failure, r.id);
  tx.emit('spec.change_failed', { project: r.project, spec_change_request: r.id }, { work_item: r.work_item, reason: 'spec_impact_uncomputable', failure });
  settleWork(tx, r, 'refused');
  // A request waiting for the slot may now be dispatched.
  markStale(tx, { project: r.project });
}

// ---- the decision (D6 §4.5; floor) ---------------------------------------------------------

// Why an approval could not be applied, as the question raised again says it.
const REFUSAL_TEXT: Record<string, string> = {
  proposal: 'the proposal could not be read',
  integration_revision_unread: 'the integration branch could not be read',
  merge_base_unread: "the proposal's base could not be read",
  spec_files_unread: 'the specification files could not be read',
  spec_files_moved: "the specification files changed on the integration branch since the proposal's base, so its rebase would not be the approved specification",
  rebase_unread: 'the rebase onto the integration branch could not be read',
  rebase_conflict: 'the proposal does not rebase onto the integration branch',
  commit_unprepared: 'the commit could not be prepared',
  spec_semantics_invalid: 'the proposed specification has a finding that blocks its approval',
  impact: 'its impact could not be computed',
};

export const SPEC_CHANGE_KEYS = ['spec_version', 'proposal_revision', 'protected_version', 'impact', 'dependency_manifest', 'side_ref', 'policy_revision'];

export function changeManifest(db: Db, id: string): Record<string, unknown> {
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
        : sha256(canonical({ digests: [impact.approved_digest, impact.proposed_digest], requirements: impact.requirements, affected: impact.affected_criteria, removed: impact.removed_criteria, added: impact.added_criteria, checks: impact.checks, phases: impact.phases, touches_current: impact.touches_current, touches_later: impact.touches_later })),
    // The dependency generations of what the impact lists, recomputed (D6
    // §4.4): a new result, finding, work status or plan generation touching
    // a listed subject makes the answer stale; one touching nothing listed
    // does not.
    dependency_manifest: impact === null ? null : impact.dependency_manifest,
    // The side ref as the engine observes it (D6 §4.3; M431 (f)): moved out
    // of band, the answer is stale. The proposal's identity is the revision
    // the request recorded, whatever the ref holds.
    side_ref: r ? sideRefObservation(db, r) : null,
    policy_revision: project === null ? null : policyRevision(db, project),
    // A design's change is bound to the design tree as the last save left
    // it, as its batched design_approval is (D7 §7.4; M505 (g)).
    ...(r?.source === 'design' && project !== null ? { design_tree: designTreeHash(db, project) } : {}),
  };
}

// An open out-of-band observation of the request's side ref: what was found
// there, or null when the ref is where the engine put it.
function sideRefObservation(db: Db, r: RequestRow): { ref: string; found: string | null } | null {
  if (r.side_ref === null) return null;
  const o = db
    .prepare(
      `SELECT o."found" FROM "out_of_band_changes" o JOIN "ref_registry" g ON g."id" = o."ref"
       WHERE o."project" = ? AND g."ref" = ? AND o."subject_kind" = 'ref' AND o."disposition" IS NULL AND o."closed_at" IS NULL ORDER BY o.rowid DESC, o."id" DESC LIMIT 1`,
    )
    .get(r.project, r.side_ref) as { found: string | null } | undefined;
  return o ? { ref: r.side_ref, found: o.found } : null;
}

export function specChangeKind(): KindSpec {
  return {
    preview(tx, d) {
      const r = getRequest(tx.db, d.subject_id);
      if (!r || r.status !== 'proposed' || r.proposal_revision === null) return null;
      const now = impactNow(tx.db, r);
      if ('reason' in now) {
        refuseProposal(tx, r, now.reason);
        return null;
      }
      const impact = now.impact;
      const manifest = changeManifest(tx.db, r.id);
      const listed = impact.checks.obligations.map((c) => c.key);
      // An honesty aid (the driver's ruling (3) on (B), slice 37): how many
      // executions of the impact's checks were queued, materializing or
      // running when the question was raised. Not bound: a result they
      // record that moves the impact asks again (D6 §4.4).
      const settling = impactSettling(tx.db, r.id);
      return {
        manifest,
        raised: { settling },
        question: `${r.last_refusal ? `The last approval of specification change ${r.seq} could not be applied (${REFUSAL_TEXT[r.last_refusal.split(':')[0]!] ?? r.last_refusal}). ` : ''}Approve specification change ${r.seq} as version ${Number(manifest.spec_version) + 1}? It changes ${impact.requirements.map((q) => `${q.key} (${q.changes.join(', ')})`).join('; ') || 'nothing the engine can name'}; ${listed.length} check(s) would owe a correction (${listed.join(', ') || 'none'}), ${impact.evidence.results.length} result(s) would be invalidated${impact.touches_current ? ', and the current phase is touched, so a replan follows' : ''}.${settling > 0 ? ` ${settling} execution(s) of its checks were still queued or running when this was asked; a result they record may change the impact, and the question is then asked again.` : ''}`,
        options: [
          {
            key: 'approve',
            label: 'Approve',
            consequence: 'The proposed specification is integrated as the next approved version; the listed results are invalidated, the listed checks owe a correction, and the Verifier and (where a current or later phase is touched) the Architect are given work.',
            effect: { request: r.id, revision: r.proposal_revision, spec_version: Number(manifest.spec_version) + 1 },
            // What could not be approved as a specification cannot be approved
            // as a change of one (D6 §3.4; the 31b review's S1).
            // And a review's design change, until its verdicts are the
            // owner's (the driver's decision on the slice-44 review's S9).
            blockers: [...specBlockers(proposalSemantics(tx.db, r), approvedRepresentation(tx.db, r.project), { questions: false }), ...(r.source === 'design' ? requestVerdictBlockers(tx.db, r.id) : [])],
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
        // The side ref stays where it is, registered, as history (D6 §4.5).
        tx.emit('spec.change_rejected', { project: r.project, spec_change_request: r.id }, { decision: d.id, side_ref: r.side_ref, revision: r.proposal_revision });
        settleWork(tx, r, 'rejected');
        return consumed(d);
      }
      const approval = recordApproval(tx, d, { consequence: `specification change ${r.seq} approved`, subjectType: 'spec_change_request', subjectId: r.id });
      return consumed(d, [recordIntent(tx, d, { approval, kind: 'spec_change_application', plan: { request: r.id } })]);
    },
    // An effect whose precondition failed: the question is asked again
    // against what is there now.
    withdraw: (tx, d) => {
      // A design's change asked again: its design_approval with it (D7 §7.4).
      if (getRequest(tx.db, d.subject_id)?.source === 'design') reraiseDesignBatch(tx, d.subject_id);
      return true;
    },
  };
}

export function settleWork(tx: Tx, r: RequestRow, cause: string): void {
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
  // The change log row (TPL §11): the request's number, the version the
  // approval allocates, and who approved.
  seq: number;
  version: number;
  approved_by: string | null;
}

export function applicationFacts(tx: Tx, args: { intent: string }): ApplicationFacts | null {
  const row = tx.db.prepare('SELECT "id", "project", "status", "plan" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { id: string; project: string; status: string; plan: string } | undefined;
  if (!row) return null;
  const plan = JSON.parse(row.plan) as { request: string };
  const r = getRequest(tx.db, plan.request);
  if (!r) return null;
  const p = projectRepoRow(tx, row.project);
  const ref = integrationRef(p.integration_branch);
  const d = tx.db.prepare('SELECT "answer" FROM "decisions" WHERE "id" = (SELECT "decision" FROM "effect_intents" WHERE "id" = ?)').get(row.id) as { answer: string | null } | undefined;
  // Unread, the effect fails closed (the review's N3 (a)), never 'human'.
  const actor = parseJson<{ actor?: unknown }>(d?.answer ?? null)?.actor;
  const approvedBy = typeof actor === 'string' && actor.length > 0 ? actor : null;
  const version = (currentSpec(tx.db, row.project)?.version ?? 0) + 1;
  return { intent: row.id, status: row.status, project: row.project, repo: p.dev_repo_path, ref, head: registryRow(tx, row.project, ref)?.expected_oid ?? null, request: r.id, revision: r.proposal_revision, seq: r.seq, version, approved_by: approvedBy };
}

export interface AppliedInputs {
  purpose: 'spec_applied';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  request: string;
  intent: string;
  // The approved file's blob as committed, with the engine's change log row
  // (TPL §11): what spec_revisions.git_blob records.
  blob?: string;
  // The impact recomputed at the effect's beginning, frozen with the intent
  // (D1 correction 14): the finalizer recomputes it and falls back to this,
  // never to the proposal's (the 31b review's M1).
  impact: Impact;
  // A design's change (E156 Q3): the roadmap file the same commit writes,
  // with the human tests' engine assignment, as the next roadmap version.
  roadmap?: { blob: string; path: string; version: number; from_version: number };
}

// An application that cannot be made as approved (a precondition unread, a
// rebase that conflicts or touches the spec files, a proposal that could
// not be approved, an impact that cannot be recomputed): the intent is
// invalidated EFFECT_PRECONDITION_CHANGED, the approval withdrawn and the
// next generation of the question raised to the owner (D1 §10.5; the 31b
// review's S7). Never a silent retry.
export function refuseApplication(tx: Tx, args: { intent: string; reason: string }): boolean {
  const row = tx.db.prepare('SELECT "status" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { status: string } | undefined;
  if (!row || row.status !== 'pending') return false;
  // The reason goes with the question raised again (the coordinator's ruling
  // on the 31b review): recorded before the invalidation raises it.
  const plan = tx.db.prepare('SELECT "plan" FROM "effect_intents" WHERE "id" = ?').get(args.intent) as { plan: string };
  const request = parseJson<{ request?: string }>(plan.plan)?.request;
  if (request) tx.db.prepare('UPDATE "spec_change_requests" SET "last_refusal" = ? WHERE "id" = ?').run(args.reason, request);
  invalidateIntent(tx, args.intent, [args.reason]);
  return true;
}

// The intent begins (decisions/effects.ts): its preconditions read again,
// then the integration branch moved to the proposal (or its rebase onto the
// head, committed first) by a journaled compare-and-swap.
export function beginApplication(
  tx: Tx,
  args: { intent: string; head: string; commit: { sha: string; tree: string; content: string; parent?: string; blob?: string; roadmap?: AppliedInputs['roadmap'] } | null; deadlineSeconds: number },
): IntentResult | null {
  if (!revalidateIntent(tx, args.intent, {})) return null;
  const facts = applicationFacts(tx, { intent: args.intent });
  if (!facts || facts.revision === null) {
    refuseApplication(tx, { intent: args.intent, reason: 'proposal' });
    return null;
  }
  // The branch moved between the main thread's read and this transaction:
  // begun at a later tick, against what is there then.
  if (facts.head !== args.head) return null;
  const r = getRequest(tx.db, facts.request)!;
  // A design's change waits for its design's approval and the batch's
  // release, and is refused when the design was sent back, rejected, or the
  // bindings its approval was given on moved (D7 §7.4; E156 Q3).
  if (r.source === 'design') {
    const state = designBatchState(tx.db, r.id);
    if (state === 'wait') return null;
    if (state === 'refuse') {
      refuseApplication(tx, { intent: args.intent, reason: 'design_not_approved' });
      return null;
    }
    const moved = designBindingsChanged(tx.db, r.id);
    if (moved !== null) {
      refuseApplication(tx, { intent: args.intent, reason: `design_bindings_changed:${moved}` });
      reraiseDesignBatch(tx, r.id);
      return null;
    }
  }
  if (specBlockers(proposalSemantics(tx.db, r), approvedRepresentation(tx.db, r.project), { questions: false }).length > 0) {
    refuseApplication(tx, { intent: args.intent, reason: 'spec_semantics_invalid' });
    return null;
  }
  const impact = currentImpact(tx.db, r);
  if (impact === null) {
    refuseApplication(tx, { intent: args.intent, reason: 'impact' });
    return null;
  }
  const target = args.commit?.sha ?? facts.revision;
  const follow = {
    project: facts.project,
    kind: 'ref_update' as const,
    payload: { repo: facts.repo, ref: facts.ref, old_oid: args.head, new_oid: target },
    target: { repo: facts.repo, ref: facts.ref },
    subject: { spec_change_request: facts.request, old_oid: args.head, new_oid: target },
    finalizer: { purpose: 'spec_applied', ref: facts.ref, ref_kind: 'integration', new_oid: target, request: facts.request, intent: args.intent, impact, ...(args.commit?.blob ? { blob: args.commit.blob } : {}), ...(args.commit?.roadmap ? { roadmap: args.commit.roadmap } : {}) } satisfies AppliedInputs as unknown as Record<string, unknown>,
    deadlineSeconds: args.deadlineSeconds,
  };
  const made = args.commit === null
    ? intendOperation(tx, follow)
    : intendCommit(tx, {
        project: facts.project,
        repo: facts.repo,
        purpose: 'spec',
        tree: args.commit.tree,
        parent: args.commit.parent ?? args.head,
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
  if (r.status === 'approved') {
    completeIntent(tx, inputs.intent);
    return { request: r.id };
  }
  const run = tx.db.prepare('SELECT "id" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(r.work_item) as { id: string } | undefined;
  const intent = tx.db.prepare('SELECT "decision" FROM "effect_intents" WHERE "id" = ?').get(inputs.intent) as { decision: string } | undefined;
  if (!run || !intent) throw illegal('applying a spec change with no run or no decision', { spec_change_request: r.id });
  // Recomputed against the records as they are now (D6 §4.4; ruling Q1), or
  // as the effect's beginning recomputed them; never the proposal's.
  const impact = currentImpact(tx.db, r) ?? inputs.impact;
  const made = approveSpec(tx, { project: op.project, run: run.id, decision: intent.decision, via: 'change', ...(inputs.blob ? { blob: inputs.blob } : {}) });
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
  // A check on a removed criterion owes its correction too (the 31b
  // review's M3): its results are invalidated with the others, and the
  // obligation keeps every gate naming it until the correction lands.
  for (const c of [...impact.checks.obligations, ...impact.checks.criterion_unknown]) insert.run(tx.newId('obl_'), tx.at, op.project, c.check, c.key, JSON.stringify(c.criteria), generation, r.id);
  // The Verifier's correction, naming the affected and uncovered criteria
  // (D3 §2.11's route).
  if (impact.checks.obligations.length > 0 || impact.checks.uncovered.length > 0 || impact.checks.criterion_unknown.length > 0) {
    // It names what it is to correct (D6 §4.5; M433 (d)): the affected
    // criteria, the uncovered ones, the removed ones, and the checks owed.
    const criteria = { affected: impact.affected_criteria, uncovered: impact.checks.uncovered, removed: impact.removed_criteria };
    const owed = uniq([...impact.checks.obligations, ...impact.checks.criterion_unknown].map((c) => c.key)).sort();
    observeTrigger(
      tx,
      { project: op.project, kind: 'check_correction', trigger_source: 'spec_obligation', trigger_id: r.id, trigger_generation: 1, subject: { request: r.id }, trigger_evidence: { criteria, checks: owed, generation }, chain: 0 },
      { spec_change_request: r.id, criteria, checks: owed },
    );
  }
  // The Architect's replan when the current or a later phase is touched
  // (F §3.10.7), the impact its triggering evidence.
  // Before any roadmap there is no phase to touch (D6 §4.5; the
  // coordinator's ruling on slice 34): no replan holds the project then.
  const roadmap = tx.db.prepare('SELECT 1 FROM "roadmap_revisions" WHERE "project" = ? LIMIT 1').get(op.project) !== undefined;
  // A design's change (D7 §7.4): the design approved in the transaction that
  // applies n+1; its human tests are placed by the engine's assignment, so
  // it registers no replan.
  const design = r.source === 'design' ? revisionOfRequest(tx.db, r.id) : undefined;
  if (design) approveDesign(tx, { revision: design.id, specRevision: made.spec_revision, withoutCriteria: false, ...(inputs.roadmap ? { roadmap: inputs.roadmap } : {}) });
  // A requirement the change adds that the engine's assignment did not
  // place (a human test whose phase cannot be determined, a criterion with
  // requirement "new", an ordinary new requirement) goes the normal way
  // (E156 Q3; D6 reading 6): the replan places it, REQUIREMENT_UNASSIGNED
  // naming it on every phase gate until then.
  const placed = new Set(
    (parseJson<{ requirement: string | null; phase: number | null }[]>(design ? (getRevision(tx.db, design.id)?.assignments ?? null) : null) ?? []).filter((a) => a.requirement !== null && a.phase !== null).map((a) => a.requirement!),
  );
  const unplaced = design !== undefined && impact.requirements.some((q) => q.changes.includes('added') && !placed.has(q.key));
  if ((impact.touches_current || impact.touches_later === true) && roadmap && (!design || unplaced)) {
    // Only a change touching the current phase replaces its plan early (D6
    // §5.7; the slice-36 review's M1): a later-only change's replan binds no
    // open plan and supersedes none of the current phase's stages.
    const open = impact.touches_current
      ? (tx.db.prepare(`SELECT "id", "generation" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "completed_at" IS NULL ORDER BY "phase_number" LIMIT 1`).get(op.project) as { id: string; generation: number } | undefined)
      : undefined;
    // An early replan (D6 §5.7; B08): it names the generation it replaces,
    // and records the impact as its evidence and what the impact made stale.
    const stale = [
      ...impact.stages.map((st) => `stage ${st.number}`),
      ...impact.requirements.map((q) => `requirement:${q.key}`),
      ...uniq([...impact.affected_criteria, ...impact.removed_criteria, ...impact.added_criteria]).map((c) => `criterion:${c}`),
      ...uniq([...impact.checks.obligations, ...impact.checks.criterion_unknown].map((c) => c.key)).map((k) => `check:${k}`),
    ];
    const evidence = { request: r.id, impact: r.impact ?? null, spec_revision: made.spec_revision };
    observeTrigger(
      tx,
      {
        project: op.project,
        kind: 'replan',
        trigger_source: 'spec_change',
        trigger_id: r.id,
        trigger_generation: 1,
        subject: open ? { phase_plan: open.id, request: r.id } : { request: r.id },
        trigger_evidence: { ...(open ? { phase_plan: open.id, generation: open.generation } : {}), evidence, stale },
        chain: 0,
      },
      { spec_change_request: r.id },
    );
  }
  // The design class (D7 §9.1; G8): the screens the change stales, marked
  // in this transaction; never by a design's own batched change (§7.4).
  if (r.source !== 'design' && r.source !== 'design_review') {
    const staled = staleScreens(tx, { project: op.project, screens: impact.design?.screens ?? [], cause: { spec_change_request: r.id, spec_revision: made.spec_revision } });
    // A new cause: design_due asked again at once, a deferral included (D7 §11).
    if (staled.length > 0) reviewDesignDue(tx, op.project);
  }
  settleWork(tx, getRequest(tx.db, r.id)!, 'approved');
  // The approval's intent is done with its effect (the 31b review's S8).
  completeIntent(tx, inputs.intent);
  tx.emit('spec.change_approved', { project: op.project, spec_change_request: r.id }, { spec_revision: made.spec_revision, version: made.version, generation, obligations: impact.checks.obligations.length, results: impact.evidence.results.length, operation: op.id });
  markStale(tx, { project: op.project });
  return { request: r.id, spec_revision: made.spec_revision };
}

// ---- a change after the final phase (E153 item 1; D6 §4.5 amended) --------------------------

// Whether every phase of the approved roadmap is complete, with no open plan
// (published and not complete). False with no roadmap or an empty one.
export function everyPhaseComplete(db: Db, project: string): boolean {
  const road = db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { phases: string } | undefined;
  const phases = (parseJson<{ number: number }[]>(road?.phases ?? null) ?? []).map((p) => p.number);
  if (phases.length === 0) return false;
  const open = db.prepare(`SELECT 1 FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" = 'published' AND "completed_at" IS NULL LIMIT 1`).get(project);
  if (open) return false;
  const done = new Set(
    (db.prepare(`SELECT "phase_number" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" = 'completed' AND "completed_at" IS NOT NULL`).all(project) as { phase_number: number }[]).map((r) => r.phase_number),
  );
  return phases.every((n) => done.has(n));
}

// What a request's corrected checks say on the last candidate, once its
// obligations are resolved: 'failing' when one of them failed there (an
// implementation obligation no stage has met), 'passing' when every one
// passed, null while any is unresolved, unrecorded or not established
// (unknown is a value: never read as passing or failing).
export type DeliveryVerdict = { verdict: 'failing' | 'passing'; candidate: string; results: { key: string; result: string; state: 'passed' | 'failed' }[] };
export function deliveryVerdict(db: Db, project: string, request: string): DeliveryVerdict | null {
  const obligations = db.prepare(`SELECT "key", "resolved_by", "resolved_at" FROM "check_obligations" WHERE "project" = ? AND "request" = ? AND "reason" = 'spec_changed'`).all(project, request) as {
    key: string;
    resolved_by: string | null;
    resolved_at: string | null;
  }[];
  // The criteria the change added that no check covered (D6 §4.5's
  // uncovered criteria; a design's criteria, D7 §10.4): their checks are
  // the correction's to author, and are evidence once it is applied.
  const added = addedCriteriaChecks(db, project, request);
  if (obligations.length === 0 && added !== null && added.length === 0) return null;
  // What is not established yet (an obligation unresolved, an added
  // criterion's check not applied, a result to come) is unknown: never read
  // as passing. But an established failure is failing whatever else is
  // unknown (the slice-44 review's S8).
  const resolved = obligations.filter((o) => o.resolved_at !== null && o.resolved_by !== null);
  let unknown = resolved.length < obligations.length || added === null;
  const last = db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(project) as { id: string } | undefined;
  if (!last) return null;
  // Fresh evidence (D6 §4.5): a result under the protected version the
  // correction made effective, or the one effective now.
  const versions = uniq([...resolved.map((o) => o.resolved_by!), ...(effectiveVersion(db, project) ? [effectiveVersion(db, project)!.id] : [])]);
  const results: DeliveryVerdict['results'] = [];
  for (const key of uniq([...resolved.map((o) => o.key), ...(added ?? [])]).sort()) {
    const r = db
      .prepare(
        `SELECT r."id", r."execution_established", r."signaled", r."deadline_hit", r."orphans", r."exit_status" FROM "check_results" r JOIN "checks" c ON c."id" = r."check"
         WHERE r."project" = ? AND r."candidate" = ? AND c."key" = ? AND r."invalidated_at" IS NULL AND r."protected_version" IN (SELECT value FROM json_each(?))
         ORDER BY r."execution_seq" DESC LIMIT 1`,
      )
      .get(project, last.id, key, JSON.stringify(versions)) as { id: string; execution_established: number; signaled: number; deadline_hit: number; orphans: number | null; exit_status: number | null } | undefined;
    if (!r) {
      unknown = true;
      continue;
    }
    const state = resultState(r);
    if (state === 'skipped') {
      unknown = true;
      continue;
    }
    results.push({ key, result: r.id, state });
  }
  if (results.some((r) => r.state === 'failed')) return { verdict: 'failing', candidate: last.id, results };
  if (unknown || results.length === 0) return null;
  return { verdict: 'passing', candidate: last.id, results };
}

// The keys of the effective checks covering the criteria `request` added
// uncovered ([] when it added none); null while they are not established
// yet: its correction not applied, or a criterion still uncovered (unknown,
// never read as passing or failing).
function addedCriteriaChecks(db: Db, project: string, request: string): string[] | null {
  const r = db.prepare('SELECT "impact_value" FROM "spec_change_requests" WHERE "id" = ?').get(request) as { impact_value: string | null } | undefined;
  // A design criterion of kind `human` owes no check, also in an impact
  // recorded before the driver's ruling on M519's F1 listed it uncovered.
  const human = designHumanCriteria(db, project);
  const uncovered = (parseJson<Impact>(r?.impact_value ?? null)?.checks?.uncovered ?? []).filter((c) => !human.has(c));
  if (uncovered.length === 0) return [];
  if (db.prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" = 'check_correction' AND "trigger_source" = 'spec_obligation' AND "trigger_id" = ? AND "status" NOT IN ('complete', 'cancelled') LIMIT 1`).get(project, request)) return null;
  const version = effectiveVersion(db, project);
  if (!version) return null;
  const checks = checksOfVersion(db, version.id);
  const keys: string[] = [];
  for (const c of uncovered) {
    const covering = checks.filter((k) => (parseJson<string[]>((k as { criteria?: string }).criteria ?? null) ?? []).includes(c));
    if (covering.length === 0) return null;
    keys.push(...covering.map((k) => k.key));
  }
  return uniq(keys).sort();
}

// E153 item 1: an approved change that leaves an implementation obligation
// when every phase of the roadmap is complete schedules one Architect replan
// (D6 §5.6's one-shot), whose delivery phase follows D6 §5. The obligation
// is read from evidence, never from the impact alone: the change's corrected
// checks, its obligations resolved by the correction, recorded failing on
// the last candidate. The engine waits for those results; a change whose
// corrected checks pass there, or a change with no obligation (text only),
// registers nothing (E153 (d)). One per change request (the trigger's
// identity, `spec_change` and the request, as the early replan's): a tick
// or a restart registers none again (E153 (a)). Completed phases are not
// reopened (E153 (b)). Only a change approved after the last phase
// completed is considered: one approved while a phase was open was that
// phase's to meet (§4.5's replan or the phase gate's regression set).
export function registerDeliveryReplans(tx: Tx, args: { project: string }): string[] {
  const db = tx.db;
  if (!everyPhaseComplete(db, args.project)) return [];
  // A replan already under way proposes the next phase; a second waits for
  // it (its delivery may meet this change's checks too).
  if (db.prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "status" NOT IN ('complete', 'cancelled') LIMIT 1`).get(args.project)) return [];
  const lastCompletion = (db.prepare(`SELECT MAX("seq") AS s FROM "events" WHERE "type" = 'baseline.phase_complete' AND json_extract("subject", '$.project') = ?`).get(args.project) as { s: number | null }).s ?? 0;
  const requests = db
    .prepare(
      `SELECT r."id", r."seq", r."impact", r."approved_revision", r."impact_value" FROM "spec_change_requests" r
       WHERE r."project" = ? AND r."status" = 'approved'
         AND (EXISTS (SELECT 1 FROM "check_obligations" o WHERE o."request" = r."id" AND o."reason" = 'spec_changed')
              OR COALESCE(json_array_length(json_extract(r."impact_value", '$.checks.uncovered')), 0) > 0)
         AND NOT EXISTS (SELECT 1 FROM "work_items" w WHERE w."project" = r."project" AND w."kind" = 'replan' AND w."trigger_source" = 'spec_change' AND w."trigger_id" = r."id")
         AND EXISTS (SELECT 1 FROM "events" e WHERE e."type" = 'spec.change_approved' AND json_extract(e."subject", '$.spec_change_request') = r."id" AND e."seq" > ?)
       ORDER BY r."seq"`,
    )
    .all(args.project, lastCompletion) as { id: string; seq: number; impact: string | null; approved_revision: string | null; impact_value: string | null }[];
  const made: string[] = [];
  for (const r of requests) {
    const verdict = deliveryVerdict(db, args.project, r.id);
    if (!verdict || verdict.verdict !== 'failing') continue;
    const impact = parseJson<Impact>(r.impact_value);
    const failing = verdict.results.filter((x) => x.state === 'failed');
    const stale = impact
      ? [
          ...impact.requirements.map((q) => `requirement:${q.key}`),
          ...uniq([...impact.affected_criteria, ...impact.removed_criteria, ...impact.added_criteria]).map((c) => `criterion:${c}`),
          ...failing.map((x) => `check:${x.key}`),
        ]
      : failing.map((x) => `check:${x.key}`);
    const evidence = { request: r.id, impact: r.impact ?? null, spec_revision: r.approved_revision };
    const work = observeTrigger(
      tx,
      {
        project: args.project,
        kind: 'replan',
        trigger_source: 'spec_change',
        trigger_id: r.id,
        trigger_generation: 1,
        subject: { request: r.id },
        trigger_evidence: { evidence, stale, delivery: { every_phase_complete: true, candidate: verdict.candidate, failing: failing.map((x) => ({ key: x.key, result: x.result })) } },
        chain: 0,
      },
      { spec_change_request: r.id, delivery: { candidate: verdict.candidate, failing: failing.map((x) => x.key) } },
    );
    if (!work.created) continue;
    made.push(work.work_item.id);
  }
  if (made.length > 0) markStale(tx, { project: args.project });
  return made;
}

// ---- obligations (D6 §4.5) ------------------------------------------------------------------

// The unresolved obligations of a project's checks, by check key.
export function unresolvedObligations(db: Db, project: string): Map<string, number> {
  const rows = db.prepare(`SELECT "key", MAX("generation") AS g FROM "check_obligations" WHERE "project" = ? AND "reason" = 'spec_changed' AND "resolved_at" IS NULL GROUP BY "key"`).all(project) as { key: string; g: number }[];
  return new Map(rows.map((r) => [r.key, r.g]));
}

// The highest generation of any obligation, resolved or not, on a check key:
// a result registered under an earlier generation is history (D6 §4.5).
export function obligationGeneration(db: Db, project: string, key: string): number | null {
  const row = db.prepare(`SELECT MAX("generation") AS g FROM "check_obligations" WHERE "project" = ? AND "key" = ? AND "reason" = 'spec_changed'`).get(project, key) as { g: number | null };
  return row.g;
}

// A correction applied that the request's `check_correction` work proposed
// resolves the obligations it actually names (D6 §4.5: "a protected
// correction applied that names the criteria"; the 31b review's S2): an
// obligation whose check the applied proposal affected (its classification's
// `affected_checks`), and whose recorded criteria the check of that key in
// the applied version still covers. Any other obligation stays open.
export function resolveByCorrection(tx: Tx, args: { project: string; proposal: string; version: string }): void {
  const row = tx.db
    .prepare(
      `SELECT w."subject", p."affected_checks" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" JOIN "work_items" w ON w."id" = r."work_item"
       WHERE p."id" = ? AND w."kind" = 'check_correction'`,
    )
    .get(args.proposal) as { subject: string; affected_checks: string | null } | undefined;
  const request = row ? parseJson<{ request?: string }>(row.subject)?.request : undefined;
  if (!row || !request) return;
  const named = new Set((parseJson<{ check: string }[]>(row.affected_checks) ?? []).map((a) => a.check));
  // Whichever request recorded an obligation (the 31b review's M2, A): an
  // obligation a later change's correction meets is resolved by it.
  const open = tx.db.prepare(`SELECT "id", "key", "criteria" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'spec_changed' AND "resolved_at" IS NULL`).all(args.project) as {
    id: string;
    key: string;
    criteria: string;
  }[];
  // The criteria the approved specification has now: an owed criterion it
  // still has must be covered by the corrected check; one it no longer has
  // (a removed criterion) must no longer be.
  const known = new Set((tx.db.prepare('SELECT "criteria" FROM "requirements" WHERE "project" = ? AND "withdrawn_at" IS NULL').all(args.project) as { criteria: string | null }[]).flatMap((q) => parseJson<string[]>(q.criteria) ?? []));
  let changed = 0;
  for (const o of open) {
    if (!named.has(o.key)) continue;
    const check = tx.db.prepare('SELECT "criteria" FROM "checks" WHERE "protected_version" = ? AND "key" = ?').get(args.version, o.key) as { criteria: string | null } | undefined;
    const covers = check ? (parseJson<string[]>(check.criteria) ?? []) : [];
    const owed = parseJson<string[]>(o.criteria) ?? [];
    // A check the correction removed names nothing it owed.
    if (check && !owed.every((c) => (known.has(c) ? covers.includes(c) : !covers.includes(c)))) continue;
    // Resolved by the applied protected version (A.3; Q7).
    if (resolveObligation(tx, { project: args.project, obligation: o.id, by: args.version, how: 'correction' })) changed++;
  }
  if (changed > 0) markStale(tx, { project: args.project });
}

// ---- the correction of a specification change (D6 §4.5; Q6, Q13) -------------------------

// The Verifier's applicability assessment as its result carries it.
export interface ApplicabilityEntry {
  check: string;
  criteria: string[];
  rationale: string;
}

// The request a `check_correction` item corrects for, when it is a
// specification change's (registered by finalizeApplied), else null.
export function correctionRequestOf(db: Db, workItem: string): string | null {
  const w = db.prepare(`SELECT "subject", "trigger_source" FROM "work_items" WHERE "id" = ? AND "kind" = 'check_correction'`).get(workItem) as { subject: string; trigger_source: string } | undefined;
  if (!w || w.trigger_source !== 'spec_obligation') return null;
  const request = parseJson<{ request?: unknown }>(w.subject)?.request;
  return typeof request === 'string' ? request : null;
}

interface OpenObligation {
  id: string;
  key: string;
  criteria: string[];
  request: string | null;
}

const openObligations = (db: Db, project: string): OpenObligation[] =>
  (db.prepare(`SELECT "id", "key", "criteria", "request" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'spec_changed' AND "resolved_at" IS NULL ORDER BY rowid, "id"`).all(project) as { id: string; key: string; criteria: string; request: string | null }[]).map(
    (o) => ({ id: o.id, key: o.key, criteria: parseJson<string[]>(o.criteria) ?? [], request: o.request }),
  );

// What a correction run's acceptance needs (runs/accept.ts): whether its
// item is a specification change's, the open obligations of that request,
// and, per assessment entry, the open obligations it would resolve.
export function correctionFacts(db: Db, args: { run: string; entries: ApplicabilityEntry[] }): { request: string | null; open: string[]; resolves: string[][]; outside: string[] } {
  const run = db.prepare('SELECT "project", "work_item" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; work_item: string | null } | undefined;
  if (!run || run.work_item === null) return { request: null, open: [], resolves: args.entries.map(() => []), outside: [] };
  // An assessment is of a check of the effective protected version (the
  // slice-36 review's N3): one naming a key the version does not have is
  // refused, never recorded against an obligation by its key alone.
  const effective = effectiveVersion(db, run.project);
  const keys = new Set(effective ? checksOfVersion(db, effective.id).map((c) => c.key) : []);
  const outside = uniq(args.entries.map((e) => e.check).filter((k) => !keys.has(k))).sort();
  const request = correctionRequestOf(db, run.work_item);
  const all = openObligations(db, run.project);
  return {
    request,
    open: request === null ? [] : uniq(all.filter((o) => o.request === request).map((o) => o.key)).sort(),
    resolves: args.entries.map((e) => all.filter((o) => o.key === e.check && o.criteria.every((c) => e.criteria.includes(c))).map((o) => o.id)),
    outside,
  };
}

// The Verifier's assessments recorded with their provenance, each resolving
// the open obligations of its check it covers (D6 §4.5; A.3; Q6): a role's
// claim (`claimed`), on which fresh evidence under the current generation is
// still required. Returns the assessments' ids.
export function recordAssessments(tx: Tx, args: { run: string; entries: ApplicabilityEntry[]; rationales: string[] }): string[] {
  const run = tx.db.prepare('SELECT "project", "work_item" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; work_item: string } | undefined;
  if (!run) throw notFound('run', args.run);
  const done = tx.db.prepare('SELECT "id" FROM "assessments" WHERE "run" = ? ORDER BY rowid, "id"').all(args.run) as { id: string }[];
  if (done.length > 0) return done.map((a) => a.id);
  const request = correctionRequestOf(tx.db, run.work_item);
  const effective = effectiveVersion(tx.db, run.project);
  const out: string[] = [];
  args.entries.forEach((e, i) => {
    const id = tx.newId('asmt_');
    const check = effective ? (tx.db.prepare('SELECT "id" FROM "checks" WHERE "protected_version" = ? AND "key" = ?').get(effective.id, e.check) as { id: string } | undefined) : undefined;
    const resolves = openObligations(tx.db, run.project).filter((o) => o.key === e.check && o.criteria.every((c) => e.criteria.includes(c)));
    tx.db
      .prepare(
        `INSERT INTO "assessments" ("id", "created_at", "project", "run", "work_item", "request", "check_key", "check", "criteria", "rationale", "provenance", "obligations")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)`,
      )
      .run(id, tx.at, run.project, args.run, run.work_item, request, e.check, check?.id ?? null, JSON.stringify(e.criteria), args.rationales[i], JSON.stringify(resolves.map((o) => o.id)));
    tx.emit('spec.assessment_recorded', { project: run.project, assessment: id, run: args.run }, { check: e.check, criteria: e.criteria, provenance: 'claimed', obligations: resolves.map((o) => o.id) });
    for (const o of resolves) resolveObligation(tx, { project: run.project, obligation: o.id, by: id, how: 'assessment' });
    out.push(id);
  });
  if (out.length > 0) markStale(tx, { project: run.project });
  return out;
}

function resolveObligation(tx: Tx, args: { project: string; obligation: string; by: string; how: 'correction' | 'assessment' }): boolean {
  const changed = tx.db.prepare(`UPDATE "check_obligations" SET "resolved_by" = ?, "resolved_at" = ? WHERE "id" = ? AND "resolved_at" IS NULL`).run(args.by, tx.at, args.obligation).changes;
  if (changed > 0) tx.emit('check.obligation_resolved', { project: args.project, check_obligation: args.obligation }, { resolved_by: args.by, how: args.how });
  return changed > 0;
}

// A specification change's correction item whose run captured a proposal
// waits for it (the driver's ruling Q13; the `block` template): applied, the
// item completes; rejected, it takes its repair, then parks with a blocker
// naming the open obligations. Called when the proposal is decided.
export function correctionProposalDecided(tx: Tx, args: { proposal: string; applied: boolean }): void {
  const row = tx.db.prepare('SELECT r."work_item" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" WHERE p."id" = ?').get(args.proposal) as { work_item: string | null } | undefined;
  if (!row?.work_item) return;
  const kind = (tx.db.prepare('SELECT "kind" FROM "work_items" WHERE "id" = ?').get(row.work_item) as { kind: string } | undefined)?.kind;
  if (kind !== 'check_authoring' && correctionRequestOf(tx.db, row.work_item) === null) return;
  const item = getWorkItem(tx, row.work_item);
  if (!item || item.status !== 'awaiting_decision') return;
  const blocker = parseJson<{ reason?: string; proposal?: string }>(item.blocker);
  if (blocker?.reason !== 'correction_proposed' || blocker.proposal !== args.proposal) return;
  const resumed = transitionWork(tx, item, 'executing', { blocker: null }, { proposal: args.proposal, cause: args.applied ? 'proposal_applied' : 'proposal_rejected' });
  if (args.applied) {
    correctionApplied(tx, resumed, { proposal: args.proposal });
    return;
  }
  correctionFailed(tx, resumed, { proposal: args.proposal, cause: 'proposal_rejected' });
}

// A specification change's correction whose proposal was applied, or whose
// run's assessments were recorded (the slice-36 review's S3): it completes
// only when none of its request's obligations is open. One that resolved
// some returns the rest to the Verifier, with the open obligations listed;
// one that resolved none takes its repair, then parks (Q13).
export function correctionApplied(tx: Tx, item: WorkRow, args: { proposal?: string; run?: string }): void {
  const request = correctionRequestOf(tx.db, item.id);
  const open = correctionOpenKeys(tx.db, item.id);
  const cause = { ...(args.proposal ? { proposal: args.proposal } : {}), ...(args.run ? { run: args.run } : {}) };
  if (request === null || open.length === 0) {
    transitionWork(tx, item, 'complete', {}, { ...cause, cause: 'obligations_resolved' });
    return;
  }
  const version = args.proposal ? ((tx.db.prepare('SELECT "resulting_version" FROM "protected_proposals" WHERE "id" = ?').get(args.proposal) as { resulting_version: string | null } | undefined)?.resulting_version ?? null) : null;
  const assessed = args.run ? (tx.db.prepare('SELECT "id" FROM "assessments" WHERE "run" = ?').all(args.run) as { id: string }[]).map((a) => a.id) : [];
  const by = [...(version ? [version] : []), ...assessed];
  const resolved = by.length === 0 ? 0 : (tx.db.prepare(`SELECT COUNT(*) AS n FROM "check_obligations" WHERE "request" = ? AND "resolved_by" IN (SELECT value FROM json_each(?))`).get(request, JSON.stringify(by)) as { n: number }).n;
  if (resolved === 0) {
    correctionFailed(tx, item, { ...cause, cause: 'nothing_resolved', open });
    return;
  }
  const te = tx.db.prepare('SELECT "trigger_evidence" FROM "work_items" WHERE "id" = ?').get(item.id) as { trigger_evidence: string | null } | undefined;
  const evidence = parseJson<Record<string, unknown>>(te?.trigger_evidence ?? null) ?? {};
  tx.db.prepare('UPDATE "work_items" SET "trigger_evidence" = ? WHERE "id" = ?').run(JSON.stringify({ ...evidence, open }), item.id);
  transitionWork(tx, item, 'eligible', { repair_due: 0 }, { ...cause, cause: 'obligations_open', open });
}

// The open obligations of a request, for its correction's package.
export function openObligationsOf(db: Db, request: string): { check: string; criteria: string[]; generation: number }[] {
  return (db.prepare(`SELECT "key", "criteria", "generation" FROM "check_obligations" WHERE "request" = ? AND "resolved_at" IS NULL ORDER BY rowid`).all(request) as { key: string; criteria: string; generation: number }[]).map((o) => ({
    check: o.key,
    criteria: parseJson<string[]>(o.criteria) ?? [],
    generation: o.generation,
  }));
}

// A correction attempt that ended with nothing applied (Q13): its repair,
// then, at the limit, a park whose blocker names the open obligations.
export function correctionFailed(tx: Tx, item: WorkRow, cause: Record<string, unknown>): void {
  const policy = projectPolicy(tx.db, item.project);
  if (item.repair_attempts >= policy.repair_attempts_max!) parkWork(tx, item, 'repair_attempts_max', cause);
  else transitionWork(tx, item, 'eligible', { repair_due: 1 }, cause);
}

// The open obligations a specification change's correction item leaves, by
// check key: what its parked blocker names (Q13).
export function correctionOpenKeys(db: Db, workItem: string): string[] {
  const request = correctionRequestOf(db, workItem);
  if (request === null) return [];
  return uniq((db.prepare(`SELECT "key" FROM "check_obligations" WHERE "request" = ? AND "resolved_at" IS NULL ORDER BY "key"`).all(request) as { key: string }[]).map((o) => o.key));
}

// A check applied after a specification change's approval that covers a
// criterion the change touched, from a proposal captured before that
// approval (authored against the earlier specification), owes a
// `spec_changed` obligation at its application (the driver's ruling 2 on the
// M401 journey, slice 37): no check covering a changed criterion escapes the
// obligation by timing. The request's own correction is not such a check,
// and one already owed is not recorded twice. Its correction is asked for by
// the request's next correction generation. Returns how many were recorded.
export function lateObligations(tx: Tx, args: { project: string; proposal: string; version: string }): number {
  const captured = tx.db.prepare(`SELECT MIN("seq") AS s FROM "events" WHERE "type" = 'protected.proposed' AND json_extract("subject", '$.proposal') = ?`).get(args.proposal) as { s: number | null };
  if (captured.s === null) return 0;
  const own = tx.db
    .prepare(`SELECT json_extract(w."subject", '$.request') AS request FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" JOIN "work_items" w ON w."id" = r."work_item" WHERE p."id" = ? AND w."kind" = 'check_correction'`)
    .get(args.proposal) as { request: string | null } | undefined;
  const generation = (tx.db.prepare('SELECT "spec_evidence_generation" AS g FROM "projects" WHERE "id" = ?').get(args.project) as { g: number }).g;
  // Only the checks this proposal made or changed: a check the version
  // carries over unchanged from the one it superseded is not authored by it
  // (its obligation, if any, was the change's own and is resolved by its
  // correction).
  const previous = tx.db.prepare('SELECT "id" FROM "protected_versions" WHERE "superseded_by" = ? ORDER BY "seq" DESC LIMIT 1').get(args.version) as { id: string } | undefined;
  const before = new Map(
    previous ? (tx.db.prepare('SELECT "key", "definition_hash", "criteria" FROM "checks" WHERE "protected_version" = ?').all(previous.id) as { key: string; definition_hash: string; criteria: string | null }[]).map((c) => [c.key, `${c.definition_hash}|${c.criteria ?? ''}`]) : [],
  );
  const checks = (tx.db.prepare('SELECT "id", "key", "criteria", "definition_hash" FROM "checks" WHERE "protected_version" = ?').all(args.version) as { id: string; key: string; criteria: string | null; definition_hash: string }[]).filter(
    (c) => before.get(c.key) !== `${c.definition_hash}|${c.criteria ?? ''}`,
  );
  const requests = tx.db
    .prepare(
      `SELECT r."id", r."impact_value", (SELECT MIN(e."seq") FROM "events" e WHERE e."type" = 'spec.change_approved' AND json_extract(e."subject", '$.spec_change_request') = r."id") AS approved_seq
       FROM "spec_change_requests" r WHERE r."project" = ? AND r."status" = 'approved' ORDER BY r."seq"`,
    )
    .all(args.project) as { id: string; impact_value: string | null; approved_seq: number | null }[];
  // The owner's approval of this proposal, made after a change's approval,
  // is the owner's knowing act (the driver's ruling (A), slice 37): its
  // question named what the change touched (authoredAgainst), and no
  // obligation is raised for that change.
  const ownerApproved = (tx.db
    .prepare(
      `SELECT MAX(e."seq") AS s FROM "events" e JOIN "decisions" d ON d."id" = json_extract(e."subject", '$.decision')
       WHERE e."type" = 'decision.consumed' AND d."subject_type" = 'protected_proposal' AND d."subject_id" = ?
         AND json_extract(d."answer", '$.option') = 'approve' AND json_extract(d."answer", '$.actor') = 'human'`,
    )
    .get(args.proposal) as { s: number | null }).s;
  let n = 0;
  for (const r of requests) {
    if (r.approved_seq === null || r.approved_seq < captured.s || own?.request === r.id) continue;
    if (ownerApproved !== null && ownerApproved > r.approved_seq) continue;
    const impact = parseJson<{ affected_criteria?: string[]; added_criteria?: string[] }>(r.impact_value) ?? {};
    const touched = new Set([...(impact.affected_criteria ?? []), ...(impact.added_criteria ?? [])]);
    if (touched.size === 0) continue;
    const owed: string[] = [];
    for (const c of checks) {
      const covered = (parseJson<string[]>(c.criteria) ?? []).filter((x) => touched.has(x));
      if (covered.length === 0) continue;
      const open = tx.db.prepare(`SELECT 1 FROM "check_obligations" WHERE "project" = ? AND "key" = ? AND "reason" = 'spec_changed' AND "resolved_at" IS NULL`).get(args.project, c.key);
      if (open) continue;
      const id = tx.newId('obl_');
      tx.db
        .prepare(`INSERT INTO "check_obligations" ("id", "created_at", "project", "check", "key", "criteria", "generation", "reason", "request") VALUES (?, ?, ?, ?, ?, ?, ?, 'spec_changed', ?)`)
        .run(id, tx.at, args.project, c.id, c.key, JSON.stringify(covered), generation, r.id);
      tx.emit('check.obligation_recorded', { project: args.project, check_obligation: id }, { reason: 'spec_changed', criteria: covered, request: r.id, proposal: args.proposal, late: true });
      owed.push(c.key);
      n++;
    }
    if (owed.length > 0) {
      const g = (tx.db.prepare(`SELECT COALESCE(MAX("trigger_generation"), 0) AS g FROM "work_items" WHERE "project" = ? AND "trigger_source" = 'spec_obligation' AND "trigger_id" = ?`).get(args.project, r.id) as { g: number }).g;
      observeTrigger(
        tx,
        { project: args.project, kind: 'check_correction', trigger_source: 'spec_obligation', trigger_id: r.id, trigger_generation: g + 1, subject: { request: r.id }, trigger_evidence: { criteria: { affected: [...touched].sort(), uncovered: [], removed: [] }, checks: owed.sort(), generation }, chain: 0 },
        { spec_change_request: r.id, checks: owed },
      );
    }
  }
  return n;
}

// What a protected proposal captured before a specification change's
// approval was authored against (the driver's ruling (A), slice 37): the
// specification version current at its capture, and the criteria the
// changes approved since touched; null when no approved change came after
// it. Its question names this, so an owner who approves it does so knowingly.
export function authoredAgainst(db: Db, proposal: string): { version: number | null; touched: string[] } | null {
  const captured = db.prepare(`SELECT MIN("seq") AS s FROM "events" WHERE "type" = 'protected.proposed' AND json_extract("subject", '$.proposal') = ?`).get(proposal) as { s: number | null };
  if (captured.s === null) return null;
  const project = (db.prepare('SELECT "project" FROM "protected_proposals" WHERE "id" = ?').get(proposal) as { project: string } | undefined)?.project;
  if (!project) return null;
  const later = db
    .prepare(
      `SELECT r."impact_value" FROM "spec_change_requests" r WHERE r."project" = ? AND r."status" = 'approved'
         AND (SELECT MIN(e."seq") FROM "events" e WHERE e."type" = 'spec.change_approved' AND json_extract(e."subject", '$.spec_change_request') = r."id") > ?`,
    )
    .all(project, captured.s) as { impact_value: string | null }[];
  if (later.length === 0) return null;
  const touched = new Set<string>();
  for (const r of later) {
    const i = parseJson<{ affected_criteria?: string[]; added_criteria?: string[] }>(r.impact_value) ?? {};
    for (const c of [...(i.affected_criteria ?? []), ...(i.added_criteria ?? [])]) touched.add(c);
  }
  if (touched.size === 0) return null;
  const at = db
    .prepare(`SELECT json_extract("payload", '$.version') AS v FROM "events" WHERE "type" = 'baseline.spec_approved' AND json_extract("subject", '$.project') = ? AND "seq" < ? ORDER BY "seq" DESC LIMIT 1`)
    .get(project, captured.s) as { v: number | null } | undefined;
  return { version: at?.v ?? null, touched: [...touched].sort() };
}

// Executions of the checks a proposed change's impact lists (its owed and
// criterion-unknown checks, and the checks of its listed results) that are
// queued, materializing or running: the evidence still settling.
export function impactSettling(db: Db, request: string): number {
  const r = getRequest(db, request);
  if (!r) return 0;
  const impact = parseJson<Impact>(r.impact_value);
  if (!impact) return 0;
  const keys = new Set([...impact.checks.obligations, ...impact.checks.criterion_unknown].map((c) => c.key));
  for (const k of db.prepare(`SELECT DISTINCT k."key" FROM "check_results" x JOIN "checks" k ON k."id" = x."check" WHERE x."id" IN (SELECT value FROM json_each(?))`).all(JSON.stringify(impact.evidence.results)) as { key: string }[]) keys.add(k.key);
  if (keys.size === 0) return 0;
  return (db
    .prepare(`SELECT COUNT(*) AS n FROM "check_executions" WHERE "project" = ? AND "key" IN (SELECT value FROM json_each(?)) AND "status" IN ('queued', 'materializing', 'running')`)
    .get(r.project, JSON.stringify([...keys])) as { n: number }).n;
}

