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
// - A conflict settled by its disposition (real loop run 3, L3-1): a
//   Verifier's or Reviewer's conflict finding an open X2 blocker names,
//   dispositioned `fix`, `accept` or `defer` by a Reviewer or the person,
//   settles the conflict claim; once every finding the blocker names is
//   settled, its question is withdrawn and the item follows the disposition
//   (`settleConflicts`).
// - One Builder per failure (L3-1): a stage's own repair waits while open
//   `fix` work for a finding naming the failed check, raised on a candidate
//   holding the stage, is under way (the fix is the repair; `fixUnderway`),
//   and a `fix` is not dispatched while the stage is being sent back for
//   its finding's check at its finding's candidate (`repairUnderway`).
// - What can verify a finding (D3 §2.11): its named check, a required
//   acceptance-origin check covering its criterion; or, for a finding naming
//   no criterion, a required acceptance-origin check covering none (E152
//   item 3: a phase-only, smoke, static or lint check). A `fix` disposition
//   of a finding no such check can verify routes `check_correction` work to
//   the Verifier, triggered by the finding (Q8 (a)).
//
// Not built here, by design (slice 21, approved):
// - the X2 blocker from `executing` or `integrating` (D3 A.5 lists those
//   edges; the route is taken where the repair it replaces would be, from
//   `verifying` only);
// - any process for `spec_change` work (D1's kind for F §3.8): the item is
//   created and waits, never dispatched;
// - objections from any role but the Builder (a Verifier reports a conflict
//   as a finding);
// - re-arming a hold after a spec change: see `heldByChangeSpec`.

import { requestsFromFindings } from '../../spec/change.js';
import { requirementKeyOf } from '../../checks/schema.js';
import { canonical, parseJson, sha256 } from './common.js';
import type { Effect } from './control.js';
import { type DecisionRow, invalidateDecision } from './decisions.js';
import { type CandidateRow, type CheckRow, candidateContent, checksOfVersion, deliveredStageScope, getCandidate, heldByAncestry, requiredSet } from './evidence.js';
import { type FindingRow, checkState } from './gates.js';
import { type VersionRow, effectiveVersion } from './protected.js';
import { knownCriteria, readDue } from './checks.js';
import { raiseFinding } from './findings.js';
import { raiseQuestion } from './queue.js';
import { projectPolicy } from './settings.js';
import type { Tx } from './tx.js';
import { type ChainOrigin, type WorkRow, getWorkItem, observeTrigger, transitionWork } from './work.js';
import { REPLAN_OPTION, stageInActiveSet } from '../../plan/replace.js';

type Db = Tx['db'];

export const CONFLICT_CATEGORIES: readonly string[] = ['requirement_conflict', 'contract_conflict'];
export const X2_OPTIONS = ['correct_check', 'change_spec', 'retry', 'cancel'] as const;
const REPAIRABLE: readonly string[] = ['stage_build', 'fix'];

// work_items.check_repair (D3 A.3).
interface CheckRepair {
  candidate: string;
  generation: number;
  // The keys of the repair checks failed when it was taken (absent on a
  // repair recorded before they were kept).
  checks?: string[];
  at: string;
}

// work_items.check_conflict (engine-owned): every conflict finding a blocker
// was raised for (answered or open), where the latest was raised, and the
// person's answer to it once given.
interface CheckConflict {
  findings: string[];
  // The findings the latest blocker was raised for.
  raised?: string[];
  candidate: string;
  version: string;
  // The person's answer; 'corrected' once a correct_check's correction
  // ended with a version applied (the hold is over); 'dispositioned' when
  // the blocker was withdrawn because every finding it named was
  // dispositioned (settleConflicts).
  answer: (typeof X2_OPTIONS)[number] | 'corrected' | 'dispositioned' | null;
  // The check_correction work a `correct_check` answer registered.
  corrections?: string[];
  at: string;
}

// ---- the current candidate and its repair checks -----------------------------------

