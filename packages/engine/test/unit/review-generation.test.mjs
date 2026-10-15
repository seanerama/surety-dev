// Developer test for the generation of a candidate's review (slice 37):
// under D6 K2 a check correction can apply a new protected version while the
// candidate's Reviewer runs, so its sign-off is bound to acceptance content
// the candidate no longer has and the stage gate stays SIGNOFF_MISSING. Such
// a review is asked again, once per content, as the next generation of its
// trigger. A review under way, one that signed the current content, and one
// that signed nothing are not repeated. Against a scratch store; foreign
// keys off, as the rows are the minimum the read needs.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { reviewGeneration } = await import(join(dist, 'store', 'transitions', 'gates.js'));

const AT = '2026-10-14T00:00:00.000Z';
const OLD = 'o'.repeat(64);
const NEW = 'n'.repeat(64);

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  let seq = 0;
  const review = (id, generation, status) => {
    db.prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, 'review', '{"candidate":"cand_1"}', ?, 'verification', 'cand_1', ?, 0, 0, 0, 0)`,
    ).run(id, AT, ++seq, status, generation);
    db.prepare(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
       VALUES (?, ?, 'prj_1', ?, ?, 'reviewer', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0)`,
    ).run(`run_${id}`, AT, ++seq, id, 'a'.repeat(40), AT);
  };
  const signoff = (id, workItem, hash) =>
    db.prepare(
      `INSERT INTO signoffs (id, created_at, project, candidate, revision, role, scope, module, run, acceptance_content_hash, recorded_at)
       VALUES (?, ?, 'prj_1', 'cand_1', ?, 'reviewer', 'candidate', NULL, ?, ?, ?)`,
    ).run(id, AT, 'a'.repeat(40), `run_${workItem}`, hash, AT);
  return { db, review, signoff };
}

test('a review signed on content the candidate no longer has is asked again as the next generation, once per content', (t) => {
  const { db, review, signoff } = store(t);
  assert.equal(reviewGeneration(db, 'prj_1', 'cand_1', NEW), 1, 'no review yet: the first generation');

  review('wi_g1', 1, 'executing');
  assert.equal(reviewGeneration(db, 'prj_1', 'cand_1', NEW), 1, 'one under way is not repeated');

  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_g1'`).run();
  assert.equal(reviewGeneration(db, 'prj_1', 'cand_1', NEW), 1, 'one that signed nothing is not repeated');

  signoff('so_1', 'wi_g1', OLD);
  assert.equal(reviewGeneration(db, 'prj_1', 'cand_1', OLD), 1, 'signed on the current content: not repeated');
  assert.equal(reviewGeneration(db, 'prj_1', 'cand_1', NEW), 2, 'signed only on content the candidate no longer has: the next generation');

  review('wi_g2', 2, 'complete');
  signoff('so_2', 'wi_g2', NEW);
  assert.equal(reviewGeneration(db, 'prj_1', 'cand_1', NEW), 2, 'once the next generation has signed the current content, nothing more');
});
