// M02, store cases (slice 1). Plan §3.1 M02; D1 §§2.6, 6.2; build spec §6
// correction 10; Review B11. The real UNIQUE(run) WHERE turn IS NULL must reject
// a second stored receipt for a one-shot run, durably and under contention, and
// a second original ledger row is a duplicate charge.
// Deferred to slice 2 (COVERAGE.md): engine-side duplicate allocation returning
// the same receipt with no second launch, and distinct invocation, domain,
// workspace and record identities for two dispatched runs.

import { after, before, describe, test } from 'node:test';

import { startEngine } from './harness/engine.mjs';
import { homeCopy, storeCopy, storeTemplate } from './harness/fixtures.mjs';
import * as cases from './harness/store-cases.mjs';
import { openStore, storePath } from './harness/store.mjs';

describe('M02 store cases: one-shot receipt identity', () => {
  let template;
  before(async () => {
    template = await storeTemplate();
  });
  after(() => template?.cleanup());

  test('two one-shot runs of the same role each hold their own receipt', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m02DistinctRunsDistinctReceipts(db, project);
  });

  test('a second null-turn receipt for one run is rejected by the store', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m02SecondNullTurnReceiptRejected(db, project);
  });

  test('the rejection holds after the store is closed and reopened', (t) => {
    const { db, file, project } = storeCopy(t, template);
    const seeded = cases.m02SecondNullTurnReceiptRejected(db, project);
    db.close();
    const again = openStore(file);
    try {
      cases.m02RetryNullTurnReceiptRejected(again, project, seeded);
    } finally {
      again.close();
    }
  });

  test('the rejection holds after the engine restarts on the same store', async (t) => {
    const { home, port, project } = await homeCopy(t, template);
    const db = openStore(storePath(home));
    const seeded = cases.m02SecondNullTurnReceiptRejected(db, project);
    db.close();
    const engine = await startEngine({ home, port });
    t.after(() => engine.kill());
    await engine.stop();
    const again = openStore(storePath(home));
    try {
      cases.m02RetryNullTurnReceiptRejected(again, project, seeded);
    } finally {
      again.close();
    }
  });

  test('concurrent allocations from separate processes store exactly one receipt', async (t) => {
    const { db, file, project } = storeCopy(t, template);
    const setup = cases.m02ConcurrentSetup(db, project);
    db.close();
    await cases.m02ConcurrentAllocation(file, project, setup);
  });

  test('a second original ledger row for one invocation is rejected; a correction is not', (t) => {
    const { db, project } = storeCopy(t, template);
    cases.m02NoDuplicateOriginalLedgerRow(db, project);
  });
});
