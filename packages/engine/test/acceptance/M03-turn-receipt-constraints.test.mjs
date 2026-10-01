// M03 (slice 1). Plan §3.1 M03; D1 A.3; build spec §6 correction 10; Review
// B11. Minimal test-only session/turn identity rows are written straight into
// the store; no session API is enabled (row M08 pins its refusal). The store
// itself must enforce one invocation per turn, that a turn belongs to its
// receipt's run, and that run kind agrees with turn nullability, atomically.

import { after, before, describe, test } from 'node:test';

import { storeCopy, storeTemplate } from './harness/fixtures.mjs';
import * as cases from './harness/store-cases.mjs';

describe('M03 session-turn constraints at the store boundary', () => {
  let template;
  before(async () => {
    template = await storeTemplate();
  });
  after(() => template?.cleanup());

  test('a second receipt for one turn is rejected', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m03DuplicateTurnReceiptRejected(db, project);
  });

  test('a receipt whose turn belongs to another run is rejected with its whole write set', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m03CrossRunTurnRejected(db, project);
  });

  test('a null-turn receipt for a session run is rejected', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m03SessionRunNullTurnRejected(db, project);
  });

  test('a turn-bearing receipt for a one-shot run is rejected with its whole write set', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m03OneShotRunWithTurnRejected(db, project);
  });

  test('a transaction containing a rejected receipt leaves none of its other rows', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m03RejectedWriteIsAtomic(db, project);
  });
});
