// The result in the sandbox lane and what became of it (M2 slice 13, rows
// M129, M130; D2 §§1.4, 1.6, A.6 P18; SEAM.md §§143 to 145): the run read's
// `result_collection`, `exit_class` and `domain_observation`, the run's
// collected records, and P18's watch of a host FIFO that must never get a
// reader.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readRun } from '../reads.mjs';
import { recordFile, recordRow } from '../records.mjs';
import { withStore } from '../store.mjs';

export const COLLECTION_OUTCOMES = Object.freeze(['accepted', 'invalid', 'missing', 'not_collected']);
export const COLLECTION_REASONS = Object.freeze(['link', 'fifo', 'device', 'not_regular', 'oversize', 'malformed', 'deadline']);

// The run read, with `result_collection` checked for its form (SEAM.md §143).
export async function collectionOf(fx, project, runId) {
  const shown = await readRun(fx.engine, project, runId);
  const c = shown.result_collection;
  assert.ok(c && typeof c === 'object', `the run read has result_collection (run keys: ${Object.keys(shown).join(', ')}; result_collection: ${JSON.stringify(c ?? null)})`);
  assert.ok(COLLECTION_OUTCOMES.includes(c.outcome), `result_collection.outcome is one of ${COLLECTION_OUTCOMES.join(', ')} (${JSON.stringify(c.outcome)})`);
  if (c.outcome === 'invalid') assert.ok(COLLECTION_REASONS.includes(c.reason), `an invalid file has a reason, one of ${COLLECTION_REASONS.join(', ')} (${JSON.stringify(c.reason)})`);
  else assert.equal(c.reason, null, `only an invalid file has a reason (${JSON.stringify(c)})`);
  assert.ok(c.bytes_read === null || (Number.isInteger(c.bytes_read) && c.bytes_read >= 0), `bytes_read is a count or null (${JSON.stringify(c.bytes_read)})`);
  return { ...c, shown };
}

// Records of one run, optionally of one kind, oldest first.
export const runRecords = (home, runId, kind) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "run" = ? ORDER BY rowid').all(runId)).filter((r) => kind === undefined || r.kind === kind);

// The bytes of a published record, parsed as JSON.
export function recordJson(home, id) {
  const row = recordRow(home, id);
  assert.ok(row, `record ${id} exists`);
  assert.equal(row.published, 1, `record ${id} is published`);
  return JSON.parse(readFileSync(recordFile(home, row), 'utf8'));
}

// The one `unaccepted_result` of a run (SEAM.md §143), parsed.
export function unacceptedOf(home, runId, project) {
  const rows = runRecords(home, runId, 'unaccepted_result');
  assert.equal(rows.length, 1, `the run has one unaccepted_result record (records of the run: ${runRecords(home, runId).map((r) => r.kind).join(', ') || 'none'})`);
  assert.deepEqual([rows[0].published, rows[0].project], [1, project], 'published, the project\'s');
  return { row: rows[0], value: recordJson(home, rows[0].id) };
}

// The run's exit class and domain observation on the run read agree with
// the store's terminal observation and domain row (SEAM.md §145).
export function assertReadShowsExit(shown, terminal, domainRow, what) {
  assert.ok('exit_class' in shown, `${what}: the run read has exit_class (keys: ${Object.keys(shown).join(', ')})`);
  assert.ok('domain_observation' in shown, `${what}: the run read has domain_observation (keys: ${Object.keys(shown).join(', ')})`);
  assert.equal(shown.exit_class, terminal?.exit_class ?? null, `${what}: the read's exit_class is the terminal observation's`);
  assert.equal(shown.domain_observation, domainRow?.observation ?? null, `${what}: the read's domain_observation is the domain's`);
}

// ---- P18's host FIFO (SEAM.md §144) ---------------------------------------------------------

// A FIFO on the host in a short directory of the test's own under /tmp,
// watched from now on: every 20 ms a non-blocking open for writing, which
// fails ENXIO for as long as nobody has it open for reading. `stop()` ends
// the watch and returns {polls, enxio, opened, other}.
export function fifoWatch(t) {
  const dir = mkdtempSync('/tmp/surety-fifo-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'f');
  const made = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8' });
  assert.equal(made.status, 0, `the host FIFO is made (${made.stderr})`);
  assert.ok(statSync(path).isFIFO(), `host-read: ${path} is a FIFO`);
  const tally = { polls: 0, enxio: 0, opened: 0, other: [] };
  const poll = () => {
    tally.polls += 1;
    try {
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      tally.opened += 1;
      closeSync(fd);
    } catch (err) {
      if (err.code === 'ENXIO') tally.enxio += 1;
      else tally.other.push(err.code ?? String(err));
    }
  };
  poll();
  const timer = setInterval(poll, 20);
  let stopped = false;
  const stop = () => {
    if (!stopped) clearInterval(timer);
    stopped = true;
    return { ...tally };
  };
  t.after(stop);
  return { dir, path, stop, tally };
}
