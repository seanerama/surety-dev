// M04, append-only history (slice 1). Plan §3.1 M04; D1 §§6.2, 17(10). Each
// immutable history table refuses UPDATE and DELETE at the database level.
// Deferred (COVERAGE.md): stream_chunk_receipts to slice 4, because its parent
// is the pre-publication stream identity of build spec §6 correction 21 (row
// M63); the git journal state projection to slice 3.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { storeCopy, storeTemplate } from './harness/fixtures.mjs';
import * as cases from './harness/store-cases.mjs';
import { hasTable } from './harness/store.mjs';

const TABLES = {
  invocation_receipts: 'receipts',
  invocation_status_observations: 'status observations',
  usage_observations: 'usage observations',
  ledger_rows: 'ledger rows',
  git_journal_events: 'journal events',
  events: 'events',
};

describe('M04 append-only history tables', () => {
  let template;
  before(async () => {
    template = await storeTemplate();
  });
  after(() => template?.cleanup());

  for (const [table, label] of Object.entries(TABLES)) {
    test(`${label} (${table}) cannot be updated or deleted`, (t) => {
      const { db, project } = storeCopy(t, template);
      cases.m04AppendOnly(db, project, table);
    });
  }

  test('observation history is not built in M1, so no rewritable copy of it exists', (t) => {
    // The Plan says "observation-history if present"; build spec §3 lists
    // environments' observation history as not built at all.
    const { db } = storeCopy(t, template);
    assert.equal(hasTable(db, 'observation_history'), false);
  });
});
