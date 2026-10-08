// What a Verifier's or Reviewer's run reports, recorded once its run is
// accepted (SEAM.md §§68, 74; D1 §§3.4, 9.4; F §§4.1, 6.1-6.3; E19): findings,
// sign-offs, dispositions, severity changes, applicability proposals and
// assessments, and a Reviewer's approval of a proposal. A role proposes;
// what is beyond its authority raises a decision for the human owner. Nothing
// a role reports changes a check state.

import { parseJson } from './common.js';
import { type CandidateRow, contentHash, getCandidate, markStale } from './evidence.js';
import { type FindingRow, findingApplies } from './gates.js';
import { reviewerApprove } from './classification.js';
import { blocksAnyGate, changeSeverity, raiseQuestion, recordDisposition } from './queue.js';
import { getRun } from './runs.js';
import type { Tx } from './tx.js';
import { getWorkItem } from './work.js';
import { isObjection } from './repair.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FINDING_CATEGORIES = ['defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene'] as const;
const RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const BLOCKING = ['critical', 'high'];

export interface Report {
  findings?: { category: string; severity: string; message: string; scope?: string; sensitive_area?: string; check?: string; criterion?: string }[];
  signoffs?: { scope: string; module?: string }[];
  dispositions?: { finding: string; disposition: 'fix' | 'defer' | 'accept'; linked_issue?: string; defer_target?: string }[];
  severity_changes?: { finding: string; to: string }[];
  applicability?: { finding: string; candidate: string; reason: string; evidence: string }[];
  assessments?: { assessment: string; verdict: 'not_applicable' | 'applicable' }[];
  proposal?: { rationale: string; requested_change_kind: string };
  proposal_approval?: { proposal: string; reason: string };
  alpha_exception_proposals?: { finding: string; containment_text: string; references: ({ path: string } | { record: string })[]; testing_purpose: string }[];
  // A Builder's objections to a check (D3 §5 X2, A.3), recorded with its
  // run's end (repair.ts).
  objections?: { check: string; criterion?: string; category: string; message: string }[];
}

const findingRowOf = (db: Tx['db'], id: string) => db.prepare('SELECT * FROM "findings" WHERE "id" = ?').get(id) as FindingRow | undefined;
const findingOf = (tx: Tx, id: string) => findingRowOf(tx.db, id);

// A finding is raised (D1 §3.4). `run` null: an engine-origin finding.
export function raiseFinding(
  tx: Tx,
  args: { project: string; scope: 'project' | 'lineage' | 'candidate'; candidate: string | null; run: string | null; role: string | null; category: string; severity: string; message: string; sensitiveArea?: string | null; check?: string | null; criterion?: string | null },
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
  tx.emit('finding.raised', { project: args.project, finding: id, run: args.run }, { scope: args.scope, category: args.category, severity: args.severity, candidate: args.candidate });
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
  const item = getWorkItem(tx, run.work_item)!;
  const subject = parseJson<{ candidate?: string }>(item.subject) ?? {};
  const candidate = subject.candidate ? getCandidate(tx.db, subject.candidate) : undefined;
  const role = run.role;
  const project = run.project;

  for (const f of report.findings ?? []) {
    const scope = (f.scope ?? 'candidate') as 'project' | 'lineage' | 'candidate';
    raiseFinding(tx, {
      project,
      scope,
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
  }

  if (role === 'reviewer') {
    for (const d of report.dispositions ?? []) {
      const f = findingOf(tx, d.finding);
      if (!f || f.project !== project || f.status === 'resolved') continue;
      // A Builder's objection is not dispositioned: the entry is invalid and
      // nothing is recorded for it (D3 §5 X2; slice 21 review, minor 2).
      if (isObjection(f as FindingRow & { source_role: string | null })) continue;
      const deferLow = d.disposition === 'defer' && f.effective_severity === 'low' && d.linked_issue && d.defer_target;
      if (d.disposition === 'fix' || deferLow) {
        recordDisposition(tx, f, { disposition: d.disposition, authority: 'reviewer', by: run.id, linked_issue: d.linked_issue ?? null, defer_target: d.defer_target ?? null });
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

// The scope of the finding_disposition question an Alpha exception
// proposal raises, apart from a Reviewer's other dispositions of the finding.
export const ALPHA_SCOPE = 'alpha_exception';
