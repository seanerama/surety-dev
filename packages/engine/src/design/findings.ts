// A Designer's findings (D7 §3.3, §3.5, §4.5; B.12; SEAM.md §491). An
// interface, target, permission or requirement the design needs and the
// inventory lacks is not the Designer's to add: the role reports a finding
// in its turn's result, and at that turn's settlement the engine records it
// and routes it to the owner. A `contract_conflict` (naming an interface)
// asks the owner to change the specification or to take it to an Architect
// session; a `requirement_conflict` (naming a requirement) asks for a
// specification change (D6 §4.2). D3 X2's `correct_check`, `retry` and
// `cancel` have nothing to act on here and are not offered (objection 130,
// E157 item 5). The session goes on meanwhile; a design_approval whose
// screens use an interface an open finding disputes is blocked
// DESIGN_INTERFACE_DISPUTED (approval.ts).
//
// The question is a `finding_disposition` decision (its kind table is
// closed) about a `design_finding` subject, under the scope
// `design_conflict`, so no question about a D3 finding is ever mistaken for
// it nor it for one.

import type Database from 'better-sqlite3';

import { notFound } from '../store/transitions/common.js';
import type { DecisionRow } from '../store/transitions/decisions.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import { type KindSpec, type Subject, consumed, raiseQuestion, recordApproval } from '../store/transitions/queue.js';
import type { Tx } from '../store/transitions/tx.js';
import { requestSpecChange } from '../spec/change.js';

type Db = Database.Database;

export const DESIGN_CONFLICT_SCOPE = 'design_conflict';

export interface DesignFindingInput {
  category: string;
  severity: string;
  message: string;
  interface?: string;
  requirement?: string;
}

interface FindingRow {
  id: string;
  project: string;
  seq: number;
  run: string;
  turn: number;
  category: 'requirement_conflict' | 'contract_conflict' | 'defect';
  severity: string;
  message: string;
  interface: string | null;
  requirement: string | null;
  status: 'open' | 'routed' | 'recorded';
  decision: string | null;
  route: string | null;
}

const findingRow = (db: Db, id: string): FindingRow | undefined => db.prepare('SELECT * FROM "design_findings" WHERE "id" = ?').get(id) as FindingRow | undefined;

const subjectOf = (f: { interface?: string | null; requirement?: string | null }): string =>
  f.interface ? `the interface ${f.interface}` : f.requirement ? `requirement ${f.requirement}` : 'no named interface or requirement';

// The findings of one settled Designer turn: each recorded; each conflict
// routed to its owner question. Returns the engine's entry for the turn
// (what the session is told), or null when there were none.
export function recordDesignFindings(tx: Tx, args: { project: string; run: string; turn: number; findings: DesignFindingInput[] }): string | null {
  if (args.findings.length === 0) return null;
  const lines: string[] = [];
  for (const f of args.findings) {
    const { seq } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "design_findings" WHERE "project" = ?').get(args.project) as { seq: number };
    const id = tx.newId('dfnd_');
    const conflict = f.category === 'contract_conflict' || f.category === 'requirement_conflict';
    tx.db
      .prepare(
        `INSERT INTO "design_findings" ("id", "created_at", "project", "seq", "run", "turn", "category", "severity", "message", "interface", "requirement", "status")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tx.at, args.project, seq, args.run, args.turn, f.category, f.severity, f.message, f.interface ?? null, f.requirement ?? null, conflict ? 'open' : 'recorded');
    if (!conflict) {
      lines.push(`Your ${f.category} finding about ${subjectOf(f)} is recorded; the engine routes only contract and requirement conflicts to the owner.`);
      continue;
    }
    const d = raiseQuestion(tx, { project: args.project, kind: 'finding_disposition', subjectType: 'design_finding', subjectId: id, scope: DESIGN_CONFLICT_SCOPE });
    if (d) tx.db.prepare('UPDATE "design_findings" SET "decision" = ? WHERE "id" = ?').run(d.id, id);
    const routes = f.category === 'contract_conflict' ? 'a specification change or an Architect session' : 'a specification change';
    lines.push(
      `Your ${f.category} finding about ${subjectOf(f)} is the owner's to route (${routes}${d ? `, question ${d.id}` : ''}): the inventory is not changed by a design. Go on with the design meanwhile; it cannot be approved while the finding is open against an interface its screens use.`,
    );
  }
  return lines.join('\n');
}

