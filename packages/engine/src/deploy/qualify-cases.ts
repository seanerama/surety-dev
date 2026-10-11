// D4 §2.6's cases of an adapter qualification, in D4 A.2's order
// (AdapterQualificationCase; SEAM.md §323), and a case's result (CaseResult).
export const ADAPTER_QUALIFICATION_CASES = ['deploy_read_back', 'replace', 'receipt_lost', 'not_issued', 'late_launcher', 'out_of_band', 'unreadable', 'refused', 'teardown'] as const;
export type AdapterQualificationCase = (typeof ADAPTER_QUALIFICATION_CASES)[number];
export const CASE_RESULTS = ['passed', 'failed', 'not_exercised'] as const;
export type CaseResult = (typeof CASE_RESULTS)[number];
