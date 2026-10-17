// The owner-invoked review of a build he names (D7 §10.5, A.8; G13; Q4;
// SEAM.md §§502, 522): `POST …/design/reviews {target, build_ref,
// candidate?}` opens a Designer session in review mode bound to the subject
// `{kind: owner_build, target, build_ref, candidate?}`, the review's row
// recorded at the opening (its verdicts written at the close, proposals
// until the owner's `design_verdicts`). The build and the candidate are his
// word: nothing is observed, checked or deployed for it. The engine runs
// nothing of the build; a verdict observed on a simulation is never native
// evidence (D7 §10.2).

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import type { SessionDriver } from '../sessions/driver.js';
import { notFound, parseJson } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import { designPolicyOf } from './policy.js';
import { currentInventory } from './store.js';

const FIELDS = ['target', 'build_ref', 'candidate'];

function bodyOf(b: unknown): { target: string; build_ref: string; candidate: string | null } {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new Refusal(400, 'invalid_value', 'The request body must be a JSON object.', 'Send {"target": "<target>", "build_ref": "<the build you name>"}.', { field: null });
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new Refusal(400, 'unknown_field', `"${k}" is not a field of this command.`, `Send only ${FIELDS.join(', ')}.`, { field: k });
  if (typeof o.target !== 'string' || o.target === '') throw new Refusal(400, 'invalid_value', '"target" must name a target of the design.', 'Send {"target": "android", …}.', { field: 'target' });
  if (typeof o.build_ref !== 'string' || o.build_ref.trim() === '' || Buffer.byteLength(o.build_ref) > 1024) {
    throw new Refusal(400, 'invalid_value', '"build_ref" must be a non-empty string of at most 1 KiB naming the build.', 'Name the build you reviewed, as you know it.', { field: 'build_ref' });
  }
  if (o.candidate !== undefined && (typeof o.candidate !== 'string' || o.candidate === '')) throw new Refusal(400, 'invalid_value', '"candidate" must be a candidate id, if given.', 'Leave it out, or name a candidate.', { field: 'candidate' });
  return { target: o.target, build_ref: o.build_ref, candidate: typeof o.candidate === 'string' ? o.candidate : null };
}

// Refused before anything is opened: `design: off`, a target the
// inventory lacks.
export function ownerReviewFacts(db: Database.Database, args: { project: string; target: string }): { ok: true } {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  if (designPolicyOf(db, args.project) === 'off') {
    throw new Refusal(409, 'design_review_unavailable', 'This project has no design (policy design: off): there is nothing to review a build against.', 'Turn the design on first.', { project: args.project, cause: 'design_off' });
  }
  const targets = (currentInventory(db, args.project)?.inventory.targets ?? []).map((t) => t.target);
  if (!targets.includes(args.target)) {
    throw new Refusal(422, 'design_review_target_unknown', `${args.target} is not a target of this project's interface inventory.`, `Name one of: ${targets.join(', ') || '(none: no inventory yet)'}.`, { project: args.project, target: args.target, targets });
  }
  return { ok: true };
}

// The review's row, recorded with the session's opening; the run's notes
// name it, so the package and the close find it.
export function openOwnerReview(tx: Tx, args: { project: string; run: string; subject: Record<string, unknown> }): { review: string } {
  const rev = tx.db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(args.project) as { id: string } | undefined;
  const id = tx.newId('drv_');
  tx.db
    .prepare(`INSERT INTO "design_reviews" ("id", "created_at", "project", "design_revision", "run", "trigger", "subject", "review_blob", "verdicts") VALUES (?, ?, ?, ?, ?, 'owner_command', ?, NULL, '[]')`)
    .run(id, tx.at, args.project, rev?.id ?? null, args.run, JSON.stringify(args.subject));
  const notes = parseJson<Record<string, unknown>>((tx.db.prepare('SELECT "session_notes" FROM "runs" WHERE "id" = ?').get(args.run) as { session_notes: string | null } | undefined)?.session_notes ?? null) ?? {};
  tx.db.prepare('UPDATE "runs" SET "session_notes" = ? WHERE "id" = ?').run(JSON.stringify({ ...notes, mode: 'review', review: id }), args.run);
  tx.emit('design.review_requested', { project: args.project, design_review: id, run: args.run }, { trigger: 'owner_command', subject: args.subject });
  return { review: id };
}

// The review a run's opening recorded, if any.
export function ownerReviewOfRun(db: Database.Database, run: string): { id: string; subject: Record<string, unknown>; design_revision: string | null } | null {
  const notes = parseJson<{ review?: string }>((db.prepare('SELECT "session_notes" FROM "runs" WHERE "id" = ?').get(run) as { session_notes: string | null } | undefined)?.session_notes ?? null);
  if (!notes?.review) return null;
  const r = db.prepare('SELECT "id", "subject", "design_revision" FROM "design_reviews" WHERE "id" = ? AND "run" = ?').get(notes.review, run) as { id: string; subject: string; design_revision: string | null } | undefined;
  return r ? { id: r.id, subject: parseJson<Record<string, unknown>>(r.subject) ?? {}, design_revision: r.design_revision } : null;
}

export async function ownerReview(rt: Runtime, sessions: SessionDriver, project: string, b: unknown, scripted: string | null): Promise<{ status: number; body: unknown }> {
  const body = bodyOf(b);
  await rt.read('design.owner_review_facts', { project, target: body.target });
  const opened = await sessions.open(project, { role: 'designer', mode: 'review', scripted });
  const run = (opened.body as { run: { id: string } }).run;
  const subject = { kind: 'owner_build', target: body.target, build_ref: body.build_ref, ...(body.candidate !== null ? { candidate: body.candidate } : {}) };
  const made = await rt.engine<{ review: string }>('design.owner_review_open', { project, run: run.id, subject });
  return { status: 201, body: { run: { ...run, mode: 'review' }, review: { id: made.review, subject }, evidence: [] } };
}
