// Repair and findings (M3 slice 21; D3 §2.10, §2.11, §5 X2; Q2 (a) with
// T13's conditions; F2 (c); Q8 (a); E89 item 2; SEAM.md §§228 to 232).
//
// - The repair a failed check takes: a `stage_build` or `fix` in
//   `verifying` whose repair check has failed at its current candidate is
//   sent back to its Builder once per candidate and work generation, in the
//   transaction that reconciles it (one that records a result, ends an
//   execution, moves the item into `verifying`, ends its run, or the tick's
//   own step). The engine reconciles durable state, never a result's
//   arrival, so a restart or a repeated tick takes no second repair.
// - The conflict route (D3 §5 X2): a Builder's objection, or a Verifier's or
//   Reviewer's conflict finding about the item's candidate, wins over that
//   repair: the item awaits the person's answer, `correct_check`,
//   `change_spec`, `retry` or `cancel`. No answer changes a check state, a
//   check or the spec.
// - What can verify a finding (D3 §2.11): its named check, a required
//   acceptance-origin check covering its criterion. A `fix` disposition of a
//   finding no such check can verify routes `check_correction` work to the
//   Verifier, triggered by the finding (Q8 (a)).
//
// Not built here, by design (slice 21, approved):
// - the X2 blocker from `executing` or `integrating` (D3 A.5 lists those
//   edges; the route is taken where the repair it replaces would be, from
//   `verifying` only);
// - any process for `spec_change` work (D1's kind for F §3.8): the item is
//   created and waits, never dispatched;
// - objections from any role but the Builder (a Verifier reports a conflict
//   as a finding);
// - re-arming a hold after a spec change: see `heldByAnswer`.

import { requirementKeyOf } from '../../checks/schema.js';
import { canonical, parseJson, sha256 } from './common.js';
import type { Effect } from './control.js';
import { type CandidateRow, type CheckRow, checksOfVersion, requiredSet, requirementsOf } from './evidence.js';
import { type FindingRow, checkState } from './gates.js';
import { type VersionRow, effectiveVersion } from './protected.js';
import { knownCriteria, readDue } from './checks.js';
import { raiseFinding } from './findings.js';
import { raiseQuestion } from './queue.js';
import { projectPolicy } from './settings.js';
import type { Tx } from './tx.js';
import { type WorkRow, getWorkItem, observeTrigger, transitionWork } from './work.js';

type Db = Tx['db'];

export const CONFLICT_CATEGORIES: readonly string[] = ['requirement_conflict', 'contract_conflict'];
export const X2_OPTIONS = ['correct_check', 'change_spec', 'retry', 'cancel'] as const;
const REPAIRABLE: readonly string[] = ['stage_build', 'fix'];

// work_items.check_repair (D3 A.3).
interface CheckRepair {
  candidate: string;
  generation: number;
  at: string;
}

// work_items.check_conflict (engine-owned): every conflict finding a blocker
// was raised for (answered or open), where the latest was raised, and the
// person's answer to it once given.
interface CheckConflict {
  findings: string[];
  candidate: string;
  version: string;
  answer: (typeof X2_OPTIONS)[number] | null;
  at: string;
}

// ---- the current candidate and its repair checks -----------------------------------

// The candidate nominated from the item's latest integration (D3 §2.10): the
// latest candidate whose own held work lists the item. Work a candidate
// holds only by ancestry (E43) is not its current work.
export function currentCandidate(db: Db, item: Pick<WorkRow, 'id' | 'project'>): (CandidateRow & { checks_due: string | null }) | null {
  const row = db
    .prepare(`SELECT c.* FROM "candidates" c, json_each(c."held_work") h WHERE c."project" = ? AND h."value" = ? ORDER BY c."seq" DESC LIMIT 1`)
    .get(item.project, item.id) as (CandidateRow & { checks_due: string | null }) | undefined;
  return row ?? null;
}

