// What a Verifier's or Reviewer's run reports, recorded once its run is
// accepted (SEAM.md §§68, 74; D1 §§3.4, 9.4; F §§4.1, 6.1-6.3; E19): findings,
// sign-offs, dispositions, severity changes, applicability proposals and
// assessments, and a Reviewer's approval of a proposal. A role proposes;
// what is beyond its authority raises a decision for the human owner. Nothing
// a role reports changes a check state.

import { parseJson } from './common.js';
import { type CandidateRow, contentHash, getCandidate, markStale } from './evidence.js';
import { type FindingRow, findingApplies, tierQueuesReview } from './gates.js';
import { reviewerApprove } from './classification.js';
import { OWED_SCOPE, REVIEWER_DISAGREES_SCOPE, blocksAnyGate, differsFromOwner, reaskOwed, changeSeverity, raiseQuestion, recordDisposition, reviewerDisagreesSeed } from './queue.js';
import { getRun, parkWork } from './runs.js';
import type { Tx } from './tx.js';
import { getWorkItem, workItemOfRun } from './work.js';
import { findingVerification, isObjection } from './repair.js';
import { effectiveVersion } from './protected.js';
import { alphaSignoffsUnsigned } from './alpha-review.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FINDING_CATEGORIES = ['defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene'] as const;
const RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const BLOCKING = ['critical', 'high'];

export interface Report {
  findings?: { category: string; severity: string; message: string; scope?: string; sensitive_area?: string; check?: string; criterion?: string }[];
  signoffs?: { scope: string; module?: string }[];
  dispositions?: { finding: string; disposition: 'fix' | 'defer' | 'accept'; linked_issue?: string; defer_target?: string; remediation?: string; target?: 'plan' }[];
  severity_changes?: { finding: string; to: string }[];
  applicability?: { finding: string; candidate: string; reason: string; evidence: string }[];
  assessments?: { assessment: string; verdict: 'not_applicable' | 'applicable' }[];
  proposal?: { rationale: string; requested_change_kind: string };
  proposal_approval?: { proposal: string; reason: string };
  alpha_exception_proposals?: { finding: string; containment_text: string; references: ({ path: string } | { record: string })[]; testing_purpose: string }[];
  // A Builder's objections to a check (D3 §5 X2, A.3), recorded with its
  // run's end (repair.ts).
  objections?: { check: string; criterion?: string; category: string; message: string }[];
  // An Architect's replan (D6 §5.6): the plan it wrote, its declaration.
  plan?: string;
  roadmap_revision?: string | boolean;
  adrs_changed?: string[];
  conformance?: 'within_baseline' | 'uncertain';
  notes?: string;
  // A Spec Writer's proposed change (D6 §4.3): the changed requirements.
  changes?: { key: string; kind: string; reason: string }[];
  // D6 §8.3, B.7 (B13): a Verifier's adopted tests with their boundary.
  adopted_tests?: import('../../adopt/boundary.js').AdoptedTest[];
  // D6 §6.2, B.7: a phase authoring's deferrals and governed changes.
  deferred_criteria?: { criterion: string; reason: string; prerequisite: { stage?: number; interface?: string } }[];
  governed_changes?: { check_commands?: boolean; programs?: string[] };
  // D6 §8.3 (B.7): an Architect's retrofit replan's requests for criteria.
  spec_change_requests?: { keys: string[]; text: string }[];
  // D6 §4.5 (Q6): a Verifier's applicability assessment on a correction.
  spec_applicability?: { check: string; criteria: string[]; rationale: string }[];
  // D7 §6.5, B.17, G15 (M6): a UI Builder's asset bindings, validated at
  // integration (design/asset-bindings.ts).
  asset_bindings?: { slot: string; variant: string; target: string; path: string; form: 'copy' | 'derived' }[];
  // Rapid prototype, slice E3: a brief preparation's brief (prototype/brief.ts).
  brief?: Record<string, unknown>;
}

const findingRowOf = (db: Tx['db'], id: string) => db.prepare('SELECT * FROM "findings" WHERE "id" = ?').get(id) as FindingRow | undefined;
const findingOf = (tx: Tx, id: string) => findingRowOf(tx.db, id);

