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
import { boundSubjectOfRun } from './review.js';
import { ownerReviewOfRun } from './owner-review.js';
import { currentInventory } from './store.js';
import { projectEffective } from '../store/transitions/settings.js';
import type { DesignCatalogueFacts, DesignChangeFacts, DesignerReadsFacts } from '../packages/design-reads.js';
import { lastUiPhase } from './approval.js';

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
  const subject: Record<string, unknown> = owner ? owner.subject : retrofit ? { kind: 'adopted_repository' } : (boundSubjectOfRun(db, args.run) ?? { kind: 'candidate', candidate: null, deployment: null });
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

// What every Designer session's package states of the project (D7 §3.4;
// M537; src/packages/design-reads.ts): the current inventory as recorded,
// and the policy values its elements name. null for a run that is not a
// Designer's.
export function designerReadsFacts(db: Db, args: { run: string }): DesignerReadsFacts | null {
  const run = db.prepare('SELECT "project", "role" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; role: string } | undefined;
  if (!run || run.role !== 'designer') return null;
  const inv = currentInventory(db, run.project);
  const options = projectEffective(db, run.project) as Record<string, unknown>;
  const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null);
  const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
  const digest = (db.prepare('SELECT "design_inventory_digest" AS d FROM "projects" WHERE "id" = ?').get(run.project) as { d: string | null } | undefined)?.d ?? null;
  return {
    inventory: inv?.inventory ?? null,
    inventory_digest: digest ?? inv?.inventory.inventory_digest ?? null,
    // The defaults are the inventory derivation's (policy.ts inventoryInputs).
    widths: nums(options.design_widths) ?? [360, 720, 1280],
    orientations: strs(options.design_orientations) ?? ['portrait', 'landscape'],
    allowlist: strs(options.design_external_urls) ?? [],
  };
}

// A design batch's change request, as its Spec Writer's package states it
// (D7 §7.1, §7.3; SEAM.md §486): the design's criteria and human tests, each
// human test with the phase that holds its target's last UI stage (null when
// none can be determined: never a guess). null for a request that is not a
// design's.
export function designChangeFacts(db: Db, request: string): DesignChangeFacts | null {
  const row = db.prepare('SELECT "project", "source" FROM "spec_change_requests" WHERE "id" = ?').get(request) as { project: string; source: string } | undefined;
  if (!row || row.source !== 'design') return null;
  const rev = db.prepare('SELECT "content" FROM "design_revisions" WHERE "spec_change_request" = ? ORDER BY rowid DESC LIMIT 1').get(request) as { content: string | null } | undefined;
  const content = parseJson<{ criteria?: { criteria?: Record<string, unknown>[]; human_tests?: Record<string, unknown>[] } }>(rev?.content ?? null);
  if (!content) return null;
  return {
    criteria: content.criteria?.criteria ?? [],
    human_tests: (content.criteria?.human_tests ?? []).map((h) => ({ ...h, phase: lastUiPhase(db, row.project, String(h.target)).phase })),
  };
}

// The design criteria a Verifier's authoring and correction packages state
// (D7 §7.2, §8.4; M537 (a2)): each criterion of the latest approved design's
// criteria.json, by its specification id (matched by its text under its
// requirement, as the Builder's package matches it), with its targets'
// technologies and the implemented paths it names. [] when no design is
// approved.
export function designCatalogueFacts(db: Db, project: string): DesignCatalogueFacts {
  const rev = db
    .prepare(`SELECT "content" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { content: string | null } | undefined;
  const content = parseJson<{ criteria?: { criteria?: Record<string, unknown>[] } }>(rev?.content ?? null);
  const inv = currentInventory(db, project)?.inventory ?? null;
  const techOf = (t: string): string | null => inv?.targets.find((x) => x.target === t)?.ui_technology ?? null;
  const out: DesignCatalogueFacts['criteria'] = [];
  for (const c of content?.criteria?.criteria ?? []) {
    const row = db.prepare('SELECT "criteria_text" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(project, String(c.requirement ?? '')) as { criteria_text: string | null } | undefined;
    const match = (parseJson<{ id: string; text: string }[]>(row?.criteria_text ?? null) ?? []).find((t) => t.text.trim() === String(c.text ?? '').trim());
    if (!match) continue;
    const targets = Array.isArray(c.targets) ? (c.targets as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const technologies = [...new Set(targets.map(techOf).filter((x): x is string => x !== null))];
    out.push({
      id: match.id,
      kind: String(c.kind),
      targets,
      ...(technologies.length > 0 ? { technologies } : {}),
      paths: Array.isArray(c.paths) ? (c.paths as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      ...(typeof c.slot === 'string' ? { slot: c.slot } : {}),
      ...(typeof c.variant === 'string' ? { variant: c.variant } : {}),
    });
  }
  return { criteria: out };
}
