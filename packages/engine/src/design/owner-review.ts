// The owner-invoked review of a build he names (D7 §10.5, A.8; G13; Q4;
// SEAM.md §§502, 522): `POST …/design/reviews {target, build_ref,
// candidate?, observed_on?, evidence?}` (`surety design review`) opens a
// Designer session in review mode bound to the subject `{kind: owner_build,
// target, build_ref, candidate?}`, the review's row and its evidence
// recorded at the opening in the same transaction (its verdicts written at
// the close, proposals until the owner's `design_verdicts`). The build and
// the candidate are his word: nothing is observed, checked or deployed for
// it. His evidence files are judged by their headers and sizes before
// anything is opened (evidence.ts), stored as records through the redactor,
// and kept apart as `owner_supplied`; nothing of them is decoded or run. A
// verdict observed on a simulation is never native evidence (D7 §10.2).
//
// Bounds of the request's own fields: `build_ref` and `candidate` are kept
// verbatim and refused, never cut, past 1 KiB (a request-shape bound like
// an asset's file name; D7 and A.7 name none). `design_review_unavailable`
// (409, under `design: off`) is SEAM.md §522's name in A.6's form of
// `design_preview_unavailable`; A.6 lists no code for it.

import type Database from 'better-sqlite3';

import { writeWholeRecord } from '../records/files.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import type { SessionDriver } from '../sessions/driver.js';
import { notFound, parseJson } from '../store/transitions/common.js';
import { projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { recordsDir } from '../records/files.js';
import { log } from '../runtime.js';
import { type CheckedEvidence, EVIDENCE_OBSERVED_ON, FILE_KEY, REVIEW_KEY, base64Size, checkEvidence, evidenceInvalid, validName } from './evidence.js';
import { designPolicyOf } from './policy.js';
import { currentInventory } from './store.js';

const FIELDS = ['target', 'build_ref', 'candidate', 'observed_on', 'evidence'];
const REF_MAX = 1024;

interface ReviewBody {
  target: string;
  build_ref: string;
  candidate: string | null;
  observed_on: string | null;
  // Each file's base64 text, kept undecoded until its bounds hold (S4).
  evidence: { name: string; base64: string }[];
}

export function bodyOf(b: unknown): ReviewBody {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new Refusal(400, 'invalid_value', 'The request body must be a JSON object.', 'Send {"target": "<target>", "build_ref": "<the build you name>"}.', { field: null });
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new Refusal(400, 'unknown_field', `"${k}" is not a field of this command.`, `Send only ${FIELDS.join(', ')}.`, { field: k });
  if (typeof o.target !== 'string' || o.target === '') throw new Refusal(400, 'invalid_value', '"target" must name a target of the design.', 'Send {"target": "android", …}.', { field: 'target' });
  if (typeof o.build_ref !== 'string' || o.build_ref.trim() === '' || Buffer.byteLength(o.build_ref) > REF_MAX) {
    throw new Refusal(400, 'invalid_value', `"build_ref" must be a non-empty string of at most ${REF_MAX} bytes naming the build; it is kept verbatim, never cut.`, 'Name the build you reviewed, as you know it.', { field: 'build_ref' });
  }
  if (o.candidate !== undefined && (typeof o.candidate !== 'string' || o.candidate === '' || Buffer.byteLength(o.candidate) > REF_MAX)) {
    throw new Refusal(400, 'invalid_value', `"candidate" must be the candidate you name, at most ${REF_MAX} bytes, if given; it is your word, never verified.`, 'Leave it out, or name a candidate.', { field: 'candidate' });
  }
  if (o.observed_on !== undefined && (typeof o.observed_on !== 'string' || !(EVIDENCE_OBSERVED_ON as readonly string[]).includes(o.observed_on))) {
    throw new Refusal(400, 'invalid_value', `"observed_on" must be one of ${EVIDENCE_OBSERVED_ON.join(', ')}: where you saw what your evidence shows (D7 §10.5).`, 'Name the runtime, or leave it out with no evidence.', { field: 'observed_on' });
  }
  const evidence: ReviewBody['evidence'] = [];
  if (o.evidence !== undefined) {
    if (!Array.isArray(o.evidence)) throw new Refusal(400, 'invalid_value', '"evidence" must be a list of {name, content_base64}.', 'Send each file by its name and its bytes, base64.', { field: 'evidence' });
    for (const [i, e] of o.evidence.entries()) {
      const at = `evidence[${i}]`;
      if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Refusal(400, 'invalid_value', `"${at}" must be {name, content_base64}.`, 'Send each file by its name and its bytes, base64.', { field: at });
      const x = e as Record<string, unknown>;
      for (const k of Object.keys(x)) if (k !== 'name' && k !== 'content_base64') throw new Refusal(400, 'unknown_field', `"${k}" is not a field of ${at}.`, 'Send name and content_base64.', { field: `${at}.${k}` });
      if (!validName(x.name)) throw new Refusal(400, 'invalid_value', `"${at}.name" must be the file's name: no directory, at most 255 bytes.`, 'Send the file name as it is, without its directory.', { field: `${at}.name` });
      if (typeof x.content_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(x.content_base64)) throw new Refusal(400, 'invalid_value', `"${at}.content_base64" must be the file's bytes, base64.`, 'Send the file\'s bytes, base64.', { field: `${at}.content_base64` });
      evidence.push({ name: x.name, base64: x.content_base64 });
    }
  }
  if (evidence.length > 0 && typeof o.observed_on !== 'string') {
    throw new Refusal(400, 'invalid_value', '"observed_on" is required with evidence: the runtime you saw it on (device, emulator, simulator).', 'Name the runtime your evidence shows (--observed-on).', { field: 'observed_on' });
  }
  // It says where evidence was seen; with none, it says nothing (N10).
  if (evidence.length === 0 && o.observed_on !== undefined) {
    throw new Refusal(400, 'invalid_value', '"observed_on" says where your evidence was seen, and this review carries none.', 'Leave observed_on out, or send the evidence it is about (--evidence).', { field: 'observed_on' });
  }
  return { target: o.target, build_ref: o.build_ref, candidate: typeof o.candidate === 'string' ? o.candidate : null, observed_on: typeof o.observed_on === 'string' ? o.observed_on : null, evidence };
}

// Refused before anything is opened: `design: off`, a target the
// inventory lacks. The evidence bounds of the project's policy.
export function ownerReviewFacts(db: Database.Database, args: { project: string; target: string }): { ok: true; bounds: { file: number; review: number } } {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  if (designPolicyOf(db, args.project) === 'off') {
    throw new Refusal(409, 'design_review_unavailable', 'This project has no design (policy design: off): there is nothing to review a build against.', 'Turn the design on first.', { project: args.project, cause: 'design_off' });
  }
  const targets = (currentInventory(db, args.project)?.inventory.targets ?? []).map((t) => t.target);
  if (!targets.includes(args.target)) {
    throw new Refusal(422, 'design_review_target_unknown', `${args.target} is not a target of this project's interface inventory.`, `Name one of: ${targets.join(', ') || '(none: no inventory yet)'}.`, { project: args.project, target: args.target, targets });
  }
  const policy = projectPolicy(db, args.project) as Record<string, unknown>;
  const num = (k: string, d: number) => (typeof policy[k] === 'number' ? (policy[k] as number) : d);
  return { ok: true, bounds: { file: num(FILE_KEY, 67_108_864), review: num(REVIEW_KEY, 536_870_912) } };
}

export interface OwnerEvidence {
  name: string;
  format: string;
  digest: string;
  bytes: number;
  record: string;
}

// The review's row and its evidence, recorded with the session's opening;
// the run's notes name the review, so the package and the close find it.
export function openOwnerReview(tx: Tx, args: { project: string; run: string; subject: Record<string, unknown>; evidence?: OwnerEvidence[]; observed_on?: string | null }): { review: string; evidence: string[] } {
  const rev = tx.db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(args.project) as { id: string } | undefined;
  const id = tx.newId('drv_');
  tx.db
    .prepare(`INSERT INTO "design_reviews" ("id", "created_at", "project", "design_revision", "run", "trigger", "subject", "review_blob", "verdicts") VALUES (?, ?, ?, ?, ?, 'owner_command', ?, NULL, '[]')`)
    .run(id, tx.at, args.project, rev?.id ?? null, args.run, JSON.stringify(args.subject));
  const ids: string[] = [];
  for (const e of args.evidence ?? []) {
    const ev = tx.newId('dev_');
    tx.db
      .prepare(
        `INSERT INTO "design_evidence" ("id", "created_at", "project", "review", "run", "provenance", "format", "digest", "bytes", "target", "observed_on", "record", "name")
         VALUES (?, ?, ?, ?, ?, 'owner_supplied', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ev, tx.at, args.project, id, args.run, e.format, e.digest, e.bytes, String(args.subject.target), args.observed_on ?? null, e.record, e.name);
    ids.push(ev);
  }
  const notes = parseJson<Record<string, unknown>>((tx.db.prepare('SELECT "session_notes" FROM "runs" WHERE "id" = ?').get(args.run) as { session_notes: string | null } | undefined)?.session_notes ?? null) ?? {};
  tx.db.prepare('UPDATE "runs" SET "session_notes" = ? WHERE "id" = ?').run(JSON.stringify({ ...notes, mode: 'review', review: id }), args.run);
  tx.emit('design.review_requested', { project: args.project, design_review: id, run: args.run }, { trigger: 'owner_command', subject: args.subject, evidence: ids });
  return { review: id, evidence: ids };
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
  const facts = await rt.read<{ ok: true; bounds: { file: number; review: number } }>('design.owner_review_facts', { project, target: body.target });
  // Every file judged before anything is opened or stored: a refusal is
  // whole. Sizes from the base64 lengths, decoding only within the bounds (S4).
  const checked = checkEvidence(
    body.evidence.map((e) => ({ name: e.name, size: base64Size(e.base64), bytes: () => Buffer.from(e.base64, 'base64') })),
    facts.bounds,
  );
  if (!checked.ok) throw evidenceInvalid(checked.reasons);
  // Nothing is stored before the opening's guard passes (N3).
  await rt.read('session.open_guard', { project });
  // Stored through the redactor as records; the digest and size are of the
  // bytes the engine holds (N2). Never decoded beyond the header.
  const evidence: OwnerEvidence[] = [];
  const subject = { kind: 'owner_build', target: body.target, build_ref: body.build_ref, ...(body.candidate !== null ? { candidate: body.candidate } : {}) };
  let opened: { status: number; body: unknown };
  try {
    for (const f of checked.files as CheckedEvidence[]) {
      const record = await writeWholeRecord(rt, { project, run: null, kind: 'design_evidence', content: f.bytes });
      evidence.push({ name: f.name, format: f.format, digest: f.digest, bytes: f.bytes.length, record });
      const held = await rt.read<{ sha256: string | null; bytes: number | null } | null>('record.row', { record });
      if (held?.sha256) evidence[evidence.length - 1] = { ...evidence[evidence.length - 1]!, digest: `sha256:${held.sha256}`, bytes: held.bytes ?? f.bytes.length };
    }
    // The session, the review's row, its subject and its evidence in one transaction (S3).
    opened = await sessions.open(project, { role: 'designer', mode: 'review', scripted, review: subject, evidence, observed_on: body.observed_on });
  } catch (err) {
    // A refused opening keeps none of the files (N3).
    await discardEvidence(rt, evidence.map((e) => e.record));
    throw err;
  }
  const made = opened.body as { run: Record<string, unknown>; review: { id: string; subject: Record<string, unknown> }; evidence?: string[] };
  const ids = made.evidence ?? [];
  return {
    status: 201,
    body: {
      run: { ...made.run, mode: 'review' },
      review: { id: made.review.id, subject: made.review.subject },
      evidence: ids.map((id, i) => ({ id, provenance: 'owner_supplied', name: evidence[i]!.name, format: evidence[i]!.format, digest: evidence[i]!.digest, bytes: evidence[i]!.bytes, target: body.target, observed_on: body.observed_on })),
    },
  };
}

// Evidence records of a refused opening (N3): released (the row keeps no
// path, as an expired record's) and their bytes removed; never one that a
// review holds.
export function releaseEvidenceRecords(tx: Tx, args: { records: string[] }): { paths: string[] } {
  const paths: string[] = [];
  for (const id of args.records) {
    const r = tx.db.prepare(`SELECT "id", "project", "path" FROM "records" WHERE "id" = ? AND "kind" = 'design_evidence'`).get(id) as { id: string; project: string | null; path: string | null } | undefined;
    if (!r || r.path === null) continue;
    if (tx.db.prepare('SELECT 1 FROM "design_evidence" WHERE "record" = ?').get(id)) continue;
    tx.db.prepare('UPDATE "records" SET "path" = NULL WHERE "id" = ?').run(id);
    tx.emit('record.expired', { project: r.project, record: id }, { path: r.path, cause: 'design_review_refused' });
    paths.push(r.path);
  }
  return { paths };
}

async function discardEvidence(rt: Runtime, records: string[]): Promise<void> {
  if (records.length === 0) return;
  try {
    const { paths } = await rt.engine<{ paths: string[] }>('design.release_evidence', { records });
    for (const p of paths) rmSync(join(recordsDir(rt.home), p), { force: true });
  } catch (err) {
    log('design review evidence', err, { records });
  }
}