// A finding is raised (D1 §3.4). `run` null: an engine-origin finding.
export function raiseFinding(
  tx: Tx,
  args: {
    project: string;
    scope: 'project' | 'lineage' | 'candidate';
    candidate: string | null;
    run: string | null;
    role: string | null;
    category: string;
    severity: string;
    message: string;
    sensitiveArea?: string | null;
    check?: string | null;
    criterion?: string | null;
    // D-1 (objection 209; errata E180): the scope the role reported, when
    // the engine stored it at another (a role's finding whose run's work
    // names no source candidate is a project finding), with the reason.
    normalized?: { reported_scope: string; scope_reason: 'no_source_candidate' };
  },
): string {
  const id = tx.newId('fnd_');
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "findings" WHERE "project" = ?').get(args.project) as { n: number };
  tx.db
    .prepare(
      `INSERT INTO "findings" ("id", "created_at", "project", "seq", "scope", "subject_id", "candidate", "source_run", "source_role", "category", "message", "check",
         "proposed_severity", "effective_severity", "severity_history", "sensitive_area", "status", "reevaluations", "criterion")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'open', '[]', ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      n,
      args.scope,
      args.scope === 'project' ? args.project : (args.candidate ?? args.project),
      args.candidate,
      args.run,
      args.role,
      args.category,
      args.message,
      args.check ?? null,
      args.severity,
      args.severity,
      args.sensitiveArea ?? null,
      args.criterion ?? null,
    );
  tx.emit(
    'finding.raised',
    { project: args.project, finding: id, run: args.run },
    { scope: args.scope, ...(args.normalized ?? {}), category: args.category, severity: args.severity, candidate: args.candidate },
  );
  markStale(tx, { project: args.project });
  return id;
}

// Why an Alpha exception may not be proposed for a finding, before anything
// is raised (D2 §5 C1): it is not High, it has a sensitive area, or it is not
// open against the candidate the Reviewer reviewed. null when it may.
export function alphaRefusal(db: Tx['db'], f: FindingRow | undefined, project: string, candidate: CandidateRow | undefined, reviewed?: string | null): string | null {
  if (!f || f.project !== project) return 'finding_not_found';
  if (!candidate) return 'no_reviewed_candidate';
  if (f.effective_severity !== 'high') return 'not_high';
  if (f.sensitive_area !== null) return 'sensitive_area';
  if ((f.status !== 'open' && f.status !== 'dispositioned') || !findingApplies(db, f, candidate)) return 'not_open_against_candidate';
  // The content the Reviewer reviewed, fixed when its run was started (SEAM.md
  // §§70, 119): a proposal about content that is no longer in force is
  // refused, since nobody has reviewed what is.
  if (reviewed !== undefined && reviewed !== contentHash(db, project, candidate)) return 'content_changed';
  return null;
}

// What the main thread reads before it retains a proposal's references: may
// the proposal be made, and on what revision are its paths read.
export function alphaCheck(db: Tx['db'], args: { run: string; finding: string }): { ok: true; project: string; candidate: string; revision: string } | { ok: false; reason: string } {
  const run = db.prepare('SELECT "project", "work_item", "role", "content_hash" FROM "runs" WHERE "id" = ?').get(args.run) as
    | { project: string; work_item: string; role: string; content_hash: string | null }
    | undefined;
  if (!run || run.role !== 'reviewer') return { ok: false, reason: 'not_a_reviewer_run' };
  const item = db.prepare('SELECT "subject" FROM "work_items" WHERE "id" = ?').get(run.work_item) as { subject: string };
  const subject = parseJson<{ candidate?: string }>(item.subject) ?? {};
  const candidate = subject.candidate ? getCandidate(db, subject.candidate) : undefined;
  const reason = alphaRefusal(db, findingRowOf(db, args.finding), run.project, candidate, run.content_hash);
  return reason === null ? { ok: true, project: run.project, candidate: candidate!.id, revision: candidate!.revision } : { ok: false, reason };
}

// What the main thread did with each Alpha exception proposal before the
// report is recorded: the containment evidence it published, or why it
// refused the proposal (an unresolved reference, an ineligible finding).
export type AlphaPrepared = { record: string } | { refusal: string; detail?: string };

// The run's report, recorded once. `evidence[i]` is the record the main
// thread published for the i-th applicability entry's evidence; `alpha[i]`
// what it did with the i-th Alpha exception proposal.
export function recordReport(tx: Tx, args: { run: string; evidence?: (string | null)[] | undefined; alpha?: AlphaPrepared[] | undefined }): void {
  const run = getRun(tx, args.run);
  if (!run) return;
  const flag = tx.db.prepare('SELECT "report_recorded", "result_value" FROM "runs" WHERE "id" = ?').get(run.id) as { report_recorded: number; result_value: string | null };
  if (flag.report_recorded === 1) return;
  tx.db.prepare('UPDATE "runs" SET "report_recorded" = 1 WHERE "id" = ?').run(run.id);
  const report = (parseJson<{ report?: Report }>(flag.result_value)?.report ?? {}) as Report;
  const item = workItemOfRun(tx, run);
  const subject = parseJson<{ candidate?: string }>(item.subject) ?? {};
  const candidate = subject.candidate ? getCandidate(tx.db, subject.candidate) : undefined;
  const role = run.role;
  const project = run.project;

  for (const f of report.findings ?? []) {
    const reported = (f.scope ?? 'candidate') as 'project' | 'lineage' | 'candidate';
    // D-1 (objection 209; Sean's ruling of 2026-10-23, errata E180; SEAM.md
    // §562): a role's finding raised by a run whose work names no source
    // candidate (a check_correction run, say) applies at project scope, so
    // that every evaluation reads it (D1 §9.3 (5)); a lineage or candidate
    // finding with no candidate would apply to none. The scope the role
    // reported and the reason are kept in its finding.raised. A Builder's
    // objection keeps its own route (D3 §5 X2; repair.ts recordObjections).
    const normalize = candidate === undefined && reported !== 'project' && !isObjection({ source_role: role, category: f.category });
    raiseFinding(tx, {
      project,
      scope: normalize ? 'project' : reported,
      ...(normalize ? { normalized: { reported_scope: reported, scope_reason: 'no_source_candidate' as const } } : {}),
      candidate: candidate?.id ?? null,
      run: run.id,
      role,
      category: f.category,
      severity: f.severity,
      message: f.message,
      sensitiveArea: f.sensitive_area ?? null,
      check: f.check ?? null,
      // The criterion it breaks (D3 §2.11), validated against the index
      // before the result was taken (invoke/choke.ts).
      criterion: f.criterion ?? null,
    });
  }

  // The phase sign-off (D6 §5.8; B06): a Verifier's on its phase_verification
  // work, bound to the candidate's acceptance hash, the effective protected
  // version, the spec revision and the plan's generation.
  if (role === 'verifier' && item.kind === 'phase_verification' && candidate) {
    const planId = parseJson<{ phase_plan?: string }>(item.subject)?.phase_plan ?? null;
    const plan = planId ? (tx.db.prepare('SELECT "id", "generation", "active", "status" FROM "phase_plans" WHERE "id" = ?').get(planId) as { id: string; generation: number; active: number; status: string } | undefined) : undefined;
    // A sign-off bound to a replaced plan generation or to a superseded
    // candidate is refused (D6 §5.8; B06; the driver's ruling 6): no
    // sign-off is recorded, the refusal is, and the work completes.
    const refusal = plan === undefined ? null : plan.active !== 1 || plan.status === 'replaced' ? 'plan_generation_replaced' : candidate.superseded_by ? 'candidate_superseded' : null;
    const reviewed = (tx.db.prepare('SELECT "content_hash" FROM "runs" WHERE "id" = ?').get(run.id) as { content_hash: string | null }).content_hash;
    const hash = reviewed ?? contentHash(tx.db, project, candidate);
    for (const s of (report.signoffs ?? []).filter((x) => x.scope === 'phase')) {
      if (!plan) continue;
      const spec = tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { id: string } | undefined;
      const binding = { acceptance_hash: hash, protected_version: effectiveVersion(tx.db, project)?.id ?? null, spec_revision: spec?.id ?? null, plan_generation: plan.generation };
      if (refusal !== null) {
        const active = tx.db.prepare(`SELECT "id", "generation" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" = 'published' ORDER BY rowid DESC LIMIT 1`).get(project) as { id: string; generation: number } | undefined;
        tx.emit('signoff.refused', { project, candidate: candidate.id, run: run.id, phase_plan: plan.id }, {
          scope: 'phase',
          binding,
          cause: refusal,
          ...(refusal === 'candidate_superseded' ? { superseded_by: candidate.superseded_by } : { active: active ? { phase_plan: active.id, generation: active.generation } : null }),
        });
        continue;
      }
      const id = tx.newId('so_');
      tx.db
        .prepare(
          `INSERT INTO "signoffs" ("id", "created_at", "project", "candidate", "revision", "role", "scope", "module", "run", "acceptance_content_hash", "recorded_at", "binding", "phase_plan")
           VALUES (?, ?, ?, ?, ?, 'verifier', 'phase', NULL, ?, ?, ?, ?, ?)`,
        )
        .run(id, tx.at, project, candidate.id, candidate.revision, run.id, hash, tx.at, JSON.stringify(binding), plan.id);
      tx.emit('signoff.recorded', { project, candidate: candidate.id, signoff: id, run: run.id }, { scope: 'phase', module: null, binding });
      void s;
    }
    // No phase sign-off: the work parks behind a blocker the owner sees (the
    // coordinator's ruling on the 31b review), never re-asked by the engine.
    // Unless the run's own findings explain it (the driver's ruling on real
    // loop run 3): each is owed to the owner now (noReviewComes (e)), the
    // work completes with no blocker of its own, and the phase asks its
    // Verifier again once they are settled (plan/phase.ts phaseStep).
    const signed = plan !== undefined && (report.signoffs ?? []).some((x) => x.scope === 'phase');
    // (A refused sign-off is not a missing one: the work completes, ruling 6.)
    if (!signed && item.status === 'executing') {
      if (raisedOpenFindings(tx.db, run.id)) askUndispositioned(tx, { project });
      else parkWork(tx, item, 'phase_signoff_missing', { run: run.id });
    }
  }

  if (role === 'reviewer' && candidate) {
    // A sign-off binds the content the run was given to review, fixed when it
    // was claimed; content that has changed since is not signed off (E41 item 4).
    const reviewed = (tx.db.prepare('SELECT "content_hash" FROM "runs" WHERE "id" = ?').get(run.id) as { content_hash: string | null }).content_hash;
    for (const s of report.signoffs ?? []) {
      const id = tx.newId('so_');
      tx.db
        .prepare(
          `INSERT INTO "signoffs" ("id", "created_at", "project", "candidate", "revision", "role", "scope", "module", "run", "acceptance_content_hash", "recorded_at")
           VALUES (?, ?, ?, ?, ?, 'reviewer', ?, ?, ?, ?, ?)`,
        )
        .run(id, tx.at, project, candidate.id, candidate.revision, s.scope, s.module ?? null, run.id, reviewed ?? contentHash(tx.db, project, candidate), tx.at);
      tx.emit('signoff.recorded', { project, candidate: candidate.id, signoff: id, run: run.id }, { scope: s.scope, module: s.module ?? null });
    }
    if ((report.signoffs ?? []).length > 0) markStale(tx, { candidate: candidate.id });
    // A review asked for the Alpha deployment's sign-off (alpha-review.ts;
    // real loop run 5) whose Reviewer signed none of what it was asked and
    // raised nothing: the deployment cannot be authorized and no engine role
    // will sign, so the work parks behind a blocker the owner sees (retry to
    // ask again), never a silent stall. Findings it raised take their own
    // route (askUndispositioned below).
    const unsigned = item.kind === 'review' ? alphaSignoffsUnsigned(tx.db, { workItem: item.id, candidate: candidate.id, reviewed: reviewed ?? contentHash(tx.db, project, candidate) }) : null;
    const raisedAny = tx.db.prepare('SELECT 1 FROM "findings" WHERE "source_run" = ? LIMIT 1').get(run.id) !== undefined;
    if (unsigned !== null && unsigned.length > 0 && !raisedAny && item.status === 'executing') {
      parkWork(tx, item, 'review_signoff_missing', { run: run.id, unsigned });
    }
  }

  if (role === 'reviewer') {
    const refusedFix = new Set<string>();
    for (const d of report.dispositions ?? []) {
      const f = findingOf(tx, d.finding);
      if (!f || f.project !== project || f.status === 'resolved') continue;
      // A Builder's objection is not dispositioned: the entry is invalid and
      // nothing is recorded for it (D3 §5 X2; slice 21 review, minor 2).
      if (isObjection(f as FindingRow & { source_role: string | null })) continue;
      const deferLow = d.disposition === 'defer' && f.effective_severity === 'low' && d.linked_issue && d.defer_target;
      // A `fix` targeted at the plan (D6 §5.7; the driver's ruling 2): valid
      // only on a Reviewer's own `contract_conflict`; any other entry with
      // the target is not one this engine takes, and records nothing.
      const reviewers = (f as FindingRow & { source_role: string | null }).source_role === 'reviewer';
      const planTarget = d.target === 'plan';
      if (planTarget && (d.disposition !== 'fix' || f.category !== 'contract_conflict' || !reviewers)) continue;
      // S1 (E172 item 7; Sean's direction that an agent never overrides the
      // owner's standing decision; SEAM.md §555): on a finding the human
      // owner has dispositioned, an entry the Reviewer's own authority would
      // record (any `fix`, plan-targeted or not, matching his or not; a Low
      // `defer`) is refused before anything else (H1's refusal included):
      // the finding is left exactly as he left it, nothing is registered,
      // and the attempt is recorded once per entry. The run is still
      // accepted. The proposals beyond a Reviewer's authority (`accept`, a
      // Medium `defer`) go on below: they never change the finding's
      // disposition. Either kind of entry, differing from his, asks him
      // once (askOwnerAgain); a matching one asks nothing.
      if (f.status === 'dispositioned' && f.disposition_authority === 'human' && (d.disposition === 'fix' || deferLow)) {
        tx.emit(
          'finding.disposition_refused',
          { project, finding: f.id, run: run.id },
          {
            reason: 'owner_decided',
            disposition: d.disposition,
            target: planTarget ? 'plan' : null,
            standing: { disposition: f.disposition, authority: 'human', by: (f as FindingRow & { disposition_by?: string | null }).disposition_by ?? null },
          },
        );
        // Sean's ruling of 2026-10-20 ("ask only if it differs"): a refused
        // entry that differs from his disposition asks him once.
        if (differsFromOwner(f, d)) askOwnerAgain(tx, f, d, run.id);
        continue;
      }
      if (planTarget) {
        recordDisposition(tx, f, { disposition: 'fix', authority: 'reviewer', by: run.id, linked_issue: d.linked_issue ?? null, defer_target: null, remediation: d.remediation ?? null, target: 'plan' });
        continue;
      }
      // H1 (E171 item 5; E166 item 4; Sean's ruling, option B; SEAM.md
      // §552): a Reviewer's own `fix` on a finding that names no check is
      // refused, the owner's verification rule (repair.ts findingVerifiable)
      // on the Reviewer's route: no check can ever show such a fix done, so
      // nothing is dispatched (no fix work, no check_correction work) and the
      // finding is left as it was, undispositioned. The refusal is recorded
      // once, with the finding's verification as the owed question states
      // it; the run is still accepted, and the owner's owed question
      // (disposition_owed, raised by askUndispositioned) stays his to answer.
      // A finding naming a check is not refused here, whether or not the
      // check can verify it (D3 §2.11's check_correction route, M235).
      if (d.disposition === 'fix' && f.check === null) {
        if (refusedFix.has(f.id)) continue;
        refusedFix.add(f.id);
        tx.emit('finding.fix_refused', { project, finding: f.id, run: run.id }, { reason: 'verification_missing', verification: findingVerification(tx.db, f) });
        continue;
      }
      if (d.disposition === 'fix' || deferLow) {
        recordDisposition(tx, f, { disposition: d.disposition, authority: 'reviewer', by: run.id, linked_issue: d.linked_issue ?? null, defer_target: d.defer_target ?? null, remediation: d.remediation ?? null });
        continue;
      }
      // The owner has already answered this (M546; INK2-2; D3 §2.11): a
      // proposal of the disposition the owner's own standing answer gave
      // asks nothing again. It is recorded against that answer; the
      // finding's disposition is unchanged.
      // A severity this same report changes (processed after the
      // dispositions, below) is a change since the owner's answer too: the
      // proposal does not stand on it (the review's finding 4).
      // A proposal beyond its authority (`accept`, a Medium `defer`) that
      // differs from the owner's standing disposition asks him once, keep or
      // change (S1; Sean's ruling of 2026-10-20; SEAM.md §555): never the
      // approve/reject of a proposal on a finding no one dispositioned.
      if (f.status === 'dispositioned' && f.disposition_authority === 'human' && differsFromOwner(f, d)) {
        askOwnerAgain(tx, f, d, run.id);
        continue;
      }
      const severityChanging = (report.severity_changes ?? []).some((c) => c.finding === f.id && c.to !== f.effective_severity);
      const standing = severityChanging ? null : standingOwnerAnswer(tx.db, f, d);
      if (standing !== null) {
        tx.emit('finding.proposal_standing', { project, finding: f.id, run: run.id }, { disposition: d.disposition, decision: standing.decision, standing_answer: standing });
        continue;
      }
      // Beyond a Reviewer's authority (F §6.2): the human owner decides.
      tx.db
        .prepare('UPDATE "findings" SET "proposed_disposition" = ? WHERE "id" = ?')
        .run(JSON.stringify({ disposition: d.disposition, linked_issue: d.linked_issue ?? null, defer_target: d.defer_target ?? null, run: run.id }), f.id);
      raiseQuestion(tx, { project, kind: 'finding_disposition', subjectType: 'finding', subjectId: f.id });
    }
  }

  if (role === 'reviewer' || role === 'verifier') {
    for (const c of report.severity_changes ?? []) {
      const f = findingOf(tx, c.finding);
      if (!f || f.project !== project || f.status === 'resolved' || c.to === f.effective_severity) continue;
      if (RANK[c.to]! > RANK[f.effective_severity]!) {
        // Any role may raise a severity (F §6.3).
        changeSeverity(tx, f, { to: c.to, actor: run.id, authority: role === 'reviewer' ? 'reviewer' : 'role' });
        continue;
      }
      if (role !== 'reviewer') continue;
      // Out of the blocking range, and any lowering from Critical (K7: a
      // stricter policy for a real agent): the human owner decides. The
      // Reviewer proposes; nothing it reports later applies it.
      if (f.effective_severity === 'critical' || (BLOCKING.includes(f.effective_severity) && !BLOCKING.includes(c.to))) {
        tx.db.prepare('UPDATE "findings" SET "proposed_severity_change" = ? WHERE "id" = ?').run(JSON.stringify({ to: c.to, run: run.id }), f.id);
        raiseQuestion(tx, { project, kind: 'severity_lower', subjectType: 'finding', subjectId: f.id });
        continue;
      }
      changeSeverity(tx, f, { to: c.to, actor: run.id, authority: 'reviewer' });
    }
  }

  if (role === 'verifier') {
    for (const [i, a] of (report.applicability ?? []).entries()) {
      const f = findingOf(tx, a.finding);
      const target = getCandidate(tx.db, a.candidate);
      const evidence = args.evidence?.[i] ?? null;
      if (!f || f.project !== project || !target || target.project !== project || evidence === null) continue;
      const id = tx.newId('appl_');
      tx.db
        .prepare(
          `INSERT INTO "applicability_assessments" ("id", "created_at", "project", "finding", "candidate", "proposed_by_run", "evidence", "reason", "status")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
        )
        .run(id, tx.at, project, f.id, target.id, run.id, evidence, a.reason);
      tx.emit('assessment.proposed', { project, assessment: id, finding: f.id, run: run.id }, { candidate: target.id });
    }
  }

  if (role === 'reviewer') {
    for (const a of report.assessments ?? []) {
      const row = tx.db.prepare('SELECT * FROM "applicability_assessments" WHERE "id" = ?').get(a.assessment) as
        | { id: string; project: string; finding: string; candidate: string; proposed_by_run: string; status: string }
        | undefined;
      if (!row || row.project !== project || row.status !== 'proposed' || row.proposed_by_run === run.id) continue;
      if (a.verdict === 'applicable') {
        tx.db.prepare(`UPDATE "applicability_assessments" SET "status" = 'rejected', "assessed_by_run" = ? WHERE "id" = ?`).run(run.id, row.id);
        tx.emit('assessment.rejected', { project, assessment: row.id, finding: row.finding, run: run.id }, {});
        continue;
      }
      tx.db.prepare(`UPDATE "applicability_assessments" SET "status" = 'assessed', "assessed_by_run" = ? WHERE "id" = ?`).run(run.id, row.id);
      tx.emit('assessment.assessed', { project, assessment: row.id, finding: row.finding, run: run.id }, { verdict: a.verdict });
      // An exclusion of a finding that would block a gate needs the human
      // owner's approval (E19).
      const f = findingOf(tx, row.finding)!;
      if (blocksAnyGate(f)) raiseQuestion(tx, { project, kind: 'finding_applicability_exclusion', subjectType: 'applicability_assessment', subjectId: row.id });
    }
  }

  // A Reviewer's approval of a tightening is a recommendation (K8, E13).
  if (role === 'reviewer' && report.proposal_approval) reviewerApprove(tx, { proposal: report.proposal_approval.proposal, run: run.id });

  // What the Reviewer left with no disposition is the owner's to decide, in
  // this transaction: never a gate held by a finding nothing will act on.
  if (role === 'reviewer' && item.kind === 'review' && item.trigger_source === 'verification') askUndispositioned(tx, { project, reviewing: true });

  // A Reviewer's Alpha exception proposals (D2 §5 C1): each is refused before
  // anything is raised, or becomes a finding_disposition question with the
  // option alpha_exception, its containment argument retained as claimed
  // evidence. What was refused is kept on the run.
  if (role === 'reviewer' && (report.alpha_exception_proposals ?? []).length > 0) {
    const outcomes: { finding: string; outcome: 'proposed' | 'refused'; reason: string | null; decision: string | null }[] = [];
    const reviewed = (tx.db.prepare('SELECT "content_hash" FROM "runs" WHERE "id" = ?').get(run.id) as { content_hash: string | null }).content_hash;
    for (const [i, p] of (report.alpha_exception_proposals ?? []).entries()) {
      const prepared = args.alpha?.[i];
      const f = findingOf(tx, p.finding);
      const reason = alphaRefusal(tx.db, f, project, candidate, reviewed) ?? (!prepared ? 'not_prepared' : 'refusal' in prepared ? prepared.refusal : null);
      if (reason !== null || !prepared || 'refusal' in prepared) {
        outcomes.push({ finding: p.finding, outcome: 'refused', reason: reason ?? 'not_prepared', decision: null });
        continue;
      }
      const proposed = {
        run: run.id,
        candidate: candidate!.id,
        // The acceptance content the Reviewer was given to review (E41 item 4),
        // which is the content in force (content_changed above).
        acceptance_content_hash: reviewed ?? contentHash(tx.db, project, candidate!),
        containment_evidence: prepared.record,
        testing_purpose: p.testing_purpose,
        at: tx.at,
      };
      tx.db.prepare('UPDATE "findings" SET "proposed_alpha_exception" = ? WHERE "id" = ?').run(JSON.stringify(proposed), f!.id);
      const d = raiseQuestion(tx, {
        project,
        kind: 'finding_disposition',
        subjectType: 'finding',
        subjectId: f!.id,
        scope: ALPHA_SCOPE,
        // D1 A.3: the argument is the agent's, retained as claimed evidence.
        evidence: [{ record: prepared.record, provenance: 'claimed' }],
      });
      outcomes.push({ finding: p.finding, outcome: d ? 'proposed' : 'refused', reason: d ? null : 'not_open_against_candidate', decision: d?.id ?? null });
    }
    tx.db.prepare('UPDATE "runs" SET "alpha_exception_outcomes" = ? WHERE "id" = ?').run(JSON.stringify(outcomes), run.id);
  }
}

// Never a silent stall (the driver's ruling on the real M443 run, widened on
// the real M444 run): an open finding with no disposition, no proposed
// disposition and no question about it is put to the owner as a
// finding_disposition question (scope disposition_owed) whenever no review
// will come to disposition it: the engine's review of its candidate has
// reported and left it with none, or this is that review's report
// (`reviewing`: every such finding of the project is owed); it names no
// candidate; its source is not a role whose findings a review dispositions
// (a Verifier's or a Reviewer's); its candidate's tier queues no engine
// review (gates.ts tierQueuesReview, the rule queueReview applies); it was
// raised by a phase verification; or its candidate's review has reported
// and no other is to come (noReviewComes). A
// Builder's objection takes the conflict route instead (repair.ts); a
// finding the owner has already answered a question about is as the owner
// left it. Returns the questions raised.
export function askUndispositioned(tx: Tx, args: { project: string; reviewing?: boolean }): number {
  const rows = tx.db
    .prepare(
      `SELECT f.*,
         EXISTS (SELECT 1 FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item"
           WHERE w."project" = f."project" AND w."kind" = 'review' AND w."trigger_source" = 'verification' AND w."trigger_id" = f."candidate"
             AND r."state" = 'ended' AND r."outcome" = 'completed' AND r."finished_at" IS NOT NULL AND r."finished_at" >= f."created_at") AS "reviewed_after"
       FROM "findings" f WHERE f."project" = ? AND f."status" = 'open' AND f."disposition" IS NULL AND f."proposed_disposition" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "decisions" d WHERE d."subject_type" = 'finding' AND d."subject_id" = f."id" AND d."status" = 'open')
         -- The owner has answered a question about it (a rejected proposal,
         -- M50): the finding is as the owner left it, never asked again.
         AND NOT EXISTS (SELECT 1 FROM "decisions" d WHERE d."kind" = 'finding_disposition' AND d."subject_id" = f."id" AND d."status" = 'consumed')
       ORDER BY f."seq"`,
    )
    .all(args.project) as (FindingRow & { source_role: string | null; reviewed_after: number })[];
  let n = 0;
  const version = effectiveVersion(tx.db, args.project)?.id ?? null;
  const reviewed = new Map<string, boolean | null>();
  for (const f of rows) {
    if (isObjection(f)) continue;
    if (!(args.reviewing === true || f.reviewed_after === 1 || noReviewComes(tx.db, f, version, reviewed))) continue;
    if (raiseQuestion(tx, { project: args.project, kind: 'finding_disposition', subjectType: 'finding', subjectId: f.id, scope: OWED_SCOPE })) n++;
  }
  // Recovery (the driver's ruling 5 on the real M444 run; queue.ts
  // reaskOwed): a finding the human accepted through the earlier owed
  // question while its severity blocks, with no other route open (no open
  // question about it, no proposed severity change), is asked once more
  // through the corrected question.
  const accepted = tx.db
    .prepare(
      `SELECT f.* FROM "findings" f WHERE f."project" = ? AND f."status" = 'dispositioned' AND f."disposition" = 'accept' AND f."disposition_authority" = 'human'
         AND f."effective_severity" IN ('critical', 'high') AND f."proposed_severity_change" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "decisions" d WHERE d."subject_type" = 'finding' AND d."subject_id" = f."id" AND d."status" = 'open')
       ORDER BY f."seq"`,
    )
    .all(args.project) as FindingRow[];
  for (const f of accepted) {
    if (!reaskOwed(tx.db, f)) continue;
    if (raiseQuestion(tx, { project: args.project, kind: 'finding_disposition', subjectType: 'finding', subjectId: f.id, scope: OWED_SCOPE })) n++;
  }
  return n;
}

// The roles whose findings the engine's review dispositions (F §6.2): a
// Verifier's, reported before the review, and a Reviewer's own.
const REVIEWED_SOURCES: readonly (string | null)[] = ['verifier', 'reviewer'];

// No review will come to disposition the finding (the driver's ruling on the
// real M444 run): (b) it names no candidate; (c) its source is not a role
// whose findings a review dispositions; (d) its candidate's tier queues no
// engine review under the effective version and no review work item of the
// candidate exists, in any state (objection 117 upheld, SEAM.md §466: the
// engine makes a candidate's review only by queueReview, so in production
// this is the tier alone; a review already put on the candidate keeps M42's
// and M50's meaning); (e) it was raised by a phase verification (D6 §5.8:
// the phase's Verifier runs once its stages are verified, their reviews
// done, and no review is queued for what it finds; D6-F02: "its findings
// disposition as any"); (f) its candidate's review has already reported: a
// review work item of the candidate is complete and none is still to come,
// so no later review sees the finding (the driver's ruling on real loop run
// 3: a phase Verifier's finding on a reviewed candidate held the phase with
// no question about it). Unknown is not "none": with no effective version
// or no candidate row the tier is unread, and the finding waits under (d)
// as before. `cache` holds each candidate's (d) and (f) answer for one sweep.
function noReviewComes(db: Tx['db'], f: FindingRow & { source_role: string | null }, version: string | null, cache: Map<string, boolean | null>): boolean {
  if (f.candidate === null) return true;
  if (!REVIEWED_SOURCES.includes(f.source_role)) return true;
  if (fromPhaseVerification(db, f.source_run)) return true;
  if (!cache.has(f.candidate)) {
    const c = getCandidate(db, f.candidate);
    const reviews = db
      .prepare(`SELECT "status", "trigger_source", "trigger_id" FROM "work_items" WHERE "project" = ? AND "kind" = 'review' AND json_extract("subject", '$.candidate') = ?`)
      .all(f.project, f.candidate) as { status: string; trigger_source: string; trigger_id: string }[];
    // The engine's own review (queueReview: trigger (verification, <candidate>)), as for reviewed_after.
    const reported =
      reviews.some((r) => r.status === 'complete' && r.trigger_source === 'verification' && r.trigger_id === f.candidate) && reviews.every((r) => r.status === 'complete' || r.status === 'cancelled');
    cache.set(f.candidate, reported ? false : c && version !== null ? reviews.length > 0 || tierQueuesReview(db, c, version) : null);
  }
  return cache.get(f.candidate) === false;
}

// Did the run raise a finding still open, its disposition owed (a
// Verifier's are never objections)?
function raisedOpenFindings(db: Tx['db'], run: string): boolean {
  return db.prepare(`SELECT 1 FROM "findings" WHERE "source_run" = ? AND "status" = 'open' AND "disposition" IS NULL LIMIT 1`).get(run) !== undefined;
}

// Was the finding raised by a phase_verification run (D6 §5.8)?
function fromPhaseVerification(db: Tx['db'], run: string | null): boolean {
  if (run === null) return false;
  return db.prepare(`SELECT 1 FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ? AND w."kind" = 'phase_verification'`).get(run) !== undefined;
}

// A later Reviewer's disposition differing from the owner's (S1; Sean's
// ruling of 2026-10-20; SEAM.md §555): one finding_disposition question,
// scope reviewer_disagrees, keep his or change. While one is open about the
// finding, a further differing entry raises nothing: the open question keeps
// its id and generation (it names the first Reviewer's run and entry).
// Nothing on the finding changes and nothing is registered until he answers.
function askOwnerAgain(
  tx: Tx,
  f: FindingRow,
  d: { disposition: 'fix' | 'defer' | 'accept'; linked_issue?: string; defer_target?: string; target?: string },
  run: string,
): void {
  const open = tx.db
    .prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'finding_disposition' AND "subject_type" = 'finding' AND "subject_id" = ? AND "scope" = ? AND "status" = 'open' LIMIT 1`)
    .get(f.id, REVIEWER_DISAGREES_SCOPE);
  if (open) return;
  raiseQuestion(tx, {
    project: f.project,
    kind: 'finding_disposition',
    subjectType: 'finding',
    subjectId: f.id,
    scope: REVIEWER_DISAGREES_SCOPE,
    options: reviewerDisagreesSeed(f, {
      disposition: d.disposition,
      linked_issue: d.linked_issue ?? null,
      defer_target: d.defer_target ?? null,
      target: d.target === 'plan' ? 'plan' : null,
      run,
    }),
  });
}

