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
        optString(f.check),
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
};

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