// The item's current candidate (D3 §2.10). For a fix, E43's fix candidate:
// the latest candidate whose own held work lists it. For a stage_build
// (Sean's ruling on S1, 2026-10-08): the latest candidate not superseded
// that holds it, itself or by ancestry (E43), so a stage check failing on a
// fix's candidate sends the stage's own Builder back; null when every
// candidate holding it is superseded.
export function currentCandidate(db: Db, item: Pick<WorkRow, 'id' | 'project' | 'kind'>): (CandidateRow & { checks_due: string | null }) | null {
  if (item.kind === 'stage_build') {
    const rows = db.prepare(`SELECT * FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC`).all(item.project) as (CandidateRow & { checks_due: string | null })[];
    return rows.find((c) => heldByAncestry(db, c).includes(item.id)) ?? null;
  }
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
  // The fix under way is the repair (L3-1): nothing is taken, and no
  // conflict raised, until it has ended; the stage is then judged at its
  // current candidate, the fix's once it integrated.
  if (fixUnderway(tx.db, item, view) !== null) return;

  const pending = pendingConflicts(tx.db, item, view);
  if (pending.length > 0) {
    raiseConflict(tx, item, view, pending.map((f) => f.id));
    return;
  }
  const conflict = parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null);
  if (conflict?.answer === 'correct_check') {
    const outcome = correctionOutcome(tx.db, conflict.corrections ?? []);
    if (outcome === 'open') return;
    if (outcome === 'none') {
      // The correction ended with no corrected version: the person decides again.
      raiseConflict(tx, item, view, conflict.raised ?? conflict.findings);
      return;
    }
    // A corrected version came out of it: judged afresh, as any failure.
    tx.db.prepare('UPDATE "work_items" SET "check_conflict" = ? WHERE "id" = ?').run(JSON.stringify({ ...conflict, answer: 'corrected', at: tx.at }), item.id);
  }
  if (heldByChangeSpec(conflict, view)) return;

  const checks = view.failed.map((f) => f.check.id);
  const repair = JSON.stringify({ candidate: view.candidate.id, generation, checks: view.failed.map((f) => f.check.key), at: tx.at } satisfies CheckRepair);
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

// A `correct_check` answer holds the item while the correction it asked
// for is open (slice 21 review, S3; driver's ruling under D3 §5 X2): any
// check_correction work it registered not yet ended, or any protected
// proposal those runs captured not yet applied or rejected. The failure at
// hand is the check's, not the Builder's, until then. Ended: 'applied' if a
// version came out of it (the item is then judged afresh at the new state),
// 'none' if not (the X2 blocker is raised again for the person). An
// unrelated protected application changes none of this.
function correctionOutcome(db: Db, corrections: string[]): 'open' | 'applied' | 'none' {
  if (corrections.length === 0) return 'none';
  let applied = false;
  for (const id of corrections) {
    const w = db.prepare('SELECT "status" FROM "work_items" WHERE "id" = ?').get(id) as { status: string } | undefined;
    if (w && w.status !== 'complete' && w.status !== 'cancelled') return 'open';
    const proposals = db
      .prepare(`SELECT p."status" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" WHERE r."work_item" = ?`)
      .all(id) as { status: string }[];
    if (proposals.some((p) => p.status !== 'applied' && p.status !== 'rejected')) return 'open';
    if (proposals.some((p) => p.status === 'applied')) applied = true;
  }
  return applied ? 'applied' : 'none';
}

// A `change_spec` answer holds the item at the candidate and version it was
// given at (not built: no process for spec_change work, which waits for the
// person; the item then waits in `verifying` until the candidate or the
// version changes).
function heldByChangeSpec(c: CheckConflict | null, view: RepairView): boolean {
  return c !== null && c.answer === 'change_spec' && c.candidate === view.candidate.id && c.version === view.version.id;
}

// ---- one Builder per failure (real loop run 3, L3-1) ----------------------------------

