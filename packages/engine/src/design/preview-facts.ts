// What the design preview reads of the store (D7 §5.7; SEAM.md §§488, 499):
// the project's repository, the revision asked for resolved to a commit,
// its preview policy and each UI target's technology.

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { notFound } from '../store/transitions/common.js';
import { projectEffective } from '../store/transitions/settings.js';
import { approvedModuleMap, designPolicyOf } from './policy.js';

export interface PreviewFacts {
  repo: string;
  revision: string;
  asked: string;
  design_preview: string;
  targets: { target: string; technology: string }[];
}

// `revision`: `checkpoint` (the newest checkpoint the design check read),
// `approved` (the newest approved design revision) or a commit.
export function previewFacts(db: Database.Database, args: { project: string; revision?: string | null }): PreviewFacts {
  const proj = db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string } | undefined;
  if (!proj) throw notFound('project', args.project);
  if (designPolicyOf(db, args.project) === 'off') {
    throw new Refusal(409, 'design_off', 'This project has no design (policy design: off): there is nothing to preview.', 'Turn the design on (surety project policy) first.', { project: args.project });
  }
  const preview = String((projectEffective(db, args.project) as Record<string, unknown>).design_preview ?? 'static');
  if (preview === 'off') throw new Refusal(409, 'design_preview_off', 'The design preview is off for this project (policy design_preview: off).', 'Set design_preview to static to preview the design.', { project: args.project });
  const asked = args.revision ?? 'checkpoint';
  let revision: string | null = null;
  if (asked === 'checkpoint') {
    revision =
      (db.prepare(`SELECT "tree_revision" FROM "design_checks" WHERE "project" = ? ORDER BY ("outcome" = 'passed') DESC, rowid DESC LIMIT 1`).get(args.project) as { tree_revision: string } | undefined)?.tree_revision ?? null;
    if (revision === null) throw new Refusal(404, 'not_found', 'No design checkpoint of this project has been saved.', 'Save the Designer session first, or name --revision approved.', { project: args.project, revision: asked });
  } else if (asked === 'approved') {
    revision =
      (db.prepare(`SELECT "revision" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(args.project) as { revision: string } | undefined)
        ?.revision ?? null;
    if (revision === null) throw new Refusal(404, 'not_found', 'No design revision of this project is approved.', 'Name --revision checkpoint, or approve a design first.', { project: args.project, revision: asked });
  } else if (/^[0-9a-f]{40}$/.test(asked)) {
    const known =
      db.prepare('SELECT 1 FROM "design_checks" WHERE "project" = ? AND "tree_revision" = ?').get(args.project, asked) ??
      db.prepare('SELECT 1 FROM "design_revisions" WHERE "project" = ? AND "revision" = ?').get(args.project, asked);
    if (!known) throw new Refusal(404, 'not_found', `${asked} is not a checkpoint or design revision of this project.`, 'Name checkpoint, approved, or a commit the design check read.', { project: args.project, revision: asked });
    revision = asked;
  } else {
    throw new Refusal(400, 'invalid_value', 'revision must be checkpoint, approved or a 40-character commit.', 'Send {"revision": "checkpoint"}.', { field: 'revision' });
  }
  const map = approvedModuleMap(db, args.project)?.map ?? null;
  const targets = (map?.modules ?? []).filter((m) => m.surface === 'ui').flatMap((m) => (m.targets ?? []).map((t) => ({ target: t.target, technology: t.ui_technology })));
  return { repo: proj.dev_repo_path, revision, asked, design_preview: preview, targets };
}
