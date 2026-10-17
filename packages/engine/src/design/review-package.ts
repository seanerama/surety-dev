// What a review-mode or retrofit-mode Designer session's package reads of
// the store (D7 §3.4, §10.2, §10.5, §12; SEAM.md §§523, 528): the review's
// subject; the approved design, if there is one; where the candidate's UI
// source is (every `ui` module's paths at the candidate's revision, or, in
// retrofit, at the adopted integration head); the latest result, on the
// candidate, of each check covering a design criterion; and the owner's
// evidence with the records holding it. A read: it decides nothing.

import type Database from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import { approvedModuleMap } from './policy.js';
import { designDueState } from './readiness.js';
import { ownerReviewOfRun } from './owner-review.js';

type Db = Database.Database;

export interface ReviewPackageFacts {
  mode: 'review' | 'retrofit';
  repo: string;
  review: { subject: Record<string, unknown>; design_revision: string | null; first_design: boolean; owner: boolean };
  // The approved revision's commit and its design tree's paths.
  approved: { revision: string; paths: string[] } | null;
  // The revision the UI source is read at and the ui modules' paths.
  source: { revision: string; candidate: string | null; paths: string[] } | null;
  check_results: { candidate: string | null; results: Record<string, unknown>[] };
  evidence: { id: string; provenance: string; format: string | null; target: string; observed_on: string | null; name: string | null; record: string | null; build_ref: string | null }[];
}

// The criterion ids of the approved design (by their text under their
// requirement, as the Builder's package matches them).
function designCriterionIds(db: Db, project: string, content: string | null): string[] {
  const criteria = parseJson<{ criteria?: { criteria?: { requirement?: string; text?: string }[] } }>(content)?.criteria?.criteria ?? [];
  const ids: string[] = [];
  for (const c of criteria) {
    const row = db.prepare('SELECT "criteria_text" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(project, c.requirement ?? '') as { criteria_text: string | null } | undefined;
    for (const t of parseJson<{ id: string; text: string }[]>(row?.criteria_text ?? null) ?? []) if (t.text.trim() === String(c.text ?? '').trim()) ids.push(t.id);
  }
  return [...new Set(ids)].sort();
}

export function reviewPackageFacts(db: Db, args: { run: string }): ReviewPackageFacts | null {
  const run = db.prepare('SELECT "project", "role", "session_notes" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; role: string; session_notes: string | null } | undefined;
  if (!run || run.role !== 'designer') return null;
  const project = run.project;
  const mode = parseJson<{ mode?: string }>(run.session_notes)?.mode ?? null;
  const p = db.prepare('SELECT "dev_repo_path", "integration_branch", "adoption" FROM "projects" WHERE "id" = ?').get(project) as { dev_repo_path: string; integration_branch: string; adoption: string | null };
  const approved = db
    .prepare(`SELECT "id", "revision", "blobs", "content" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { id: string; revision: string; blobs: string; content: string | null } | undefined;
  // Retrofit mode (D7 §12; SEAM.md §528): a Designer session on an adopted
  // project before any design is approved.
  const retrofit = mode !== 'review' && p.adoption !== null && !approved;
  if (mode !== 'review' && !retrofit) return null;
  const owner = mode === 'review' ? ownerReviewOfRun(db, args.run) : null;
  const due = designDueState(db, project);
  const subject: Record<string, unknown> = owner ? owner.subject : retrofit ? { kind: 'adopted_repository' } : ((due.review as Record<string, unknown> | undefined) ?? { kind: 'candidate' });
  const design_revision = owner ? owner.design_revision : (approved?.id ?? null);
  // The candidate the review is about: the Alpha's, or the one the owner
  // names where the project holds it.
  const named = typeof subject.candidate === 'string' ? (db.prepare('SELECT "id", "revision" FROM "candidates" WHERE "id" = ? AND "project" = ?').get(subject.candidate, project) as { id: string; revision: string } | undefined) : undefined;
  const head = (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project, `refs/heads/${p.integration_branch}`) as { expected_oid: string } | undefined)?.expected_oid ?? null;
  const map = approvedModuleMap(db, project)?.map ?? null;
  const uiPaths = (map?.modules ?? []).filter((m) => m.surface === 'ui').flatMap((m) => m.paths);
  const sourceAt = retrofit ? head : (named?.revision ?? null);
  const source = sourceAt !== null && uiPaths.length > 0 ? { revision: sourceAt, candidate: named?.id ?? null, paths: uiPaths } : null;
  // The design checks' latest results on the candidate (§10.2).
  const ids = new Set(designCriterionIds(db, project, approved?.content ?? null));
  const results: Record<string, unknown>[] = [];
  if (named && ids.size > 0) {
    const checks = db.prepare('SELECT DISTINCT c."id", c."key", c."criteria" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND r."candidate" = ?').all(project, named.id) as { id: string; key: string; criteria: string }[];
    const seen = new Set<string>();
    for (const c of checks.filter((x) => (parseJson<string[]>(x.criteria) ?? []).some((k) => ids.has(k))).sort((a, b) => a.key.localeCompare(b.key))) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const r = db
        .prepare(`SELECT r."id", r."exit_status", r."execution_seq", r."invalidated_at" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND r."candidate" = ? AND c."key" = ? ORDER BY r."execution_seq" DESC, r.rowid DESC LIMIT 1`)
        .get(project, named.id, c.key) as { id: string; exit_status: number | null; execution_seq: number; invalidated_at: string | null } | undefined;
      results.push({ check: c.id, key: c.key, criteria: (parseJson<string[]>(c.criteria) ?? []).filter((k) => ids.has(k)), result: r?.id ?? null, exit_status: r?.exit_status ?? null, ...(r?.invalidated_at ? { state: 'invalidated' } : {}) });
    }
  }
  const evidence = owner
    ? (db.prepare('SELECT "id", "provenance", "format", "target", "observed_on", "name", "record" FROM "design_evidence" WHERE "review" = ? AND "provenance" = \'owner_supplied\' ORDER BY rowid').all(owner.id) as ReviewPackageFacts['evidence']).map((e) => ({
        ...e,
        build_ref: typeof owner.subject.build_ref === 'string' ? owner.subject.build_ref : null,
      }))
    : [];
  return {
    mode: retrofit ? 'retrofit' : 'review',
    repo: p.dev_repo_path,
    review: { subject, design_revision, first_design: !approved, owner: owner !== null },
    approved: approved ? { revision: approved.revision, paths: Object.keys(parseJson<Record<string, string>>(approved.blobs) ?? {}).sort() } : null,
    source,
    check_results: { candidate: named?.id ?? null, results },
    evidence,
  };
}