// The interfaces an open finding of the project disputes.
export function disputedInterfaces(db: Db, project: string): string[] {
  return (db.prepare(`SELECT DISTINCT "interface" FROM "design_findings" WHERE "project" = ? AND "status" = 'open' AND "interface" IS NOT NULL ORDER BY "interface"`).all(project) as { interface: string }[]).map((r) => r.interface);
}

function manifestOf(f: FindingRow): Record<string, unknown> {
  // finding_disposition's keys (queue.ts MANIFEST_KEYS), as they read for a
  // design finding: no candidate, no disposition, no check.
  return {
    finding_status: f.status,
    disposition: null,
    proposed_disposition: null,
    effective_severity: f.severity,
    sensitive_area: null,
    evidence: null,
    scope: DESIGN_CONFLICT_SCOPE,
    defer_target: null,
    linked_issue: null,
    applicable: null,
    candidate_revision: null,
    acceptance_content_hash: null,
    policy_revision: null,
    design_finding: f.id,
    category: f.category,
    interface: f.interface,
    requirement: f.requirement,
  };
}

export const DESIGN_CONFLICT: KindSpec = {
  preview(tx, d: Subject) {
    const f = findingRow(tx.db, d.subject_id);
    if (!f || f.status !== 'open') return null;
    const subject = subjectOf(f);
    const options = [
      {
        key: 'change_spec',
        label: 'Change the specification',
        consequence: `A specification change request is made from the finding ("${f.message}"), about ${subject}; nothing of the specification changes until you approve its proposal. The finding is routed and no longer blocks the design's approval; the inventory is derived again when the change is approved, and a design drawn against the old one is then refused DESIGN_INVENTORY_STALE at its next save.`,
        effect: { design_finding: f.id, register: 'spec_change' },
      },
      ...(f.category === 'contract_conflict'
        ? [
            {
              key: 'architect',
              label: 'Take it to an Architect session',
              consequence: `The finding is routed to the architecture: open an Architect session (surety session open --role architect) once the Designer session has closed, to give ${subject} what the design needs; the architecture's approval re-derives the inventory. Nothing is opened for you, and the finding no longer blocks the design's approval.`,
              effect: { design_finding: f.id, route: 'architect' },
            },
          ]
        : []),
    ];
    return {
      manifest: manifestOf(f),
      options,
      question: `The Designer reported a ${f.category} (${f.severity}) about ${subject}: ${f.message} The design cannot honour it without ${f.category === 'contract_conflict' ? 'a change to the specification or the architecture' : 'a change to the specification'}; how is it routed?`,
      evidence: { design_finding: f.id, run: f.run, turn: f.turn } as never,
    };
  },
  manifest(tx, d) {
    const f = findingRow(tx.db, d.subject_id);
    return f ? manifestOf(f) : {};
  },
  reraise: false,
  answer(tx, d: DecisionRow, option) {
    const f = findingRow(tx.db, d.subject_id);
    if (!f) throw notFound('design_finding', d.subject_id);
    consumeDecision(tx, d, option, null);
    let request: string | null = null;
    if (option === 'change_spec') {
      const made = requestSpecChange(tx, { project: f.project, text: `A Designer's ${f.category} about ${subjectOf(f)} (finding ${f.id}): ${f.message}`, record: null });
      request = ((made.body as { request?: { id?: string } }).request?.id as string | undefined) ?? null;
    }
    recordApproval(tx, d, { consequence: `design finding ${f.id} routed to ${option === 'change_spec' ? `a specification change${request ? ` (${request})` : ''}` : 'an Architect session'}`, subjectType: 'design_finding', subjectId: f.id });
    tx.db.prepare(`UPDATE "design_findings" SET "status" = 'routed', "route" = ?, "spec_change_request" = ?, "routed_at" = ? WHERE "id" = ?`).run(option, request, tx.at, f.id);
    return consumed(d, [{ kind: 'tick' }]);
  },
};
