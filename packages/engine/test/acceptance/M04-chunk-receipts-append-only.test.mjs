// M04, chunk receipts (slice 4; deferred from slice 1). Plan §3.1 M04; D1
// §§6.2, 17(10); build spec §6 correction 21; SEAM.md §§56, 62. A chunk
// receipt names a stream that exists before it is published, and once
// written it cannot be rewritten or removed.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { storeCopy, storeTemplate } from './harness/fixtures.mjs';
import { seedChunkReceipt, seedStream } from './harness/seed.mjs';
import { assertConstraint } from './harness/store-cases.mjs';

describe('M04 append-only history: chunk receipts', () => {
  let template;
  before(async () => {
    template = await storeTemplate();
  });
  after(() => template?.cleanup());

  test('a chunk receipt of an unpublished stream cannot be updated or deleted', (t) => {
    const { db, project } = storeCopy(t, template);
    const stream = seedStream(db, project);
    const receipt = seedChunkReceipt(db, project, stream.id);
    const read = () => db.prepare('SELECT * FROM "stream_chunk_receipts" WHERE "id" = ?').get(receipt.id);
    const stored = read();
    assert.equal(stored.record, stream.id, 'the receipt names its stream, which is not yet a published record');

    assertConstraint(() => db.prepare('UPDATE "stream_chunk_receipts" SET "length" = 8 WHERE "id" = ?').run(receipt.id), 'UPDATE on stream_chunk_receipts');
    assertConstraint(() => db.prepare('DELETE FROM "stream_chunk_receipts" WHERE "id" = ?').run(receipt.id), 'DELETE on stream_chunk_receipts');
    assertConstraint(() => db.prepare('DELETE FROM "stream_chunk_receipts"').run(), 'unqualified DELETE on stream_chunk_receipts');
    assert.deepEqual(read(), stored, 'the receipt is unchanged');
  });
});
