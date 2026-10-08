// The fields a Verifier's or Reviewer's structured result may carry beside
// `status`, `summary`, `checkpoint` and `nominate` (SEAM.md §68). Each, if
// present, must have its form; anything else there makes the result
// invalid. Which role may send which field, and what the engine records of
// it, is the store's (store/transitions/findings.ts).

import type { Report } from '../store/transitions/findings.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CATEGORIES = ['defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene'];
const CHANGE_KINDS = ['tightening', 'loosening', 'unclassifiable'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const optString = (v: unknown) => v === undefined || isString(v);
const isTime = (v: unknown) => isString(v) && !Number.isNaN(Date.parse(v));
const listOf = (v: unknown, each: (x: Record<string, unknown>) => boolean): boolean => Array.isArray(v) && v.every((x) => isObject(x) && each(x));

const FORMS: Record<keyof Report, (v: unknown) => boolean> = {
  findings: (v) =>
    listOf(
      v,
      (f) =>
        CATEGORIES.includes(f.category as string) &&
        SEVERITIES.includes(f.severity as string) &&
        isString(f.message) &&
        (f.scope === undefined || ['candidate', 'lineage', 'project'].includes(f.scope as string)) &&
        optString(f.sensitive_area) &&
        optString(f.check) &&
        optString(f.criterion),
    ),
  signoffs: (v) => listOf(v, (s) => ['candidate', 'module', 'security'].includes(s.scope as string) && optString(s.module)),
  dispositions: (v) =>
    listOf(
      v,
      (d) => isString(d.finding) && ['fix', 'defer', 'accept'].includes(d.disposition as string) && optString(d.linked_issue) && (d.defer_target === undefined || isTime(d.defer_target)),
    ),
  severity_changes: (v) => listOf(v, (c) => isString(c.finding) && SEVERITIES.includes(c.to as string)),
  applicability: (v) => listOf(v, (a) => isString(a.finding) && isString(a.candidate) && isString(a.reason) && isString(a.evidence)),
  assessments: (v) => listOf(v, (a) => isString(a.assessment) && ['not_applicable', 'applicable'].includes(a.verdict as string)),
  proposal: (v) => isObject(v) && isString(v.rationale) && CHANGE_KINDS.includes(v.requested_change_kind as string),
  proposal_approval: (v) => isObject(v) && isString(v.proposal) && isString(v.reason),
  // D2 §5 C1, A.3: a Reviewer's Alpha exception proposals. A reference is a
  // workspace path at the reviewed revision or a record, given as
  // {"path": <relative path>} or {"record": <record id>}.
  alpha_exception_proposals: (v) =>
    listOf(
      v,
      (p) =>
        isString(p.finding) &&
        isString(p.containment_text) &&
        isString(p.testing_purpose) &&
        Array.isArray(p.references) &&
        p.references.every((r) => isObject(r) && Object.keys(r).length === 1 && ((isString(r.path) && r.path.length > 0) || (isString(r.record) && r.record.length > 0))),
    ),
  // D3 §5 X2, A.3: a Builder's objections to a check. Whether an entry
  // names a check and criterion of the project that concern the run's work
  // is the store's (store/transitions/repair.ts): an entry that does not is
  // dropped, and the result stands.
  objections: (v) =>
    listOf(v, (o) => isString(o.check) && optString(o.criterion) && ['contract_conflict', 'requirement_conflict'].includes(o.category as string) && isString(o.message)),
};

// Not built: objections from any role but the Builder; a Verifier reports a
// conflict as a finding of category requirement_conflict or contract_conflict.
// Fields only one role may send: carried by another role's result, they make
// it invalid (D2 §5 C1: an Alpha exception proposal is a Reviewer's; D3 §5
// X2: an objection is a Builder's).
const ROLE_ONLY: Record<string, string> = { alpha_exception_proposals: 'reviewer', objections: 'builder' };

// Fields no role's result may carry: no role registers a check execution or
// records a result (D3 §2.5; SEAM.md §180).
const REFUSED_FIELDS = ['check_results', 'check_executions', 'check_result', 'check_execution'];

export function fieldAllowed(result: Record<string, unknown>, role: string): boolean {
  if (REFUSED_FIELDS.some((f) => result[f] !== undefined)) return false;
  return Object.entries(ROLE_ONLY).every(([field, only]) => result[field] === undefined || role === only);
}

// The report a result carries: {} when it carries none, null when a field
// has the wrong form.
export function parseReport(result: Record<string, unknown>): Report | null {
  const report: Record<string, unknown> = {};
  for (const [key, form] of Object.entries(FORMS)) {
    if (result[key] === undefined) continue;
    if (!form(result[key])) return null;
    report[key] = result[key];
  }
  return report as Report;
}