// The owner's standing answer a Reviewer's proposed disposition repeats
// (M546; INK2-2): the finding dispositioned by the human owner, as it
// stands, with the same disposition (and, for a deferral, the same target
// and issue). null for anything else, which is asked as before.
function standingOwnerAnswer(
  db: Tx['db'],
  f: FindingRow,
  d: { disposition: string; linked_issue?: string; defer_target?: string },
): { disposition: string; authority: 'human'; by: string | null; at: string | null; decision: string | null } | null {
  const row = f as FindingRow & { disposition_authority?: string | null; disposition_by?: string | null; disposition_at?: string | null; linked_issue?: string | null; defer_target?: string | null };
  if (row.status !== 'dispositioned' || row.disposition !== d.disposition || row.disposition_authority !== 'human') return null;
  if (d.disposition === 'defer' && ((row.defer_target ?? null) !== (d.defer_target ?? null) || (row.linked_issue ?? null) !== (d.linked_issue ?? null))) return null;
  // The answer as it was recorded: the latest `finding.dispositioned` of the
  // finding, by insertion (never by a wall-clock column).
  const recorded = db
    .prepare(`SELECT "seq", "tx" FROM "events" WHERE "type" = 'finding.dispositioned' AND json_extract("subject", '$.finding') = ? ORDER BY "seq" DESC LIMIT 1`)
    .get(f.id) as { seq: number; tx: string } | undefined;
  if (!recorded) return null;
  // Its severity changed since the answer: the owner answered about another
  // finding than the one now proposed on, and is asked again (the review's
  // finding 4).
  if (db.prepare(`SELECT 1 FROM "events" WHERE "type" = 'finding.severity_changed' AND json_extract("subject", '$.finding') = ? AND "seq" > ? LIMIT 1`).get(f.id, recorded.seq)) return null;
  // The owner's decision that recorded it: the finding_disposition question
  // about this finding consumed in the same transaction (the review's
  // finding 5); null when the answer was recorded by no decision.
  const decision = db
    .prepare(
      `SELECT json_extract(e."subject", '$.decision') AS "id" FROM "events" e
       WHERE e."tx" = ? AND e."type" = 'decision.consumed' AND json_extract(e."payload", '$.kind') = 'finding_disposition'
         AND json_extract(e."subject", '$.subject_type') = 'finding' AND json_extract(e."subject", '$.subject_id') = ?
       ORDER BY e."seq" DESC LIMIT 1`,
    )
    .get(recorded.tx, f.id) as { id: string | null } | undefined;
  return { disposition: row.disposition, authority: 'human', by: row.disposition_by ?? null, at: row.disposition_at ?? null, decision: decision?.id ?? null };
}

// The scope of the finding_disposition question an Alpha exception
// proposal raises, apart from a Reviewer's other dispositions of the finding.
export const ALPHA_SCOPE = 'alpha_exception';