// Open `fix` work (not complete or cancelled) for a finding that names one
// of a stage_build's failed repair checks and was raised on a candidate
// holding the stage's work (itself or by ancestry): the fix's id, or null.
// Only a stage_build waits: a fix's own repair is never held, so two items
// never wait on each other.
function fixUnderway(db: Db, item: WorkRow, view: RepairView): string | null {
  if (item.kind !== 'stage_build') return null;
  const keys = view.failed.map((f) => f.check.key);
  if (keys.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT w."id", f."candidate" FROM "work_items" w JOIN "findings" f ON f."id" = json_extract(w."subject", '$.finding')
       WHERE w."project" = ? AND w."kind" = 'fix' AND w."status" NOT IN ('complete', 'cancelled') AND f."candidate" IS NOT NULL
         AND f."check" IN (SELECT value FROM json_each(?)) ORDER BY w."seq"`,
    )
    .all(item.project, JSON.stringify(keys)) as { id: string; candidate: string }[];
  for (const r of rows) {
    const c = getCandidate(db, r.candidate);
    if (c && heldByAncestry(db, c).includes(item.id)) return r.id;
  }
  return null;
}

// The other way: a `fix` waits (held, not failed) while a stage_build whose
// work its finding's candidate holds is being sent back for the finding's
// check at that candidate (its repair taken there and not yet integrated or
// ended). A repair recorded without its checks counts as one for every
// check: unknown is not "another failure". The stage_build's id, or null.
export function repairUnderway(db: Db, item: Pick<WorkRow, 'project' | 'kind' | 'subject'>): string | null {
  if (item.kind !== 'fix') return null;
  const finding = parseJson<{ finding?: string }>(item.subject)?.finding;
  if (!finding) return null;
  const f = db.prepare('SELECT "check", "candidate" FROM "findings" WHERE "id" = ? AND "project" = ?').get(finding, item.project) as { check: string | null; candidate: string | null } | undefined;
  if (!f?.check || !f.candidate) return null;
  const c = getCandidate(db, f.candidate);
  if (!c) return null;
  const held = new Set(heldByAncestry(db, c));
  const rows = db
    .prepare(
      `SELECT "id", "check_repair" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' AND "check_repair" IS NOT NULL
         AND "status" IN ('eligible', 'held', 'claimed', 'executing', 'integrating') ORDER BY "seq"`,
    )
    .all(item.project) as { id: string; check_repair: string }[];
  for (const r of rows) {
    if (!held.has(r.id)) continue;
    const taken = parseJson<CheckRepair>(r.check_repair);
    if (!taken || taken.candidate !== f.candidate) continue;
    if (taken.checks === undefined || taken.checks.includes(f.check)) return r.id;
  }
  return null;
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
    // A conflict the person or a Reviewer accepted or deferred stops nothing
    // (slice 21 review, minor 3): only one undispositioned, or dispositioned fix.
    if (f.disposition !== null && f.disposition !== 'fix') return false;
    if (f.source_role === 'builder') return f.run_item === item.id;
    return (f.source_role === 'verifier' || f.source_role === 'reviewer') && f.candidate === view.candidate.id;
  });
}

// Not built: the same route from `executing` or `integrating` (D3 A.5 has
// those edges); it is taken here, where the repair it replaces would be.
// D3 §5 X2's blocker instead of the repair: `verifying → awaiting_decision`,
// `repair_attempts` unchanged, one open blocker offering exactly
// `correct_check`, `change_spec`, `retry` and `cancel`.
function raiseConflict(tx: Tx, item: WorkRow, view: RepairView, ids: string[]): void {
  const prior = parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null);
  const conflict: CheckConflict = {
    findings: [...new Set([...(prior?.findings ?? []), ...ids])],
    raised: ids,
    candidate: view.candidate.id,
    version: view.version.id,
    answer: null,
    ...(prior?.corrections ? { corrections: prior.corrections } : {}),
    at: tx.at,
  };
  tx.db.prepare('UPDATE "work_items" SET "check_conflict" = ? WHERE "id" = ?').run(JSON.stringify(conflict), item.id);
  const checks = view.failed.map((f) => f.check.id);
  const blocker = JSON.stringify({ reason: 'check_conflict', raised_at: tx.at, decision: null, checks, findings: ids, candidate: view.candidate.id });
  transitionWork(tx, item, 'awaiting_decision', { blocker }, { cause: 'check_conflict', candidate: view.candidate.id, checks, findings: ids });
  raiseQuestion(tx, { project: item.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
}

// The X2 blocker's preview (queue.ts's blocker kind), or null when the item
// is not at one.
export function conflictPreview(item: WorkRow, db?: Tx['db']): { manifest: Record<string, unknown>; options: { key: string; label: string; consequence: string; effect: Record<string, unknown> }[]; question: string } | null {
  const blocker = parseJson<{ reason?: string; checks?: string[]; findings?: string[]; candidate?: string; replan?: string }>(item.blocker);
  if (item.status !== 'awaiting_decision' || blocker?.reason !== 'check_conflict') return null;
  // Answered `replan` (D6 §5.7): the item waits for the replacement.
  if (blocker.replan) return null;
  // D6 §5.7, A.2: an objection upheld as being against the plan, on a
  // stage's own work in the active obligation set; never on a fix item
  // (the review's M3).
  const stage = parseJson<{ stage?: string }>(item.subject)?.stage;
  const replan = db !== undefined && item.kind === 'stage_build' && typeof stage === 'string' && stageInActiveSet(db, stage);
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
      ...(replan ? [{ ...REPLAN_OPTION(item), label: 'Replan', consequence: 'The objection is upheld as being against the plan: the Architect replans the open phase with it as evidence; the item waits for the replacement.' }] : []),
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
  // A correct_check answer: the Verifier's check_correction work, one per
  // conflict, a fresh one where an earlier correction of it has ended.
  const corrections = option === 'correct_check' ? findings.map((f) => correctionFor(tx, item.project, f)) : (prior?.corrections ?? []);
  if (prior) tx.db.prepare('UPDATE "work_items" SET "check_conflict" = ? WHERE "id" = ?').run(JSON.stringify({ ...prior, answer: option, corrections, at: tx.at }), item.id);
  const cause = { decision, cause: option };
  if (option === 'cancel') {
    transitionWork(tx, item, 'cancelled', { blocker: null }, cause);
    return [];
  }
  if (option === 'change_spec') {
    // A request per conflict, from its finding (D6 §4.2; M431 (c)); where
    // the project has no approved specification, the item is recorded and
    // waits, never dispatched (the driver's ruling Q14).
    requestsFromFindings(tx, { project: item.project, findings, decision });
  }
  // Back to the status it left, `verifying`; a retry then takes its one
  // repair in this transaction (the answered conflicts no longer stop it).
  const now = transitionWork(tx, item, item.continuation ?? 'verifying', { blocker: null }, cause);
  if (option === 'retry') reconcileRepair(tx, now.id);
  return [{ kind: 'tick' }];
}

// A conflict claim settled by a disposition (L3-1), in the transaction that
// records it: every item awaiting an unanswered X2 blocker that names the
// finding, once each finding the blocker names is dispositioned or
// resolved, has the blocker's question withdrawn (invalidated, the reason
// recorded), returns to the status it left with `check_conflict.answer`
// 'dispositioned', and is reconciled there: after `accept` or `defer` the
// failure is the Builder's and takes its one repair; after `fix` the stage
// waits for the fix work (`fixUnderway`). A Builder's objection is never
// dispositioned (isObjection), so a blocker naming one stays the person's.
export function settleConflicts(tx: Tx, f: Pick<FindingRow, 'id' | 'project' | 'category'> & { source_role?: string | null }, disposition: string): void {
  if (!CONFLICT_CATEGORIES.includes(f.category) || isObjection({ source_role: f.source_role ?? null, category: f.category })) return;
  const items = tx.db
    .prepare(
      `SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'awaiting_decision' AND json_extract("blocker", '$.reason') = 'check_conflict'
         AND json_extract("blocker", '$.replan') IS NULL AND EXISTS (SELECT 1 FROM json_each(json_extract("blocker", '$.findings')) WHERE value = ?) ORDER BY "seq"`,
    )
    .all(f.project, f.id) as WorkRow[];
  for (const item of items) {
    const blocker = parseJson<{ findings?: string[] }>(item.blocker) ?? {};
    const named = blocker.findings ?? [];
    const settled = named.every((id) => {
      const row = tx.db.prepare('SELECT "status", "disposition" FROM "findings" WHERE "id" = ?').get(id) as { status: string; disposition: string | null } | undefined;
      return row !== undefined && (row.disposition !== null || row.status === 'resolved');
    });
    if (!settled) continue;
    const reason = `the conflict was settled by its disposition: ${f.id} dispositioned ${disposition}`;
    const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'work_item' AND "subject_id" = ? AND "status" = 'open'`).all(item.id) as DecisionRow[];
    for (const d of open) invalidateDecision(tx, d, reason, { finding: f.id, disposition });
    const prior = parseJson<CheckConflict>((item as WorkRow & { check_conflict?: string | null }).check_conflict ?? null);
    if (prior) tx.db.prepare('UPDATE "work_items" SET "check_conflict" = ? WHERE "id" = ?').run(JSON.stringify({ ...prior, answer: 'dispositioned', at: tx.at }), item.id);
    const now = transitionWork(tx, item, item.continuation ?? 'verifying', { blocker: null }, { cause: 'conflict_dispositioned', findings: named, finding: f.id, disposition });
    reconcileRepair(tx, now.id);
  }
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
function concerns(db: Db, item: WorkRow, o: Objection, version: VersionRow): boolean {
  const subject = parseJson<{ stage?: string; finding?: string }>(item.subject) ?? {};
  if (item.kind === 'stage_build') {
    // The stage's `stage` scope by the one scope rule (computeScope), as it
    // stands once the stage delivers what it implements (slice 21 review,
    // minor 5): the check in its required set, the criterion one of its
    // obligations'.
    const scope = subject.stage ? deliveredStageScope(db, { project: item.project, stage: subject.stage, version: version.id }) : null;
    if (!scope || !scope.required.some((c) => c.key === o.check)) return false;
    if (o.criterion === undefined) return true;
    const req = db.prepare('SELECT "id", "criteria" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(item.project, requirementKeyOf(o.criterion)) as { id: string; criteria: string | null } | undefined;
    return req !== undefined && scope.obligations.includes(req.id) && (parseJson<string[]>(req.criteria) ?? []).includes(o.criterion);
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
    if (!concerns(tx.db, item, o, version)) continue;
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

// A Builder's objection recorded as a finding (D3 §5 X2): it is a conflict
// for the person's X2 answer, never a defect a disposition fixes, defers or
// accepts (slice 21 review, minor 2).
export const isObjection = (f: { source_role?: string | null; category: string }): boolean => f.source_role === 'builder' && CONFLICT_CATEGORIES.includes(f.category);

// ---- what verifies a finding (D3 §2.11; F2 (c)) --------------------------------------

// A check that can verify a finding's criterion: a required check of origin
// acceptance whose covers.criteria names it. `required` here is the version's
// mark; the gate also asks that the check be in its scope's required set.
export function verifiesCriterion(c: CheckRow | undefined, criterion: string | null): boolean {
  if (!c || criterion === null || c.required !== 1 || c.origin !== 'acceptance') return false;
  return (parseJson<string[]>(c.criteria ?? '[]') ?? []).includes(criterion);
}

// The check_correction work of a `correct_check` answer (not chained: the
// person's answer made it), on an X2 blocker or on the owner's
// finding_disposition question (E152 item 3): the finding's open
// correction if there is one, else the next generation of its trigger.
export function correctionFor(tx: Tx, project: string, finding: string): string {
  const open = tx.db
    .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_correction' AND "trigger_source" = 'check_correction' AND "trigger_id" = ? AND "status" NOT IN ('complete', 'cancelled') ORDER BY "seq" DESC LIMIT 1`)
    .get(project, finding) as { id: string } | undefined;
  if (open) return open.id;
  const { n } = tx.db
    .prepare(`SELECT COALESCE(MAX("trigger_generation"), 0) + 1 AS n FROM "work_items" WHERE "project" = ? AND "trigger_source" = 'check_correction' AND "trigger_id" = ?`)
    .get(project, finding) as { n: number };
  return observeTrigger(tx, { project, kind: 'check_correction', trigger_source: 'check_correction', trigger_id: finding, trigger_generation: n, subject: { finding }, chain: 0 }, { finding }).work_item.id;
}

// The `check_correction` work for the Verifier a missing verification or an
// X2 `correct_check` registers, triggered by the finding (SEAM.md §§231,
// 232): one per finding, whichever registers it first.
export function routeCheckCorrection(tx: Tx, project: string, finding: string, chain: number, origin: ChainOrigin | null = null): void {
  observeTrigger(tx, { project, kind: 'check_correction', trigger_source: 'check_correction', trigger_id: finding, trigger_generation: 1, subject: { finding }, chain, chain_origin: origin }, { finding });
}

// D3 §2.11's route, in the transaction recording a `fix` disposition: a
// finding naming no criterion, or whose named check is not a required
// acceptance-origin check of the effective version covering it, cannot be
// verified, and the Verifier is given check_correction work. Chained like
// the fix (Q8 (a)): at the default max_chained_roles it waits for a person.
export function routeMissingVerification(tx: Tx, f: Pick<FindingRow, 'id' | 'project' | 'check' | 'candidate'> & { criterion?: string | null }, chain: number, origin: ChainOrigin | null = null): void {
  const version = effectiveVersion(tx.db, f.project);
  if (version && findingVerifiable(tx.db, f, version.id)) return;
  routeCheckCorrection(tx, f.project, f.id, chain, origin);
}

// D3 §2.11 as amended (E152 item 3, Sean 2026-10-16): a finding naming no
// criterion is verified by its named check alone when that check covers no
// criterion (a phase-only, smoke, static or lint check): a required
// acceptance-origin check whose covers.criteria is empty. `required` here is
// the version's mark; the gate also asks that the check be in the required
// set of the scope it evaluates.
export function verifiesByCheck(c: CheckRow | undefined): boolean {
  if (!c || c.required !== 1 || (c.origin ?? 'acceptance') !== 'acceptance') return false;
  return (parseJson<string[]>(c.criteria ?? '[]') ?? []).length === 0;
}

// The checks of the `phase` scope of each active phase plan of the project
// on the candidate (D6 §5.8): the phase-only checks and the regression set.
function phaseScopeChecks(db: Db, project: string, candidate: CandidateRow, version: string): CheckRow[] {
  const plans = db.prepare(`SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" IN ('published', 'completed') ORDER BY rowid`).all(project) as { id: string }[];
  return plans.flatMap((p) => requiredSet(db, { project, candidate, kind: 'phase', stage: null, version, phasePlan: p.id }).required);
}

// Can a finding's named check verify it? With a criterion (D3 §2.11
// condition 2, as Sean ruled on S2, 2026-10-08): a required acceptance-origin
// check covering the criterion in one of the finding's candidate's scopes,
// the union candidateContent gives, as registration uses it. With none (E152
// item 3): a required acceptance-origin check covering no criterion in one
// of those scopes or in a phase scope of the candidate (a phase-only check).
// A finding with no candidate (project scope) has no candidate's scopes to
// read: the version's own required mark is its rule (not pinned).
export function findingVerifiable(db: Db, f: Pick<FindingRow, 'project' | 'check' | 'candidate'> & { criterion?: string | null }, version: string): boolean {
  if (f.check === null) return false;
  const candidate = f.candidate ? getCandidate(db, f.candidate) : undefined;
  const pool = candidate ? candidateContent(db, f.project, candidate, version).checks : checksOfVersion(db, version);
  if ((f.criterion ?? null) !== null) return verifiesCriterion(pool.find((c) => c.key === f.check), f.criterion ?? null);
  const phase = candidate ? phaseScopeChecks(db, f.project, candidate, version) : [];
  return [...pool, ...phase].some((c) => c.key === f.check && verifiesByCheck(c));
}

// Is a correction registered for the finding still open (E152 item 3): its
// check_correction work not ended, or a protected proposal its runs
// captured not yet applied or rejected?
export function correctionOpen(db: Db, project: string, finding: string): boolean {
  const ids = (
    db.prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_correction' AND "trigger_source" = 'check_correction' AND "trigger_id" = ?`).all(project, finding) as { id: string }[]
  ).map((r) => r.id);
  return ids.length > 0 && correctionOutcome(db, ids) === 'open';
}

// The same route when a new protected version becomes effective (D3 §2.11):
// every finding dispositioned fix and unresolved that the new version leaves
// without a verifying check.
export function routeMissingAtVersion(tx: Tx, project: string): void {
  const rows = tx.db
    .prepare(`SELECT "id", "project", "check", "candidate", "criterion" FROM "findings" WHERE "project" = ? AND "status" = 'dispositioned' AND "disposition" = 'fix' ORDER BY "seq"`)
    .all(project) as (Pick<FindingRow, 'id' | 'project' | 'check' | 'candidate'> & { criterion: string | null })[];
  for (const f of rows) routeMissingVerification(tx, f, 1);
}
