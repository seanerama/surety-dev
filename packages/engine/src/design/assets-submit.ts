// `surety design assets submit --project <p>` (D7 §6.4; SEAM.md §487): the
// assets the owner held at an approval, submitted for approval on their own.
// An asset-only design revision is proposed from the approved one, every
// slot it holds still proposed now unheld, and a design_approval raised
// alone, with no specification change. Approved, the effective set moves to
// the new slot@version (approval.ts), the bound paths get an asset_updated
// fix and every check reading the slot owes a result of it.

import { Refusal } from '../refusal.js';
import { parseJson } from '../store/transitions/common.js';
import type { CommandResult } from '../store/transitions/control.js';
import type { Tx } from '../store/transitions/tx.js';
import { type DesignContent, type RevisionRow, proposeDesign } from './approval.js';

export function submitAssets(tx: Tx, args: { project: string }): CommandResult {
  const approved = tx.db
    .prepare(`SELECT * FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`)
    .get(args.project) as RevisionRow | undefined;
  if (!approved) throw new Refusal(409, 'no_approved_design', 'This project has no approved design whose assets could be submitted.', 'Approve a design first.', { project: args.project });
  const held = parseJson<string[]>(approved.assets_held) ?? [];
  if (held.length === 0) throw new Refusal(409, 'no_assets_held', `Design version ${approved.version} holds no proposed asset: there is nothing to submit.`, 'Hold an asset at an approval, then submit it here.', { project: args.project, design_revision: approved.id });
  const open = tx.db
    .prepare(`SELECT d."id" FROM "decisions" d JOIN "design_revisions" r ON r."id" = d."subject_id" WHERE d."kind" = 'design_approval' AND d."status" = 'open' AND r."project" = ? LIMIT 1`)
    .get(args.project) as { id: string } | undefined;
  if (open) throw new Refusal(409, 'decision_open', 'A design_approval of this project is open.', 'Answer it first.', { project: args.project, decision: open.id });
  const content = parseJson<DesignContent>(approved.content);
  if (!content || !approved.design_check) throw new Refusal(409, 'design_unreadable', `Design version ${approved.version} cannot be read.`, 'Save the design again.', { design_revision: approved.id });
  const made = proposeDesign(tx, {
    project: args.project,
    run: null,
    revision: approved.revision,
    blobs: parseJson<Record<string, string>>(approved.blobs) ?? {},
    content,
    check: approved.design_check,
    findings: [],
    scope: 'asset_only',
  });
  const decision = tx.db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'design_approval' AND "subject_id" = ? AND "status" = 'open' ORDER BY rowid DESC LIMIT 1`).get(made.revision) as { id: string } | undefined;
  return { status: 201, body: { design_revision: made.revision, scope: 'asset_only', assets: held, decision: decision?.id ?? null } };
}
