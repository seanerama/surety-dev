// The gate function for the two gate kinds M1 computes, `stage` and
// `alpha_authorize` (D1 §9; RN R1, R7; build spec §3 and §6 corrections 4,
// 8, 9, 17, 18; Review B01, B02, B03; SEAM.md §§70-75). One evaluation is one
// transaction: the scope is built, every required check's state derived from
// recorded executions, every input read, the reasons computed, and the scope
// and the evaluation written with `gate.scope_built` and `gate.evaluated`.
// What a satisfied evaluation does follows in the same transaction: a stage's
// work completes; an Alpha authorization is issued; a finding a passing
// check verified is resolved, and the fix that names it completes; a tier's
// review is queued. Nothing here reads git: the ancestry the scope needs is
// recorded beforehand (evidence.ts), and the protected fingerprint of the
// integration branch's head is handed in.

import { assertEdge } from './lifecycle.js';
import { nowIso } from '../../clock.js';
import { Refusal } from '../../refusal.js';
import { canonical, notFound, parseJson, sha256 } from './common.js';
import {
  type CandidateRow,
  type CheckRow,
  TIER_RANK,
  checksOfVersion,
  contentHash,
  getCandidate,
  predecessors,
  requiredSet,
  requirementsOf,
} from './evidence.js';
import { unfinishedOperations } from './journal.js';
import { type VersionRow, effectiveVersion } from './protected.js';
import { discoveryErrorsOf, registerDue } from './checks.js';
import { movingRefs } from './accept.js';
import { type OobRow, blockingObservation, candidateObservation, nominationRef, recordObservation } from './repo.js';
import type { Tx } from './tx.js';
import { getWorkItem, observeTrigger, transitionWork } from './work.js';

type Db = Tx['db'];

