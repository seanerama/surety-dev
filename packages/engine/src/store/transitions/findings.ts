// What a Verifier's or Reviewer's run reports, recorded once its run is
// accepted (SEAM.md §§68, 74; D1 §§3.4, 9.4; F §§4.1, 6.1-6.3; E19): findings,
// sign-offs, dispositions, severity changes, applicability proposals and
// assessments, and a Reviewer's approval of a proposal. A role proposes;
// what is beyond its authority raises a decision for the human owner. Nothing
// a role reports changes a check state.

import { parseJson } from './common.js';
import { contentHash, getCandidate, markStale } from './evidence.js';
import type { FindingRow } from './gates.js';
import { reviewerApprove } from './protected.js';
import { blocksAnyGate, changeSeverity, raiseQuestion, recordDisposition } from './queue.js';
import { getRun } from './runs.js';
import type { Tx } from './tx.js';
import { getWorkItem } from './work.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FINDING_CATEGORIES = ['defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene'] as const;
const RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const BLOCKING = ['critical', 'high'];

export interface Report {
  findings?: { category: string; severity: string; message: string; scope?: string; sensitive_area?: string; check?: string }[];
  signoffs?: { scope: string; module?: string }[];
  dispositions?: { finding: string; disposition: 'fix' | 'defer' | 'accept'; linked_issue?: string; defer_target?: string }[];
  severity_changes?: { finding: string; to: string }[];
  applicability?: { finding: string; candidate: string; reason: string; evidence: string }[];
  assessments?: { assessment: string; verdict: 'not_applicable' | 'applicable' }[];
  proposal?: { rationale: string; requested_change_kind: string };
  proposal_approval?: { proposal: string; reason: string };
}

const findingOf = (tx: Tx, id: string) => tx.db.prepare('SELECT * FROM "findings" WHERE "id" = ?').get(id) as FindingRow | undefined;

// A finding is raised (D1 §3.4). `run` null: an engine-origin finding.
export function raiseFinding(
  tx: Tx,
  args: { project: string; scope: 'project' | 'lineage' | 'candidate'; candidate: string | null; run: string | null; role: string | null; category: string; severity: string; message: string; sensitiveArea?: string | null; check?: string | null },
): string {
  const id = tx.newId('fnd_');
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "findings" WHERE "project" = ?').get(args.project) as { n: number };
  tx.db
    .prepare(
      `INSERT INTO "findings" ("id", "created_at", "project", "seq", "scope", "subject_id", "candidate", "source_run", "source_role", "category", "message", "check",
         "proposed_severity", "effective_severity", "severity_history", "sensitive_area", "status", "reevaluations")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'open', '[]')`,
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
    );
  tx.emit('finding.raised', { project: args.project, finding: id, run: args.run }, { scope: args.scope, category: args.category, severity: args.severity, candidate: args.candidate });
  markStale(tx, { project: args.project });
  return id;
}

// The run's report, recorded once. `evidence[i]` is the record the main
// thread published for the i-th applicability entry's evidence.
export function recordReport(tx: Tx, args: { run: string; evidence?: (string | null)[] | undefined }): void {
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
      if (BLOCKING.includes(f.effective_severity) && !BLOCKING.includes(c.to)) {
        // Out of the blocking range: the human owner decides.
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

  // Only a Reviewer approves a proposal, and only a tightening (E13).
  if (role === 'reviewer' && report.proposal_approval) reviewerApprove(tx, { proposal: report.proposal_approval.proposal, run: run.id });
}
