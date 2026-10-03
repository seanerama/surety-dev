// Reads and judgements for the record rows of slice 4 (M63 to M66, and the
// record cases of M02 and M04; SEAM.md §§56 to 58). A record is a row of
// `records` and a file under $SURETY_HOME/records/; a stream's chunk
// receipts say which of its bytes are durably retained.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex, waitFor } from './engine.mjs';
import { withStore } from './store.mjs';

// SEAM.md §56: a chunk is at most 1 MiB, and a transcript retains at most 8 MiB.
export const CHUNK_MAX = 1 << 20;
export const TRANSCRIPT_CAP = 8 << 20;

export const recordsOf = (home, project, kind) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "project" = ? ORDER BY rowid').all(project)).filter((record) => kind === undefined || record.kind === kind);

export const recordRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(id));

export const chunkReceipts = (home, record) => withStore(home, (db) => db.prepare('SELECT * FROM "stream_chunk_receipts" WHERE "record" = ? ORDER BY "offset"').all(record));

// Where a record's bytes are: `records.path` is relative to $SURETY_HOME/records/.
export const recordFile = (home, record) => join(home, 'records', record.path);

// What the store and the records directory must agree on at any moment the
// engine is not writing (SEAM.md §56):
//   - a published record has its hash and length, and while it has a path
//     its file has exactly that length and that hash;
//   - an unpublished stream has neither a hash nor a length: they are
//     unknown, not zero;
//   - a record's chunk receipts are contiguous from offset 0, each at most
//     CHUNK_MAX long, and each names bytes that are in the record's file with
//     that hash; a published record's receipts cover it exactly;
//   - no chunk receipt is without its record, and no run names a record
//     that is not published.
export function assertRecordsSound(home, project) {
  const records = recordsOf(home, project);
  for (const record of records) {
    const what = `record ${record.id} (${record.kind})`;
    const file = record.path === null ? null : recordFile(home, record);
    const bytes = file !== null && existsSync(file) ? readFileSync(file) : null;
    if (record.published === 1) {
      assert.ok(typeof record.sha256 === 'string' && Number.isInteger(record.bytes), `${what}: a published record has its hash and its length`);
      if (file !== null) {
        assert.ok(bytes !== null, `${what}: the file of a published record exists (${file})`);
        assert.equal(bytes.length, record.bytes, `${what}: the file has the recorded length`);
        assert.equal(sha256Hex(bytes), record.sha256, `${what}: the file has the recorded hash`);
      }
    } else {
      assert.deepEqual([record.sha256, record.bytes], [null, null], `${what}: the hash and length of an unpublished stream are unknown`);
    }
    const receipts = chunkReceipts(home, record.id);
    let end = 0;
    for (const receipt of receipts) {
      assert.equal(receipt.offset, end, `${what}: chunk receipts are contiguous from 0 (a receipt at ${receipt.offset}, expected ${end})`);
      assert.ok(receipt.length >= 1 && receipt.length <= CHUNK_MAX, `${what}: a chunk is between 1 byte and ${CHUNK_MAX} (${receipt.length})`);
      end += receipt.length;
      if (file !== null) {
        assert.ok(bytes !== null && bytes.length >= end, `${what}: the bytes of the chunk at ${receipt.offset} are retained in ${file}`);
        assert.equal(sha256Hex(bytes.subarray(receipt.offset, end)), receipt.sha256, `${what}: the retained bytes of the chunk at ${receipt.offset} have its hash`);
      }
    }
    if (record.published === 1 && receipts.length > 0) assert.equal(end, record.bytes, `${what}: the receipts of a published stream cover it exactly`);
  }
  withStore(home, (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "stream_chunk_receipts" c LEFT JOIN "records" r ON r."id" = c."record" WHERE r."id" IS NULL').get().n, 0, 'no chunk receipt is without its record');
    for (const run of db.prepare('SELECT "id", "transcript", "result" FROM "runs" WHERE "project" = ?').all(project)) {
      for (const key of ['transcript', 'result']) {
        if (run[key] === null) continue;
        assert.equal(records.find((record) => record.id === run[key])?.published, 1, `run ${run.id}: its ${key} names a published record`);
      }
    }
  });
  return records;
}

// GET /v1/projects/:p/records/:id. The response as it came.
export const readRecord = (engine, project, id) => engine.get(`/v1/projects/${project}/records/${id}`);

// The record is published, of that kind, holds exactly `content`, and the API serves it.
export async function assertRecordHolds(engine, project, id, { kind, content }) {
  const record = recordRow(engine.home, id);
  assert.ok(record, `record ${id} exists`);
  assert.deepEqual([record.kind, record.published], [kind, 1], `record ${id} is a published ${kind}`);
  const expected = Buffer.from(content);
  assert.equal(record.bytes, expected.length, `record ${id}: length`);
  assert.equal(record.sha256, sha256Hex(expected), `record ${id}: hash of what was written`);
  assert.equal(statSync(recordFile(engine.home, record)).size, expected.length);
  const res = await readRecord(engine, project, id);
  assert.equal(res.status, 200, `GET record ${id} (body: ${res.text.slice(0, 300)})`);
  assert.equal(sha256Hex(Buffer.from(res.text)), record.sha256, `the API serves record ${id} byte for byte`);
  return record;
}

export const waitForPostScan = (home, id, state) => waitFor(() => recordRow(home, id)?.post_scan === state, { what: `record ${id} to be post-scanned ${state}` });

// ---- redaction (SEAM.md §57) -------------------------------------------------------

// Give the engine's redactor a resolved secret: from now on the engine holds
// `value` for the reference `ref`, in memory only. The values the tests use
// are synthetic. `extra` adds what M2 records with a provider key: its
// provider-side cap, `provider_cap_usd` (SEAM.md §116).
export async function holdSecret(engine, ref, value, extra = {}) {
  const res = await engine.post('/v1/harness/secrets', { ref, value, ...extra });
  assert.ok(res.status >= 200 && res.status <= 299, `hold a secret → ${res.status} ${res.text}`);
}

// Register a detector the redactor did not have: a named pattern (a
// regular expression's source). Stored records are scanned again for it.
export async function registerDetector(engine, name, pattern) {
  const res = await engine.post('/v1/harness/detectors', { name, pattern });
  assert.ok(res.status >= 200 && res.status <= 299, `register a detector → ${res.status} ${res.text}`);
}

// Every regular file under `dir` that holds the byte sequence `needle`.
export function filesHolding(dir, needle, found = []) {
  const bytes = Buffer.from(needle);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesHolding(path, bytes, found);
    else if (entry.isFile() && readFileSync(path).includes(bytes)) found.push(path);
  }
  return found;
}