export const COMPUTED_GATES = ['stage', 'alpha_authorize'] as const;
export const UNBUILT_GATES = ['phase', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete'] as const;
export type GateKind = (typeof COMPUTED_GATES)[number];

export type CheckState = 'missing' | 'stale' | 'skipped' | 'failed' | 'passed';
export interface Reason {
  code: string;
  subjects: string[];
}

interface ResultRow {
  id: string;
  check: string;
  candidate: string;
  source_revision: string;
  protected_version: string;
  runner_class: string;
  environment: string | null;
  artifact_digest: string | null;
  execution_seq: number;
  execution_established: number;
  signaled: number;
  deadline_hit: number;
  exit_status: number | null;
  output: string | null;
  invalidated_at: string | null;
  execution: string | null;
  not_run_reason: string | null;
  orphans: number | null;
}

export interface FindingRow {
  id: string;
  project: string;
  seq: number;
  scope: 'project' | 'lineage' | 'candidate';
  candidate: string | null;
  source_run: string | null;
  category: string;
  check: string | null;
  effective_severity: 'critical' | 'high' | 'medium' | 'low';
  severity_history: string;
  sensitive_area: string | null;
  status: 'open' | 'dispositioned' | 'resolved';
  disposition: 'fix' | 'defer' | 'accept' | null;
  disposition_authority: string | null;
  disposition_seq: number | null;
  linked_issue: string | null;
  defer_target: string | null;
  reevaluations: string;
  alpha_exception: string | null;
  resolution_verification: string | null;
  proposed_disposition: string | null;
  proposed_severity_change: string | null;
  proposed_alpha_exception?: string | null;
}

// ---- scope ---------------------------------------------------------------------

export interface Scope {
  candidate: CandidateRow;
  kind: GateKind;
  stage: string | null;
  tier: string;
  effective: VersionRow;
  delivered: string[];
  partial: string[];
  required: CheckRow[];
  uncovered: string[];
  environment: string | null;
  artifact: string | null;
  signoffs: { role: string; scope: string; module?: string }[];
  contentHash: string;
}

// The sign-offs a project's tier requires of a candidate (D1 §9; E36 item 3).
export function requiredSignoffs(db: Db, project: string, tier: string): Scope['signoffs'] {
  const signoffs: Scope['signoffs'] = [];
  if ((TIER_RANK[tier] ?? 0) >= 2) signoffs.push({ role: 'reviewer', scope: 'candidate' });
  if ((TIER_RANK[tier] ?? 0) >= 3) {
    const modules = db.prepare('SELECT "name" FROM "modules" WHERE "project" = ? ORDER BY "name"').all(project) as { name: string }[];
    for (const m of modules) signoffs.push({ role: 'reviewer', scope: 'module', module: m.name });
    signoffs.push({ role: 'reviewer', scope: 'security' });
  }
  return signoffs;
}

export function buildScope(db: Db, args: { project: string; candidate: CandidateRow; kind: GateKind; stage: string | null; environment: string | null; artifact: string | null }): Scope {
  const project = db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(args.project) as { tier: string } | undefined;
  if (!project) throw notFound('project', args.project);
  const effective = effectiveVersion(db, args.project);
  if (!effective) throw new Refusal(409, 'illegal_transition', `Project ${args.project} has no effective protected version.`, 'Nothing was evaluated.', { project: args.project });
  const { required, obligations, delivery, tier } = requiredSet(db, { project: args.project, candidate: args.candidate, kind: args.kind, stage: args.stage, version: effective.id });
  const uncovered = obligations.filter((r) => !required.some((c) => requirementsOf(c).includes(r)));
  const signoffs = requiredSignoffs(db, args.project, tier);
  return {
    candidate: args.candidate,
    kind: args.kind,
    stage: args.stage,
    tier,
    effective,
    delivered: delivery.delivered,
    partial: delivery.partial,
    required,
    uncovered,
    environment: args.environment,
    artifact: args.artifact,
    signoffs,
    contentHash: contentHash(db, args.project, args.candidate),
  };
}

// ---- check states (D1 §9.2; E8; SEAM.md §71) ------------------------------------------

interface Execution extends ResultRow {
  reused: boolean;
}

function executionsOf(db: Db, project: string, check: CheckRow, candidate: string): Execution[] {
  const own = db
    .prepare(`SELECT r.* FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND r."candidate" = ? AND c."key" = ?`)
    .all(project, candidate, check.key) as ResultRow[];
  // A reuse entry counts only if it is assessed and names a result of the
  // same check (correction 18; SEAM.md §73).
  const reused = db
    .prepare(
      `SELECT r.* FROM "evidence_reuse" e JOIN "check_results" r ON r."id" = e."check_result" JOIN "checks" c ON c."id" = r."check"
       WHERE e."project" = ? AND e."candidate" = ? AND e."assessed" = 1 AND e."check_result" IS NOT NULL AND c."key" = ?`,
    )
    .all(project, candidate, check.key) as ResultRow[];
  const seen = new Set(own.map((r) => r.id));
  return [...own.map((r) => ({ ...r, reused: false })), ...reused.filter((r) => !seen.has(r.id)).map((r) => ({ ...r, reused: true }))];
}

// A registration of the check at the scope's bindings (L7).
interface Registration {
  id: string;
  status: string;
  execution_seq: number;
  result: string | null;
}

// The gate read's history beside a deciding execution (N03; SEAM.md §191).
export interface History {
  count: number;
  executions: { execution: string; execution_seq: number; trigger: unknown; status: string; state: CheckState | null }[];
  link: string;
}

export interface StateOf {
  state: CheckState;
  decider: Execution | null;
  // The latest registration, when it has no usable result (L7).
  pending: { execution: string; status: string } | null;
  history: History | null;
}

// D1 §9.2 step 3, with L4, for one result row.
function resultState(r: Pick<ResultRow, 'execution_established' | 'signaled' | 'deadline_hit' | 'orphans' | 'exit_status'>): CheckState {
  if (r.execution_established === 0) return 'skipped';
  // L4: other processes alive at the check's own exit fail it too.
  if (r.signaled === 1 || r.deadline_hit === 1 || r.orphans !== 0 || r.exit_status === null || r.exit_status !== 0) return 'failed';
  return 'passed';
}

function registrationsOf(db: Db, check: CheckRow, scope: Pick<Scope, 'candidate' | 'effective' | 'environment' | 'artifact'>): Registration[] {
  const requires = JSON.parse(check.requires) as string[];
  const rows = db
    .prepare(
      `SELECT "id", "status", "execution_seq", "result", "environment", "artifact_digest" FROM "check_executions"
       WHERE "candidate" = ? AND "key" = ? AND "source_revision" = ? AND "protected_version" = ? AND "runner_class" = ? ORDER BY "execution_seq"`,
    )
    .all(scope.candidate.id, check.key, scope.candidate.revision, scope.effective.id, check.runner_class) as (Registration & { environment: string | null; artifact_digest: string | null })[];
  return rows.filter(
    (x) => (!requires.includes('environment') || x.environment === scope.environment) && (!requires.includes('artifact_digest') || x.artifact_digest === scope.artifact),
  );
}

// Every execution registered before the deciding one at its own bindings,
// failed attempts included, in sequence (N03). A later pass relabels none.
function historyOf(db: Db, project: string, decider: Execution): History | null {
  if (decider.execution === null) return null;
  const rows = db
    .prepare(
      `SELECT x."id", x."execution_seq", x."trigger", x."status", r."execution_established", r."signaled", r."deadline_hit", r."orphans", r."exit_status", r."id" AS "result_id"
       FROM "check_executions" x JOIN "check_executions" d ON d."id" = ?
       LEFT JOIN "check_results" r ON r."id" = x."result"
       WHERE x."project" = ? AND x."candidate" = d."candidate" AND x."key" = d."key" AND x."source_revision" = d."source_revision"
       AND x."protected_version" = d."protected_version" AND x."runner_class" = d."runner_class" AND x."execution_seq" < d."execution_seq"
       ORDER BY x."execution_seq"`,
    )
    .all(decider.execution, project) as (Pick<ResultRow, 'execution_established' | 'signaled' | 'deadline_hit' | 'orphans' | 'exit_status'> & {
    id: string;
    execution_seq: number;
    trigger: string;
    status: string;
    result_id: string | null;
  })[];
  return {
    count: rows.length,
    executions: rows.map((x) => ({
      execution: x.id,
      execution_seq: x.execution_seq,
      trigger: JSON.parse(x.trigger) as unknown,
      status: x.status,
      state: x.result_id === null ? null : resultState(x),
    })),
    link: `/v1/projects/${encodeURIComponent(project)}/candidates/${encodeURIComponent(decider.candidate)}/checks`,
  };
}

// Selection by registration (D1 §9.2 with L7, B03; SEAM.md §§71, 191). The
// registrations and the results at the scope's bindings are ordered by the
// project's one sequence, a registration and its result sharing a number;
// the latest decides, never a timestamp. A latest registration with no
// usable result leaves the check `missing`, naming it: no earlier pass or
// reuse entry is fallen back to, and nothing stands in for its result.
export function checkState(db: Db, project: string, check: CheckRow, scope: Pick<Scope, 'candidate' | 'effective' | 'environment' | 'artifact'>): StateOf {
  const all = executionsOf(db, project, check, scope.candidate.id);
  const registrations = registrationsOf(db, check, scope);
  const requires = JSON.parse(check.requires) as string[];
  const matching = all.filter(
    (r) =>
      r.invalidated_at === null &&
      (r.reused || r.source_revision === scope.candidate.revision) &&
      r.protected_version === scope.effective.id &&
      r.runner_class === check.runner_class &&
      (!requires.includes('environment') || r.environment === scope.environment) &&
      (!requires.includes('artifact_digest') || r.artifact_digest === scope.artifact),
  );
  const usable = new Set(matching.map((r) => r.id));
  type Item = { seq: number; result?: Execution; registration?: Registration };
  const items: Item[] = matching.map((r) => ({ seq: r.execution_seq, result: r }));
  for (const x of registrations) if (x.result === null || !usable.has(x.result)) items.push({ seq: x.execution_seq, registration: x });
  if (items.length === 0) return { state: all.length === 0 ? 'missing' : 'stale', decider: null, pending: null, history: null };
  const top = items.reduce((a, b) => (b.seq > a.seq ? b : a));
  if (top.registration !== undefined) {
    // Its result exists and was invalidated: what it established no longer holds.
    if (top.registration.status === 'recorded') return { state: 'stale', decider: null, pending: null, history: null };
    return { state: 'missing', decider: null, pending: { execution: top.registration.id, status: top.registration.status }, history: null };
  }
  const decider = top.result!;
  return { state: resultState(decider), decider, pending: null, history: historyOf(db, project, decider) };
}

// ---- findings (D1 §§9.3(5), 9.4; F §§6.1-6.3; E19; SEAM.md §74) --------------------

// Does a finding apply to a candidate? A project finding always; another on
// the candidate it was raised on and every successor along the lineage
// chain, unless an approved assessment excludes this candidate.
export function findingApplies(db: Db, f: FindingRow, candidate: CandidateRow): boolean {
  if (f.scope !== 'project') {
    if (f.candidate === null) return false;
    if (f.candidate !== candidate.id && !predecessors(db, candidate).includes(f.candidate)) return false;
  }
  const excluded = db
    .prepare(`SELECT 1 FROM "applicability_assessments" WHERE "finding" = ? AND "candidate" = ? AND "status" = 'approved' LIMIT 1`)
    .get(f.id, candidate.id);
  return excluded === undefined;
}

export const BLOCKING_SEVERITIES = ['critical', 'high'];

// Is the finding blocking at this gate kind? Critical always; High unless,
// at Alpha, its exception is recorded and it is in no sensitive area. An
// exception the human granted on a Reviewer's proposal is bound to a
// candidate and its acceptance content hash (D2 §5 C1): it counts only for
// that candidate while its content is that; given no candidate to judge by,
// it is taken as recorded.
export function blocks(
  f: Pick<FindingRow, 'effective_severity' | 'alpha_exception' | 'sensitive_area'>,
  kind: GateKind,
  at?: { candidate: string; contentHash: string },
): boolean {
  if (f.effective_severity === 'critical') return true;
  if (f.effective_severity !== 'high') return false;
  if (kind === 'alpha_authorize' && f.alpha_exception !== null && f.sensitive_area === null) {
    const bound = JSON.parse(f.alpha_exception) as { candidate?: unknown; acceptance_content_hash?: unknown };
    if (at === undefined || bound.candidate === undefined) return false;
    return !(bound.candidate === at.candidate && bound.acceptance_content_hash === at.contentHash);
  }
  return true;
}

// Which severities a deferral's authority covers (F §6.2; O3).
const DEFER_COVERS: Record<string, string[]> = { reviewer: ['low'], human: ['low', 'medium'] };

// ---- the evaluation ------------------------------------------------------------------

export interface EvaluateArgs {
  project: string;
  candidate: string;
  kind: string;
  stage?: unknown;
  authorization?: unknown;
  // The protected fingerprint of the integration branch's head, under the
  // effective roots, as the main thread read it; null if not read.
  headFingerprint?: string | null;
  head?: string | null;
  // What the main thread could not read (E41 item 2).
  unreadable?: { head?: boolean; ancestry?: boolean; records?: string[] } | undefined;
  // The gate's own reads of its registered refs (D3 §5 X1, A.2 RefRead):
  // absent when nothing was read, which is unread, never unchanged.
  refs?: RefFact[] | undefined;
}

export interface RefFact {
  ref: string;
  read: 'value' | 'absent' | 'unread';
  oid: string | null;
}

export interface EvaluationBody {
  id: string;
  gate_kind: GateKind;
  outcome: 'satisfied' | 'not_satisfied';
  reasons: Reason[];
  check_states: Record<string, CheckState>;
  checks: Record<string, CheckEntry>;
  scope: string;
  stale: boolean;
}

// The gate read's entry for one required check (SEAM.md §§183, 191).
export interface CheckEntry {
  key: string;
  state: CheckState;
  deciding: { execution: string | null; result: string; execution_seq: number } | null;
  not_run_reason: string | null;
  pending: { execution: string; status: string } | null;
  due: { trigger: unknown; at: string } | null;
  history: History | null;
}

function checkEntries(scope: Scope, selected: Record<string, StateOf>, due: CheckEntry['due']): Record<string, CheckEntry> {
  const out: Record<string, CheckEntry> = {};
  for (const c of scope.required) {
    const s = selected[c.id]!;
    const d = s.decider;
    out[c.id] = {
      key: c.key,
      state: s.state,
      deciding: d === null ? null : { execution: d.execution ?? null, result: d.id, execution_seq: d.execution_seq },
      not_run_reason: d?.not_run_reason ?? null,
      pending: s.pending,
      due,
      history: s.history,
    };
  }
  return out;
}

interface AuthorizationRow {
  id: string;
  project: string;
  candidate: string;
  environment: string;
  artifact_digest: string;
  status: string;
}

export function evaluationTarget(db: Db, args: EvaluateArgs): { candidate: CandidateRow; kind: GateKind; stage: string | null; authorization: AuthorizationRow | null } {
  if ((UNBUILT_GATES as readonly string[]).includes(args.kind) || !(COMPUTED_GATES as readonly string[]).includes(args.kind)) {
    throw new Refusal(501, 'unsupported', `The ${args.kind} gate is outside milestone M1 and is not evaluated by this engine.`, 'Nothing was evaluated. This gate kind needs a later design and milestone.', {
      gate_kind: args.kind,
    });
  }
  const kind = args.kind as GateKind;
  const candidate = getCandidate(db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  if (kind === 'stage') {
    if (typeof args.stage !== 'string') throw new Refusal(400, 'invalid_value', '"stage" must name a stage.', 'Send {"stage": "stage_<id>"}.', { field: 'stage' });
    const stage = db.prepare('SELECT "id", "project" FROM "stages" WHERE "id" = ?').get(args.stage) as { id: string; project: string } | undefined;
    if (!stage || stage.project !== args.project) throw notFound('stage', args.stage);
    return { candidate, kind, stage: stage.id, authorization: null };
  }
  if (typeof args.authorization !== 'string') {
    throw new Refusal(400, 'invalid_value', '"authorization" must name a proposed authorization of the candidate.', 'Send {"authorization": "dauth_<id>"}.', { field: 'authorization' });
  }
  const auth = db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(args.authorization) as AuthorizationRow | undefined;
  if (!auth || auth.candidate !== candidate.id) throw notFound('authorization', args.authorization);
  return { candidate, kind, stage: null, authorization: auth };
}

export function evaluateGate(tx: Tx, args: EvaluateArgs): { evaluation: EvaluationBody } {
  const db = tx.db;
  const target = evaluationTarget(db, args);
  // A registration owed to a trigger whose facts are now read is made first
  // (L2): the evaluation never consumes evidence older than it.
  registerDue(tx, { project: args.project });
  const { kind } = target;
  const candidate = getCandidate(db, target.candidate.id)!;
  const now = nowIso();
  const scope = buildScope(db, {
    project: args.project,
    candidate,
    kind,
    stage: target.stage,
    environment: target.authorization?.environment ?? null,
    artifact: target.authorization?.artifact_digest ?? null,
  });
  const reasons: Reason[] = [];
  const add = (code: string, subjects: string[]) => reasons.push({ code, subjects });

  // (0) The target (Q9 (a); SEAM.md §192): an evaluation of a superseded
  // candidate is made and recorded, and refused naming its successor. It
  // issues, completes and resolves nothing.
  const superseded = candidate.superseded_by ?? null;
  if (superseded !== null) add('CANDIDATE_SUPERSEDED', [superseded]);

  // An evaluation made without these facts (a request from inside the
  // store) cannot establish them: unknown, not a pass (E41 item 2).
  const unreadable = args.unreadable ?? { head: args.headFingerprint === undefined || args.headFingerprint === null, ancestry: false, records: [] };

  // (1) The scope is complete. Delivery whose ancestry git could not tell
  // is not known, so the scope is not complete.
  // While the effective version has discovery errors every gate names them
  // (D3 §1.4; SEAM.md §178).
  const discoveryPaths = [...new Set(discoveryErrorsOf(db, scope.effective.id).map((e) => e.path))];
  if (scope.required.length === 0 || scope.uncovered.length > 0 || unreadable.ancestry === true || discoveryPaths.length > 0) {
    add('ACCEPTANCE_SCOPE_INCOMPLETE', [...scope.uncovered, ...discoveryPaths]);
  }

  // (2) The protected path is authorized and effective. A protected set
  // that could not be read is not shown authorized.
  const pending = unfinishedOperations(db, args.project);
  if (pending.length === 0 && unreadable.head === true) add('PROTECTED_PATH_UNAUTHORIZED', [scope.effective.id]);
  if (pending.length === 0 && typeof args.headFingerprint === 'string' && args.headFingerprint !== scope.effective.fingerprint) {
    add('PROTECTED_PATH_UNAUTHORIZED', [scope.effective.id]);
    const seen = (db.prepare(`SELECT "payload" FROM "events" WHERE "type" = 'protected.unauthorized_detected' AND json_extract("subject", '$.project') = ?`).all(args.project) as { payload: string }[]).some(
      (e) => (JSON.parse(e.payload) as { fingerprint?: string }).fingerprint === args.headFingerprint,
    );
    if (!seen) {
      tx.emit('protected.unauthorized_detected', { project: args.project, candidate: candidate.id }, { fingerprint: args.headFingerprint, head: args.head ?? null, effective: scope.effective.id });
    }
  }

  // (3) No out-of-band change and no pending journal operation: of the
  // integration branch or the repository, for every gate of the project; of
  // the candidate's own nomination ref, for that candidate's gates (row M24).
  const observations = [blockingObservation(db, args.project), candidateObservation(db, args.project, candidate.seq)].filter((o): o is OobRow => o !== undefined);
  if (observations.length > 0) add('OUT_OF_BAND_CHANGE', observations.map((o) => o.id));
  // A ref the evaluation could not read (N02): refused, naming it, and
  // never recorded as a change. A changed or deleted one was recorded
  // before this transaction (gates/prepare.ts) and is an observation above.
  const unreadRefs =
    args.refs === undefined
      ? [`refs/heads/${(db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(args.project) as { integration_branch: string }).integration_branch}`, nominationRef(candidate.seq)]
      : args.refs.filter((r) => r.read === 'unread').map((r) => r.ref);
  if (unreadRefs.length > 0) add('REF_UNREAD', unreadRefs);
  if (pending.length > 0) add('GIT_JOURNAL_PENDING', pending.map((op) => op.id));

  // (4) Every required check passed.
  const states: Record<string, CheckState> = {};
  const deciders: Record<string, Execution | null> = {};
  const selected: Record<string, StateOf> = {};
  // A registration the candidate is owed (L2): its checks are missing.
  const due = (db.prepare('SELECT "checks_due" FROM "candidates" WHERE "id" = ?').get(candidate.id) as { checks_due: string | null }).checks_due;
  const dueMark = due === null ? null : (JSON.parse(due) as { trigger: unknown; at: string }[])[0] ?? null;
  for (const c of scope.required) {
    const s: StateOf = dueMark !== null ? { state: 'missing', decider: null, pending: null, history: null } : checkState(db, args.project, c, scope);
    selected[c.id] = s;
    states[c.id] = s.state;
    deciders[c.id] = s.decider;
  }
  const entries = checkEntries(scope, selected, dueMark === null ? null : { trigger: dueMark.trigger, at: dueMark.at });
  const notPassed = scope.required.filter((c) => states[c.id] !== 'passed').map((c) => c.id);
  if (notPassed.length > 0) add('CHECK_NOT_PASSED', notPassed);

  // (5) Findings.
  const findings = (db.prepare(`SELECT * FROM "findings" WHERE "project" = ? AND "status" IN ('open', 'dispositioned') ORDER BY "seq"`).all(args.project) as FindingRow[]).filter((f) =>
    findingApplies(db, f, candidate),
  );
  const blocking: string[] = [];
  const unsatisfied: string[] = [];
  const expired: string[] = [];
  const reevaluated: FindingRow[] = [];
  const resolving: { finding: FindingRow; result: string }[] = [];
  for (const f of findings) {
    // A fix whose named check passes here, by an execution recorded after
    // the disposition, is resolved by this evaluation (SEAM.md §74).
    if (f.disposition === 'fix' && f.check !== null && superseded === null) {
      const named = checksOfVersion(db, scope.effective.id).find((c) => c.key === f.check);
      if (named) {
        const s = checkState(db, args.project, named, scope);
        if (s.state === 'passed' && s.decider && s.decider.execution_seq > (f.disposition_seq ?? 0)) {
          resolving.push({ finding: f, result: s.decider.id });
          continue;
        }
      }
    }
    if (blocks(f, kind, { candidate: candidate.id, contentHash: scope.contentHash })) {
      blocking.push(f.id);
      continue;
    }
    if (f.disposition === 'accept' && f.disposition_authority === 'human') continue;
    if (f.disposition === 'defer' && f.linked_issue && f.defer_target && (DEFER_COVERS[f.disposition_authority ?? ''] ?? []).includes(f.effective_severity)) {
      if (Date.parse(f.defer_target) > Date.parse(now)) {
        reevaluated.push(f);
        continue;
      }
      expired.push(f.id);
      continue;
    }
    unsatisfied.push(f.id);
  }
  if (blocking.length > 0) add('FINDING_BLOCKING', blocking);
  if (unsatisfied.length > 0) add('FINDING_UNSATISFIED', unsatisfied);
  if (expired.length > 0) add('FINDING_DEFER_EXPIRED', expired);

  // (6) Sign-offs the tier requires, bound to the acceptance content.
  const signoffs = db.prepare('SELECT * FROM "signoffs" WHERE "candidate" = ? AND "acceptance_content_hash" = ?').all(candidate.id, scope.contentHash) as {
    id: string;
    role: string;
    scope: string;
    module: string | null;
  }[];
  const missing = scope.signoffs.filter((need) => !signoffs.some((s) => s.role === need.role && s.scope === need.scope && (need.module === undefined || s.module === need.module)));
  if (missing.length > 0) add('SIGNOFF_MISSING', [candidate.id]);

  // (8) Referenced evidence exists and verifies.
  const evidence: string[] = [];
  for (const c of scope.required) {
    const record = deciders[c.id]?.output;
    if (!record) continue;
    const row = db.prepare('SELECT "path", "post_scan", "missing_at", "published" FROM "records" WHERE "id" = ?').get(record) as
      | { path: string | null; post_scan: string; missing_at: string | null; published: number }
      | undefined;
    if (!row || row.published !== 1 || row.path === null || row.missing_at !== null || row.post_scan === 'hit' || (unreadable.records ?? []).includes(record)) evidence.push(record);
  }
  if (evidence.length > 0) add('EVIDENCE_MISSING', evidence);

  const outcome = reasons.length === 0 ? 'satisfied' : 'not_satisfied';
  const scopeId = tx.newId('scope_');
  const required = scope.required.map((c) => c.id);
  const scopeBody = {
    candidate: candidate.id,
    gate_kind: kind,
    stage: scope.stage,
    effective_protected_version: scope.effective.id,
    source_revision: candidate.revision,
    delivered: scope.delivered,
    partial: scope.partial,
    required,
    environment: scope.environment,
    artifact: scope.artifact,
  };
  const policy = db.prepare('SELECT "policy_revision" FROM "projects" WHERE "id" = ?').get(args.project) as { policy_revision: string | null };
  tx.db
    .prepare(
      `INSERT INTO "acceptance_scopes" ("id", "created_at", "project", "candidate", "gate_kind", "stage", "policy_revision", "effective_protected_version", "source_revision",
         "delivered_requirement_ids", "partial_requirement_ids", "sensitivity_categories", "required_check_ids", "runner_classes", "required_signoffs",
         "environment", "artifact_digest", "evidence_reuse", "validated", "scope_hash", "acceptance_content_hash")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scopeId,
      tx.at,
      args.project,
      candidate.id,
      kind,
      scope.stage,
      policy.policy_revision,
      scope.effective.id,
      candidate.revision,
      JSON.stringify(scope.delivered),
      JSON.stringify(scope.partial),
      JSON.stringify(required),
      JSON.stringify(Object.fromEntries(scope.required.map((c) => [c.id, c.runner_class]))),
      JSON.stringify(scope.signoffs),
      scope.environment,
      scope.artifact,
      JSON.stringify(Object.values(deciders).filter((d): d is Execution => d !== null && d.reused).map((d) => ({ check_result: d.id, applicability: null }))),
      scope.required.length > 0 && scope.uncovered.length === 0 ? 1 : 0,
      sha256(canonical(scopeBody)),
      scope.contentHash,
    );
  tx.emit('gate.scope_built', { project: args.project, candidate: candidate.id, scope: scopeId }, { gate_kind: kind, stage: scope.stage, required, delivered: scope.delivered });

  const id = tx.newId('gate_');
  const snapshot = {
    results: Object.fromEntries(Object.entries(deciders).map(([c, d]) => [c, d?.id ?? null])),
    findings: findings.map((f) => f.id),
    signoffs: signoffs.map((s) => s.id),
    head_fingerprint: args.headFingerprint ?? null,
  };
  tx.db
    .prepare(
      `INSERT INTO "gate_evaluations" ("id", "created_at", "project", "scope", "candidate", "gate_kind", "computed_at", "inputs_hash", "inputs_snapshot", "check_states",
         "outcome", "reasons", "satisfiers", "stale", "stage", "authorization", "checks")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      scopeId,
      candidate.id,
      kind,
      tx.at,
      sha256(canonical(snapshot)),
      JSON.stringify(snapshot),
      JSON.stringify(states),
      outcome,
      JSON.stringify(reasons),
      scope.stage,
      target.authorization?.id ?? null,
      JSON.stringify(entries),
    );

  // What the evaluation itself records about the findings it read.
  for (const f of reevaluated) {
    const list = JSON.parse(f.reevaluations) as unknown[];
    list.push({ evaluation: id, effective_severity: f.effective_severity, at: tx.at });
    tx.db.prepare('UPDATE "findings" SET "reevaluations" = ? WHERE "id" = ?').run(JSON.stringify(list), f.id);
  }
  for (const { finding: f, result } of resolving) {
    tx.db
      .prepare(`UPDATE "findings" SET "status" = 'resolved', "resolution_verification" = ? WHERE "id" = ?`)
      .run(JSON.stringify({ evaluation: id, check_result: result }), f.id);
    tx.emit('finding.resolved', { project: args.project, finding: f.id }, { evaluation: id, check_result: result });
    // A fix's work completes with its finding's resolution (E36 item 4).
    const fixes = db
      .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'fix' AND json_extract("subject", '$.finding') = ? AND "status" = 'verifying'`)
      .all(args.project, f.id) as { id: string }[];
    for (const w of fixes) transitionWork(tx, getWorkItem(tx, w.id)!, 'complete', {}, { evaluation: id, finding: f.id });
  }

  if (outcome === 'satisfied' && kind === 'stage') completeStageWork(tx, candidate, scope.stage!, id);
  if (outcome === 'satisfied' && kind === 'alpha_authorize') issueAuthorization(tx, target.authorization!, id);
  if (kind === 'stage' && superseded === null) queueReview(tx, candidate, scope, states);

  tx.emit('gate.evaluated', { project: args.project, candidate: candidate.id, evaluation: id, scope: scopeId }, { gate_kind: kind, outcome, reasons: reasons.map((r) => r.code) });
  return { evaluation: { id, gate_kind: kind, outcome, reasons, check_states: states, checks: entries, scope: scopeId, stale: false } };
}

// The work a candidate holds by ancestry (E43): what it holds itself and what
// every candidate before it on its lineage chain holds. After a fix, the
// stage's work its first candidate held is held by the fix's candidate too.
export function heldByAncestry(db: Db, candidate: CandidateRow): string[] {
  const held = JSON.parse(candidate.held_work) as string[];
  for (const id of predecessors(db, candidate)) {
    const prior = getCandidate(db, id);
    if (prior) held.push(...(JSON.parse(prior.held_work) as string[]));
  }
  return [...new Set(held)];
}

// A satisfied stage gate completes its stage's work, held by the candidate
// by ancestry (SEAM.md §70; E43).
function completeStageWork(tx: Tx, candidate: CandidateRow, stage: string, evaluation: string): void {
  const held = heldByAncestry(tx.db, candidate);
  const row = tx.db.prepare('SELECT "work_item" FROM "stages" WHERE "id" = ?').get(stage) as { work_item: string | null } | undefined;
  if (!row?.work_item || !held.includes(row.work_item)) return;
  const item = getWorkItem(tx, row.work_item);
  if (!item || item.status !== 'verifying' || item.kind !== 'stage_build') return;
  transitionWork(tx, item, 'complete', {}, { candidate: candidate.id, evaluation });
}

// The candidate's verification work: the item its nomination registered.
export function verificationOf(db: Db, candidate: string): { id: string; status: string; chain: number } | undefined {
  return db
    .prepare(`SELECT "id", "status", "chain" FROM "work_items" WHERE "kind" = 'verification' AND "trigger_source" = 'nomination' AND "trigger_id" = ? AND "trigger_generation" = 1`)
    .get(candidate) as { id: string; status: string; chain: number } | undefined;
}

// The engine queues the review a tier requires (E36 item 3; E38; SEAM.md
// §70): at T2 and T3, once the candidate's verification work is complete and
// every check its stage scope requires has passed. One per candidate; it is
// chained work, created on the outcome of the Verifier's run.
function queueReview(tx: Tx, candidate: CandidateRow, scope: Scope, states: Record<string, CheckState>): void {
  if (TIER_RANK[scope.tier]! < 2) return;
  if (scope.required.length === 0 || scope.required.some((c) => states[c.id] !== 'passed')) return;
  const verification = verificationOf(tx.db, candidate.id);
  if (!verification || verification.status !== 'complete') return;
  const run = tx.db.prepare(`SELECT "chain" FROM "runs" WHERE "work_item" = ? AND "outcome" = 'completed' ORDER BY "seq" DESC LIMIT 1`).get(verification.id) as { chain: number } | undefined;
  observeTrigger(
    tx,
    { project: candidate.project, kind: 'review', trigger_source: 'verification', trigger_id: candidate.id, trigger_generation: 1, subject: { candidate: candidate.id }, chain: run?.chain ?? verification.chain + 1 },
    {},
  );
}

// A satisfied `alpha_authorize` evaluation issues the one proposed
// authorization it was made for (RN R1; correction 4; SEAM.md §75). An
// earlier issued authorization of the candidate for the environment is
// superseded.
function issueAuthorization(tx: Tx, auth: AuthorizationRow, evaluation: string): void {
  if (auth.status !== 'proposed') return;
  const earlier = tx.db
    .prepare(`SELECT "id" FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? AND "status" = 'issued' AND "id" <> ?`)
    .all(auth.candidate, auth.environment, auth.id) as { id: string }[];
  for (const e of earlier) {
    assertEdge('AuthorizationStatus', 'issued', 'superseded', { authorization: e.id });
    tx.db.prepare(`UPDATE "deployment_authorizations" SET "status" = 'superseded' WHERE "id" = ?`).run(e.id);
    tx.emit('authorization.superseded', { project: auth.project, candidate: auth.candidate, authorization: e.id }, { by: auth.id });
  }
  assertEdge('AuthorizationStatus', auth.status, 'issued', { authorization: auth.id });
  tx.db.prepare(`UPDATE "deployment_authorizations" SET "status" = 'issued', "evaluation" = ? WHERE "id" = ?`).run(evaluation, auth.id);
  tx.emit('authorization.issued', { project: auth.project, candidate: auth.candidate, authorization: auth.id }, { evaluation, environment: auth.environment });
}

// ---- authorizations ------------------------------------------------------------------

// POST /v1/projects/:p/candidates/:c/authorizations (SEAM.md §75): the
// prospective authorization, recorded proposed with its exact binding. The
// same binding again is the same row.
export function proposeAuthorization(tx: Tx, args: { project: string; candidate: string; body: unknown }): { status: number; body: unknown } {
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const b = args.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new Refusal(400, 'invalid_value', 'The body must be a JSON object.', 'Send the binding.', { field: null });
  const body = b as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['environment', 'artifact_digest', 'config_identity', 'target_set'].includes(key)) {
      throw new Refusal(400, 'unknown_field', `"${key}" is not a field of an authorization.`, 'Send environment, artifact_digest, config_identity and target_set.', { field: key });
    }
  }
  for (const field of ['environment', 'artifact_digest', 'config_identity']) {
    if (typeof body[field] !== 'string' || (body[field] as string).length === 0) throw new Refusal(400, 'invalid_value', `"${field}" must be a non-empty string.`, 'Correct the binding.', { field });
  }
  const targets = body.target_set;
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((t) => typeof t !== 'string')) {
    throw new Refusal(400, 'invalid_value', '"target_set" must be a non-empty array of targets.', 'Correct the binding.', { field: 'target_set' });
  }
  const env = tx.db.prepare('SELECT "id", "project" FROM "environments" WHERE "id" = ?').get(body.environment) as { id: string; project: string } | undefined;
  if (!env || env.project !== args.project) throw notFound('environment', body.environment as string);
  const binding = { environment: env.id, artifact_digest: body.artifact_digest, config_identity: body.config_identity, target_set: [...(targets as string[])].sort() };
  const hash = sha256(canonical(binding));
  const existing = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "binding_hash" = ?').get(candidate.id, hash) as
    | { id: string; status: string; generation: number }
    | undefined;
  if (existing) return { status: 200, body: { authorization: { id: existing.id, status: existing.status, generation: existing.generation } } };
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) throw new Refusal(409, 'illegal_transition', 'The project has no effective protected version.', 'Nothing was recorded.', { project: args.project });
  const { n } = tx.db.prepare('SELECT COUNT(*) + 1 AS n FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ?').get(candidate.id, env.id) as { n: number };
  const policy = tx.db.prepare('SELECT "policy_revision" FROM "projects" WHERE "id" = ?').get(args.project) as { policy_revision: string | null };
  const id = tx.newId('dauth_');
  tx.db
    .prepare(
      `INSERT INTO "deployment_authorizations" ("id", "created_at", "project", "candidate", "environment", "artifact_digest", "source_delivery_mapping", "config_identity",
         "target_set", "policy_revision", "protected_version", "evaluation", "status", "generation", "binding_hash")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'proposed', ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      candidate.id,
      env.id,
      body.artifact_digest,
      JSON.stringify({ dev_revision: candidate.revision, delivery_commit: null, artifact_digest: body.artifact_digest }),
      body.config_identity,
      JSON.stringify(targets),
      policy.policy_revision,
      effective.id,
      n,
      hash,
    );
  return { status: 201, body: { authorization: { id, status: 'proposed', generation: n } } };
}

// ---- what the engine evaluates by itself ------------------------------------------------

// The stage gates the engine evaluates at a tick (SEAM.md §70): of every
// candidate whose verification work is complete, each stage whose work the
// candidate holds by ancestry (E43) and is still verifying, when it has no
// evaluation yet or its latest is stale.
export function dueStageGates(db: Db, args: { project: string }): { candidate: string; stage: string }[] {
  const out: { candidate: string; stage: string }[] = [];
  const candidates = db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(args.project) as CandidateRow[];
  for (const c of candidates) {
    const v = verificationOf(db, c.id);
    if (!v || v.status !== 'complete') continue;
    for (const w of heldByAncestry(db, c)) {
      const item = db.prepare('SELECT "kind", "status", "subject" FROM "work_items" WHERE "id" = ?').get(w) as { kind: string; status: string; subject: string } | undefined;
      if (!item || item.kind !== 'stage_build' || item.status !== 'verifying') continue;
      const stage = parseJson<{ stage?: string }>(item.subject)?.stage;
      if (!stage) continue;
      const latest = db
        .prepare(`SELECT "stale" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'stage' AND "stage" = ? ORDER BY "created_at" DESC, "id" DESC LIMIT 1`)
        .get(c.id, stage) as { stale: number } | undefined;
      if (!latest || latest.stale === 1) out.push({ candidate: c.id, stage });
    }
  }
  return out;
}

// What the main thread reads before an evaluation (gates/prepare.ts): the
// repository and the commit the integration branch is at, the effective
// roots, and the records the candidate's executions name.
export function gateFactsRead(db: Db, args: { project: string; candidate: string }) {
  const p = db.prepare('SELECT "dev_repo_path", "integration_branch" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string; integration_branch: string } | undefined;
  if (!p) throw notFound('project', args.project);
  const head = db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(args.project, `refs/heads/${p.integration_branch}`) as
    | { expected_oid: string }
    | undefined;
  const effective = effectiveVersion(db, args.project);
  const records = db
    .prepare(
      `SELECT DISTINCT rec."id", rec."path", rec."sha256", rec."bytes", rec."missing_at" FROM "records" rec
       WHERE rec."published" = 1 AND rec."id" IN (
         SELECT r."output" FROM "check_results" r WHERE r."candidate" = ? AND r."output" IS NOT NULL
         UNION SELECT r."output" FROM "evidence_reuse" e JOIN "check_results" r ON r."id" = e."check_result" WHERE e."candidate" = ? AND r."output" IS NOT NULL)`,
    )
    .all(args.candidate, args.candidate) as { id: string; path: string | null; sha256: string | null; bytes: number | null; missing_at: string | null }[];
  return { repo: p.dev_repo_path, head: head?.expected_oid ?? null, roots: effective ? (JSON.parse(effective.roots) as string[]) : null, records };
}

// ---- the gate's own ref reads (D3 §5 X1; Q4, N02; SEAM.md §193) -------------------------

// One registered ref the evaluation reads, and the registry's generation of
// it: the value it expects and the values an unfinished journaled ref update
// of the engine's own is moving it to.
export interface RegisteredRef {
  registry: string;
  ref: string;
  expected: string;
  moving: string[];
}

// The integration branch's ref and the candidate's nomination ref, where
// registered, as the registry has them now.
export function gateRefRegistry(db: Db, args: { project: string; candidate: string }): RegisteredRef[] {
  const p = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(args.project) as { integration_branch: string } | undefined;
  if (!p) throw notFound('project', args.project);
  const c = getCandidate(db, args.candidate);
  const names = [`refs/heads/${p.integration_branch}`, ...(c && c.project === args.project ? [nominationRef(c.seq)] : [])];
  const moving = movingRefs(db, args.project);
  const out: RegisteredRef[] = [];
  for (const ref of names) {
    const row = db.prepare('SELECT "id", "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(args.project, ref) as { id: string; expected_oid: string } | undefined;
    if (row) out.push({ registry: row.id, ref, expected: row.expected_oid, moving: moving[ref] ?? [] });
  }
  return out;
}

// What an evaluation's reads found changed, recorded before its transaction
// as an integrity observation (D1 §7.6; SEAM.md §32). Reconciled against the
// registry as it is now: if its expected value has moved since the read, or
// what was found is now the engine's own journaled write, nothing is
// recorded (the next read tells). Recorded once (recordObservation).
export function observeGateRefs(tx: Tx, args: { project: string; changes: { registry: string; expected: string; found: string | null }[] }): { observed: number } {
  let observed = 0;
  const moving = movingRefs(tx.db, args.project);
  for (const c of args.changes) {
    const row = tx.db.prepare('SELECT "ref", "expected_oid" FROM "ref_registry" WHERE "id" = ? AND "project" = ?').get(c.registry, args.project) as { ref: string; expected_oid: string } | undefined;
    if (!row || row.expected_oid !== c.expected || c.found === row.expected_oid) continue;
    if (c.found !== null && (moving[row.ref] ?? []).includes(c.found)) continue;
    recordObservation(tx, args.project, { subject: 'ref', ref: c.registry, expected: c.expected, found: c.found });
    observed++;
  }
  return { observed };
}