// The item's repair checks at the candidate under the version: for a fix,
// the check its finding names; for a stage_build, the required checks of
// its stage's `stage` scope (one scope rule, checks/scope.ts).
function repairChecks(db: Db, item: WorkRow, candidate: CandidateRow, version: VersionRow): CheckRow[] {
  const subject = parseJson<{ stage?: string; finding?: string }>(item.subject) ?? {};
  if (item.kind === 'stage_build') {
    if (!subject.stage) return [];
    return requiredSet(db, { project: item.project, candidate, kind: 'stage', stage: subject.stage, version: version.id }).required;
  }
  if (!subject.finding) return [];
  const f = db.prepare('SELECT "check" FROM "findings" WHERE "id" = ? AND "project" = ?').get(subject.finding, item.project) as { check: string | null } | undefined;
  if (!f?.check) return [];
  return checksOfVersion(db, version.id).filter((c) => c.key === f.check);
}

export interface FailedCheck {
  check: CheckRow;
  result: { id: string; output: string | null; exit_status: number | null; signaled: number; deadline_hit: number };
}

interface RepairView {
  candidate: CandidateRow;
  version: VersionRow;
  failed: FailedCheck[];
}

// Which of the item's repair checks are `failed` at its current candidate
// (D1 §9.2 with L7: the latest registration decides). null when there is no
// current candidate, it is superseded (its results trigger nothing, D3
// §2.5), or no version is effective. A candidate owed a registration has
// every check missing, so none failed.
function repairView(db: Db, item: WorkRow): RepairView | null {
  if (!REPAIRABLE.includes(item.kind)) return null;
  const candidate = currentCandidate(db, item);
  if (!candidate || (candidate.superseded_by ?? null) !== null) return null;
  const version = effectiveVersion(db, item.project);
  if (!version) return null;
  if (readDue(candidate.checks_due) !== null) return { candidate, version, failed: [] };
  const failed: FailedCheck[] = [];
  for (const check of repairChecks(db, item, candidate, version)) {
    const s = checkState(db, item.project, check, { candidate, effective: version, environment: null, artifact: null });
    if (s.state !== 'failed' || !s.decider) continue;
    const d = s.decider;
    failed.push({ check, result: { id: d.id, output: d.output, exit_status: d.exit_status, signaled: d.signaled, deadline_hit: d.deadline_hit } });
  }
  failed.sort((a, b) => a.check.key.localeCompare(b.check.key));
  return { candidate, version, failed };
}

// What a run of the item is told of its failed repair checks when it is
// dispatched (D3 §2.10; D2 §1.3; SEAM.md §229): every repair check failed at
// its current candidate now, with the deciding result and its output
// record. undefined for kinds that take no check repair.
export function checkOutputsFor(db: Db, item: WorkRow): { key: string; check: string; check_result: string; output: string | null }[] | undefined {
  if (!REPAIRABLE.includes(item.kind)) return undefined;
  const view = repairView(db, item);
  return (view?.failed ?? []).map((f) => ({ key: f.check.key, check: f.check.id, check_result: f.result.id, output: f.result.output }));
}

// ---- the progress key (D1 §4.3; D3 §2.10) ------------------------------------------

// The candidate's tree, from the engine's own commit of its revision; null
// when the engine did not record one (a revision it did not commit).
function candidateTree(db: Db, candidate: CandidateRow): string | null {
  const row = db
    .prepare(`SELECT json_extract("finalizer_inputs", '$.tree') AS "tree" FROM "operations" WHERE "project" = ? AND "kind" = 'git_commit' AND json_extract("finalizer_inputs", '$.sha') = ? LIMIT 1`)
    .get(candidate.project, candidate.revision) as { tree: string | null } | undefined;
  return typeof row?.tree === 'string' ? row.tree : null;
}

// The progress key of a failed check repair: the candidate's tree and, for
// each failed repair check, (check, key, exit_status, signaled,
// deadline_hit). An unknown tree gives null: it never equals a stored key,
// so no_progress_max does not count it (unknown is not "the same"); the loop
// stays bounded by repair_attempts_max.
function progressKey(db: Db, view: RepairView): string | null {
  const tree = candidateTree(db, view.candidate);
  if (tree === null) return null;
  return sha256(
    canonical({
      tree,
      checks: view.failed.map((f) => ['check', f.check.key, f.result.exit_status, f.result.signaled === 1, f.result.deadline_hit === 1]),
    }),
  );
}

// ---- the reconciliation ------------------------------------------------------------

const hasUnendedRun = (db: Db, item: string): boolean => db.prepare(`SELECT 1 FROM "runs" WHERE "work_item" = ? AND "state" <> 'ended' LIMIT 1`).get(item) !== undefined;

