// What the design preview reads of the store (D7 §5.7; SEAM.md §§488, 499):
// the project's repository, the revision asked for resolved to a commit,
// its preview policy and each UI target's technology.

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { notFound } from '../store/transitions/common.js';
import { projectEffective } from '../store/transitions/settings.js';
import { adapterQualified } from '../store/transitions/deploy.js';
import { approvedModuleMap, designPolicyOf } from './policy.js';

export interface PreviewFacts {
  repo: string;
  revision: string;
  asked: string;
  design_preview: string;
  targets: { target: string; technology: string }[];
}

// Why a preview cannot be made (D7 §5.7, A.6; SEAM.md §499): 409
// `design_preview_unavailable`, its `subject.cause` one of `design_off`,
// `design_preview_off`, `no_design_revision`, `adapter_unqualified`.
export function previewUnavailable(project: string, cause: string, reason: string, whatToDo: string): Refusal {
  return new Refusal(409, 'design_preview_unavailable', reason, whatToDo, { project, cause });
}

// The design revision a preview or an export names, as a commit (SEAM.md
// §§499, 501): `checkpoint` (the newest Designer save's checkpoint by
// insertion, whatever its design check's outcome: D7 §1 step 5a and §5.7
// preview "the checkpoint" the owner is working on, not the newest that
// passed), `approved` (the newest approved design revision) or a commit
// either names. null: there is none of that kind.
export function designRevisionOf(db: Database.Database, project: string, asked: string): string | null {
  if (asked === 'checkpoint') {
    return (db.prepare(`SELECT "tree_revision" FROM "design_checks" WHERE "project" = ? ORDER BY rowid DESC LIMIT 1`).get(project) as { tree_revision: string } | undefined)?.tree_revision ?? null;
  }
  if (asked === 'approved') {
    return (
      (db.prepare(`SELECT "revision" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as { revision: string } | undefined)?.revision ?? null
    );
  }
  if (/^[0-9a-f]{40}$/.test(asked)) {
    const known =
      db.prepare('SELECT 1 FROM "design_checks" WHERE "project" = ? AND "tree_revision" = ?').get(project, asked) ??
      db.prepare('SELECT 1 FROM "design_revisions" WHERE "project" = ? AND "revision" = ?').get(project, asked);
    if (!known) throw new Refusal(404, 'not_found', `${asked} is not a checkpoint or design revision of this project.`, 'Name checkpoint, approved, or a commit the design check read.', { project, revision: asked });
    return asked;
  }
  throw new Refusal(400, 'invalid_value', 'revision must be checkpoint, approved or a 40-character commit.', 'Send {"revision": "checkpoint"}.', { field: 'revision' });
}

// The approved module map's UI targets with their technologies: the
// engine's facts for each mockup's capability (preview-mockups.ts).
function uiTargets(db: Database.Database, project: string): { target: string; technology: string }[] {
  const map = approvedModuleMap(db, project)?.map ?? null;
  return (map?.modules ?? []).filter((m) => m.surface === 'ui').flatMap((m) => (m.targets ?? []).map((t) => ({ target: t.target, technology: t.ui_technology })));
}

export function previewFacts(db: Database.Database, args: { project: string; revision?: string | null }): PreviewFacts {
  const proj = db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string } | undefined;
  if (!proj) throw notFound('project', args.project);
  if (designPolicyOf(db, args.project) === 'off') {
    throw previewUnavailable(args.project, 'design_off', 'This project has no design (policy design: off): there is nothing to preview.', 'Turn the design on (surety project policy) first.');
  }
  const preview = String((projectEffective(db, args.project) as Record<string, unknown>).design_preview ?? 'static');
  if (preview === 'off') throw previewUnavailable(args.project, 'design_preview_off', 'The design preview is off for this project (policy design_preview: off).', 'Set design_preview to static to preview the design, or export it with surety design export.');
  const asked = args.revision ?? 'checkpoint';
  const revision = designRevisionOf(db, args.project, asked);
  if (revision === null) {
    throw previewUnavailable(
      args.project,
      'no_design_revision',
      asked === 'approved' ? 'No design revision of this project is approved, so there is nothing to preview.' : 'No Designer session of this project has saved a design checkpoint, so there is nothing to preview (the interface inventory is not a design).',
      'Save a Designer session first, or name another revision.',
    );
  }
  if (!adapterQualified(db, 'local_service')) {
    throw previewUnavailable(args.project, 'adapter_unqualified', 'The local_service adapter has no current qualification on this host, so the preview cannot be deployed.', 'Qualify it (surety qualify-adapter local_service), or export the design with surety design export.');
  }
  return { repo: proj.dev_repo_path, revision, asked, design_preview: preview, targets: uiTargets(db, args.project) };
}

// What an export reads (SEAM.md §501): the repository and the revision as
// a commit. No adapter, policy or qualification: an export always works.
export function exportFacts(db: Database.Database, args: { project: string; revision?: string | null }): { repo: string; revision: string; targets: { target: string; technology: string }[] } {
  const proj = db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string } | undefined;
  if (!proj) throw notFound('project', args.project);
  const asked = args.revision ?? 'checkpoint';
  const revision = designRevisionOf(db, args.project, asked);
  if (revision === null) throw new Refusal(404, 'not_found', `This project has no ${asked === 'approved' ? 'approved design revision' : 'design checkpoint'} to export.`, 'Name another revision.', { project: args.project, revision: asked });
  return { repo: proj.dev_repo_path, revision, targets: uiTargets(db, args.project) };
}