// Every stage_build and fix of the project in `verifying`, reconciled.
export function reconcileRepairs(tx: Tx, project: string): void {
  const items = tx.db
    .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "status" = 'verifying' AND "kind" IN ('stage_build', 'fix') ORDER BY "seq"`)
    .all(project) as { id: string }[];
  for (const { id } of items) reconcileRepair(tx, id);
}

// D3 §2.10 for one item: if it is `verifying`, its run has ended, a repair
// check failed at its current candidate, and nothing was yet taken for this
// item, candidate and work generation: the conflict route if a pending
// conflict names a failed check; nothing while a `correct_check` or
// `change_spec` answer holds; otherwise a limit parks it, or it is sent
// back once, `repair_attempts` + 1, however many checks failed.
export function reconcileRepair(tx: Tx, itemId: string): void {
  const item = getWorkItem(tx, itemId);
  if (!item || item.status !== 'verifying' || !REPAIRABLE.includes(item.kind)) return;
  // A run that still holds the item ends first; its end reconciles again
  // (so a conflict it reports is recorded before any repair it would win over).
  if (hasUnendedRun(tx.db, item.id)) return;
  const view = repairView(tx.db, item);
  if (!view || view.failed.length === 0) return;
  const generation = item.trigger_generation;
  const taken = parseJson<CheckRepair>((item as WorkRow & { check_repair?: string | null }).check_repair ?? null);
  if (taken && taken.candidate === view.candidate.id && taken.generation === generation) return;

  const pending = pendingConflicts(tx.db, item, view);
  if (pending.length > 0) {
    raiseConflict(tx, item, view, pending);
    return;
  }
  if (heldByAnswer(item, view)) return;

  const checks = view.failed.map((f) => f.check.id);
  const repair = JSON.stringify({ candidate: view.candidate.id, generation, at: tx.at } satisfies CheckRepair);
  const policy = projectPolicy(tx.db, item.project);
  const cause = { cause: 'check_failed', candidate: view.candidate.id, checks };
  const key = progressKey(tx.db, view);
  let progress: { no_progress_count?: number; progress_key?: string | null } = {};
  if (key === null) progress = { progress_key: null };
  else if (key === item.progress_key) {
    const count = item.no_progress_count + 1;
    if (count >= policy.no_progress_max!) {
      park(tx, item, 'no_progress_max', checks, { no_progress_count: count }, cause, repair);
      return;
    }
    progress = { no_progress_count: count };
  } else progress = { progress_key: key };
  if (item.repair_attempts >= policy.repair_attempts_max!) {
    park(tx, item, 'repair_attempts_max', checks, progress, cause, repair);
    return;
  }
  transitionWork(tx, item, 'eligible', { repair_attempts: item.repair_attempts + 1, repair_due: 0, ...progress }, cause);
  tx.db.prepare('UPDATE "work_items" SET "check_repair" = ? WHERE "id" = ?').run(repair, item.id);
}

// A limit reached: the item parks with a blocker naming the limit and the
// failed checks (SEAM.md §229, `blocker.checks`) and the decision that holds
// it. The park is what was taken for this candidate.
function park(
  tx: Tx,
  item: WorkRow,
  reason: string,
  checks: string[],
  extra: { no_progress_count?: number; progress_key?: string | null },
  cause: Record<string, unknown>,
  repair: string,
): void {
  const blocker = JSON.stringify({ reason, raised_at: tx.at, decision: null, checks });
  transitionWork(tx, item, 'parked', { blocker, ...extra }, { ...cause, reason });
  tx.db.prepare('UPDATE "work_items" SET "check_repair" = ? WHERE "id" = ?').run(repair, item.id);
  raiseQuestion(tx, { project: item.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
}

// A `correct_check` or `change_spec` answer holds the item: the failure at
// the candidate and version the conflict was answered at is the check's or
// the spec's, not the Builder's, so no repair is taken for it. The item
// waits in `verifying` until the protected version or its candidate changes
// (a corrected check under a new version, or a new candidate, is judged
// afresh). Not built: re-arming after a spec change, which changes neither;
// the item then waits for the person.
function heldByAnswer(item: WorkRow, view: RepairView): boolean {
  const c = parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null);
  return c !== null && (c.answer === 'correct_check' || c.answer === 'change_spec') && c.candidate === view.candidate.id && c.version === view.version.id;
}

// ---- conflicts (D3 §5 X2) ------------------------------------------------------------

// The conflict findings about the item that name one of its failed repair
// checks and that no blocker was yet raised for: a Builder's objection from
// one of the item's own runs, or a Verifier's or Reviewer's conflict finding
// raised on its current candidate (SEAM.md §232).
function pendingConflicts(db: Db, item: WorkRow, view: RepairView): FindingRow[] {
  const keys = new Set(view.failed.map((f) => f.check.key));
  const seen = new Set(parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null)?.findings ?? []);
  const rows = db
    .prepare(
      `SELECT f.*, r."work_item" AS "run_item" FROM "findings" f LEFT JOIN "runs" r ON r."id" = f."source_run"
       WHERE f."project" = ? AND f."category" IN ('requirement_conflict', 'contract_conflict') AND f."status" <> 'resolved' AND f."check" IS NOT NULL ORDER BY f."seq"`,
    )
    .all(item.project) as (FindingRow & { source_role: string | null; run_item: string | null })[];
  return rows.filter((f) => {
    if (!keys.has(f.check!) || seen.has(f.id)) return false;
    if (f.source_role === 'builder') return f.run_item === item.id;
    return (f.source_role === 'verifier' || f.source_role === 'reviewer') && f.candidate === view.candidate.id;
  });
}

// Not built: the same route from `executing` or `integrating` (D3 A.5 has
// those edges); it is taken here, where the repair it replaces would be.
// D3 §5 X2's blocker instead of the repair: `verifying → awaiting_decision`,
// `repair_attempts` unchanged, one open blocker offering exactly
// `correct_check`, `change_spec`, `retry` and `cancel`.
function raiseConflict(tx: Tx, item: WorkRow, view: RepairView, pending: FindingRow[]): void {
  const prior = parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null);
  const ids = pending.map((f) => f.id);
  const conflict: CheckConflict = { findings: [...new Set([...(prior?.findings ?? []), ...ids])], candidate: view.candidate.id, version: view.version.id, answer: null, at: tx.at };
  tx.db.prepare('UPDATE "work_items" SET "check_conflict" = ? WHERE "id" = ?').run(JSON.stringify(conflict), item.id);
  const checks = view.failed.map((f) => f.check.id);
  const blocker = JSON.stringify({ reason: 'check_conflict', raised_at: tx.at, decision: null, checks, findings: ids, candidate: view.candidate.id });
  transitionWork(tx, item, 'awaiting_decision', { blocker }, { cause: 'check_conflict', candidate: view.candidate.id, checks, findings: ids });
  raiseQuestion(tx, { project: item.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
}

// The X2 blocker's preview (queue.ts's blocker kind), or null when the item
// is not at one.
export function conflictPreview(item: WorkRow): { manifest: Record<string, unknown>; options: { key: string; label: string; consequence: string; effect: Record<string, unknown> }[]; question: string } | null {
  const blocker = parseJson<{ reason?: string; checks?: string[]; findings?: string[]; candidate?: string }>(item.blocker);
  if (item.status !== 'awaiting_decision' || blocker?.reason !== 'check_conflict') return null;
  const findings = blocker.findings ?? [];
  const checks = blocker.checks ?? [];
  return {
    manifest: {
      work_item: item.id,
      subject_status: 'awaiting_decision',
      cause: 'check_conflict',
      quarantined: false,
      evidence: { findings, checks, candidate: blocker.candidate ?? null },
      continuation: { status: item.continuation, from: item.continue_from },
    },
    options: [
      { key: 'correct_check', label: 'Correct the check', consequence: 'The Verifier is given check_correction work for each conflict; the check stays in force until a corrected version is approved.', effect: { work_item: item.id, register: 'check_correction', findings } },
      { key: 'change_spec', label: 'Change the spec', consequence: 'spec_change work is raised for each conflict (F §3.8); nothing of the spec changes until it is approved.', effect: { work_item: item.id, register: 'spec_change', findings } },
      { key: 'retry', label: 'Retry', consequence: 'You see no conflict: the Builder is sent back once to make the check pass.', effect: { work_item: item.id, to: 'eligible' } },
      { key: 'cancel', label: 'Cancel', consequence: 'The work item is cancelled.', effect: { work_item: item.id, to: 'cancelled' } },
    ],
    question:
      `Work item ${item.id} (${item.kind}): its check ${checks.join(', ')} failed, and ${findings.join(', ')} says the check or the requirement is in conflict. ` +
      'Correct the check, change the spec, retry the Builder, or cancel the work. No answer changes the check or its result.',
  };
}

// The person's answer to the X2 blocker, after the decision is consumed.
export function answerConflict(tx: Tx, item: WorkRow, option: string, decision: string): Effect[] {
  const blocker = parseJson<{ findings?: string[] }>(item.blocker) ?? {};
  const findings = blocker.findings ?? [];
  const prior = parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null);
  if (prior) tx.db.prepare('UPDATE "work_items" SET "check_conflict" = ? WHERE "id" = ?').run(JSON.stringify({ ...prior, answer: option, at: tx.at }), item.id);
  const cause = { decision, cause: option };
  if (option === 'cancel') {
    transitionWork(tx, item, 'cancelled', { blocker: null }, cause);
    return [];
  }
  if (option === 'correct_check') for (const f of findings) routeCheckCorrection(tx, item.project, f, 0);
  if (option === 'change_spec') {
    // Not built: any process for spec_change work. The item is recorded and
    // waits; the scheduler never dispatches it (no role performs the kind).
    for (const f of findings) {
      observeTrigger(tx, { project: item.project, kind: 'spec_change', trigger_source: 'spec_change', trigger_id: f, trigger_generation: 1, subject: { finding: f }, chain: 0, engineRaised: true }, { finding: f, decision });
    }
  }
  // Back to the status it left, `verifying`; a retry then takes its one
  // repair in this transaction (the answered conflicts no longer stop it).
  const now = transitionWork(tx, item, item.continuation ?? 'verifying', { blocker: null }, cause);
  if (option === 'retry') reconcileRepair(tx, now.id);
  return [{ kind: 'tick' }];
}

// ---- objections (D3 §5 X2, A.3) ------------------------------------------------------

interface Objection {
  check: string;
  criterion?: string;
  category: string;
  message: string;
}

// Does an objection concern the run's work item (SEAM.md §232)? For a
// stage_build: a required check listing the `stage` gate whose requirements
// are none or include one its stage implements, and a criterion of a
// requirement its stage implements. For a fix: its finding's check and
// criterion. A fixture fix naming no finding has none.
function concerns(db: Db, item: WorkRow, o: Objection, checks: CheckRow[]): boolean {
  const subject = parseJson<{ stage?: string; finding?: string }>(item.subject) ?? {};
  if (item.kind === 'stage_build') {
    const stage = subject.stage ? (db.prepare('SELECT "implements" FROM "stages" WHERE "id" = ?').get(subject.stage) as { implements: string } | undefined) : undefined;
    if (!stage) return false;
    const implemented = parseJson<string[]>(stage.implements) ?? [];
    const c = checks.find((x) => x.key === o.check);
    if (!c || c.required !== 1 || !(JSON.parse(c.gate_kinds) as string[]).includes('stage')) return false;
    const reqs = requirementsOf(c);
    if (reqs.length > 0 && !reqs.some((r) => implemented.includes(r))) return false;
    if (o.criterion === undefined) return true;
    const req = db.prepare('SELECT "id", "criteria" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(item.project, requirementKeyOf(o.criterion)) as { id: string; criteria: string | null } | undefined;
    return req !== undefined && implemented.includes(req.id) && (parseJson<string[]>(req.criteria) ?? []).includes(o.criterion);
  }
  if (item.kind === 'fix' && subject.finding) {
    const f = db.prepare('SELECT "check", "criterion" FROM "findings" WHERE "id" = ? AND "project" = ?').get(subject.finding, item.project) as { check: string | null; criterion: string | null } | undefined;
    return f !== undefined && f.check === o.check && (o.criterion === undefined || o.criterion === f.criterion);
  }
  return false;
}

// A Builder's objections, recorded with its completed run's end: each valid
// one as a conflict finding of the run (category, check, criterion,
// message), once. An invalid entry (an unknown key, another project's, an
// unknown criterion, one not concerning the item) records nothing; the run
// stands. The finding names no candidate: it is not a finding against the
// code, so it blocks no gate; its effect is the X2 route.
export function recordObjections(tx: Tx, run: { id: string; project: string; work_item: string; role: string; outcome: string | null }): void {
  if (run.outcome !== 'completed' || run.role !== 'builder') return;
  const value = tx.db.prepare('SELECT "result_value" FROM "runs" WHERE "id" = ?').get(run.id) as { result_value: string | null } | undefined;
  const objections = (parseJson<{ report?: { objections?: Objection[] } }>(value?.result_value ?? null)?.report?.objections ?? []) as Objection[];
  if (objections.length === 0) return;
  const item = getWorkItem(tx, run.work_item);
  const version = effectiveVersion(tx.db, run.project);
  if (!item || !version) return;
  const checks = checksOfVersion(tx.db, version.id);
  const criteria = knownCriteria(tx.db, run.project);
  const done = new Set(
    (tx.db.prepare('SELECT "category", "check", "criterion", "message" FROM "findings" WHERE "source_run" = ?').all(run.id) as { category: string; check: string | null; criterion: string | null; message: string }[]).map((f) =>
      canonical([f.category, f.check, f.criterion, f.message]),
    ),
  );
  for (const o of objections) {
    if (!CONFLICT_CATEGORIES.includes(o.category)) continue;
    if (!checks.some((c) => c.key === o.check)) continue;
    if (o.criterion !== undefined && !(criteria?.has(o.criterion) ?? false)) continue;
    if (!concerns(tx.db, item, o, checks)) continue;
    const id = canonical([o.category, o.check, o.criterion ?? null, o.message]);
    if (done.has(id)) continue;
    done.add(id);
    raiseFinding(tx, {
      project: run.project,
      scope: 'candidate',
      candidate: null,
      run: run.id,
      role: 'builder',
      category: o.category,
      severity: 'medium',
      message: o.message,
      check: o.check,
      criterion: o.criterion ?? null,
    });
  }
}

// ---- what verifies a finding (D3 §2.11; F2 (c)) --------------------------------------

// A check that can verify a finding's criterion: a required check of origin
// acceptance whose covers.criteria names it. `required` here is the version's
// mark; the gate also asks that the check be in its scope's required set.
export function verifiesCriterion(c: CheckRow | undefined, criterion: string | null): boolean {
  if (!c || criterion === null || c.required !== 1 || c.origin !== 'acceptance') return false;
  return (parseJson<string[]>(c.criteria ?? '[]') ?? []).includes(criterion);
}

// The `check_correction` work for the Verifier a missing verification or an
// X2 `correct_check` registers, triggered by the finding (SEAM.md §§231,
// 232): one per finding, whichever registers it first.
export function routeCheckCorrection(tx: Tx, project: string, finding: string, chain: number): void {
  observeTrigger(tx, { project, kind: 'check_correction', trigger_source: 'check_correction', trigger_id: finding, trigger_generation: 1, subject: { finding }, chain }, { finding });
}

// D3 §2.11's route, in the transaction recording a `fix` disposition: a
// finding naming no criterion, or whose named check is not a required
// acceptance-origin check of the effective version covering it, cannot be
// verified, and the Verifier is given check_correction work. Chained like
// the fix (Q8 (a)): at the default max_chained_roles it waits for a person.
export function routeMissingVerification(tx: Tx, f: Pick<FindingRow, 'id' | 'project' | 'check'> & { criterion?: string | null }, chain: number): void {
  const version = effectiveVersion(tx.db, f.project);
  const named = version && f.check !== null ? checksOfVersion(tx.db, version.id).find((c) => c.key === f.check) : undefined;
  if (verifiesCriterion(named, f.criterion ?? null)) return;
  routeCheckCorrection(tx, f.project, f.id, chain);
}

// The same route when a new protected version becomes effective (D3 §2.11):
// every finding dispositioned fix and unresolved that the new version leaves
// without a verifying check.
export function routeMissingAtVersion(tx: Tx, project: string): void {
  const rows = tx.db
    .prepare(`SELECT "id", "project", "check", "criterion" FROM "findings" WHERE "project" = ? AND "status" = 'dispositioned' AND "disposition" = 'fix' ORDER BY "seq"`)
    .all(project) as (Pick<FindingRow, 'id' | 'project' | 'check'> & { criterion: string | null })[];
  for (const f of rows) routeMissingVerification(tx, f, 1);
}
