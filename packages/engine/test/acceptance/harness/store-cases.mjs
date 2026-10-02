// Store-boundary cases for rows M02, M03 and M04. Each case takes an open
// read-write connection to a store and the id of a project row in it. The
// acceptance tests run them against the engine's own store file; the harness
// self-check of slices 1 to 3 ran them against a witness schema to show they
// were satisfiable and that they fail when the constraint they pin is missing
// (it is deleted since; SEAM.md §21).

import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { concurrentInserts } from './concurrent.mjs';
import {
  insertLedgerRow,
  insertReceipt,
  ledgerRow,
  receiptRow,
  seedEvent,
  seedGrant,
  seedJournalEvent,
  seedOneShot,
  seedOperation,
  seedRun,
  seedSessionRun,
  seedStatusObservation,
  seedTurn,
  seedUsageObservation,
} from './seed.mjs';
import { countRows } from './store.mjs';

// The write must be refused by a database constraint (UNIQUE, CHECK, FOREIGN
// KEY or a trigger's RAISE), not silently ignored.
export function assertConstraint(fn, what) {
  assert.throws(
    fn,
    (err) => typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT'),
    `${what}: expected a SQLITE_CONSTRAINT error`,
  );
}

const rowById = (db, table, id) => db.prepare(`SELECT * FROM "${table}" WHERE "id" = ?`).get(id);

// ---- M02: one-shot receipt identity --------------------------------------

export function m02DistinctRunsDistinctReceipts(db, project) {
  const a = seedOneShot(db, project, { role: 'builder' });
  const b = seedOneShot(db, project, { role: 'builder' });
  assert.notEqual(a.run.id, b.run.id);
  assert.notEqual(a.receipt.id, b.receipt.id);
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', a.run.id), 1);
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', b.run.id), 1);
}

// Returns the run so a caller can retry after reopening the store.
export function m02SecondNullTurnReceiptRejected(db, project) {
  const { run, grant } = seedOneShot(db, project);
  assertConstraint(() => insertReceipt(db, receiptRow(project, run.id, grant.id)), 'second null-turn receipt for one run');
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', run.id), 1);
  return { run, grant };
}

export function m02RetryNullTurnReceiptRejected(db, project, { run, grant }) {
  assertConstraint(() => insertReceipt(db, receiptRow(project, run.id, grant.id)), 'null-turn receipt after reopening');
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', run.id), 1);
}

// A one-shot run that has a grant and no receipt yet; the caller closes its
// connection and then races allocations from separate processes.
export function m02ConcurrentSetup(db, project) {
  const run = seedRun(db, project, { kind: 'one_shot' });
  const grant = seedGrant(db, project, run.id);
  return { run: run.id, grant: grant.id };
}

export async function m02ConcurrentAllocation(file, project, { run, grant }, contenders = 4) {
  const rows = Array.from({ length: contenders }, () => receiptRow(project, run, grant));
  const outcomes = await concurrentInserts(file, 'invocation_receipts', rows);
  assert.equal(outcomes.filter((o) => o.ok).length, 1, `exactly one allocation stored: ${JSON.stringify(outcomes)}`);
  for (const o of outcomes.filter((x) => !x.ok)) {
    assert.ok(String(o.code).startsWith('SQLITE_CONSTRAINT'), `losers refused by a constraint: ${JSON.stringify(o)}`);
  }
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', run), 1);
  } finally {
    db.close();
  }
}

export function m02NoDuplicateOriginalLedgerRow(db, project) {
  const { run, receipt } = seedOneShot(db, project);
  const ids = { invocation: receipt.id, run: run.id };
  const original = insertLedgerRow(db, ledgerRow(project, ids));
  assertConstraint(() => insertLedgerRow(db, ledgerRow(project, ids)), 'second original ledger row for one invocation');
  assert.equal(countRows(db, 'ledger_rows', '"invocation" = ? AND "corrects" IS NULL', receipt.id), 1);
  // The constraint is partial: a correction row for the same invocation is not a duplicate charge.
  insertLedgerRow(db, ledgerRow(project, ids, { corrects: original.id, correction_seq: 1 }));
  assert.equal(countRows(db, 'ledger_rows', '"invocation" = ?', receipt.id), 2);
}

// ---- M03: session-turn receipts --------------------------------------------

export function m03DuplicateTurnReceiptRejected(db, project) {
  const { run, grant } = seedSessionRun(db, project);
  const first = seedTurn(db, project, { run: run.id, grant: grant.id });
  assertConstraint(
    () => insertReceipt(db, receiptRow(project, run.id, grant.id, { turn: first.turn })),
    'second receipt for one turn',
  );
  assert.equal(countRows(db, 'invocation_receipts', '"turn" = ?', first.turn), 1);
  // A second turn of the same run is a distinct invocation.
  const second = seedTurn(db, project, { run: run.id, grant: grant.id, number: 2 });
  assert.notEqual(second.invocation, first.invocation);
}

export function m03CrossRunTurnRejected(db, project) {
  const a = seedSessionRun(db, project);
  const b = seedSessionRun(db, project);
  // The turn belongs to run A; its receipt claims run B.
  assertConstraint(
    () => seedTurn(db, project, { run: a.run.id, grant: a.grant.id, receiptRun: b.run.id, receiptGrant: b.grant.id }),
    'receipt whose turn belongs to another run',
  );
  assert.equal(countRows(db, 'turns', '"run" = ?', a.run.id), 0);
  assert.equal(countRows(db, 'invocation_receipts', '"run" IN (?, ?)', a.run.id, b.run.id), 0);
  assert.equal(countRows(db, 'execution_domains', '"run" IN (?, ?)', a.run.id, b.run.id), 0);
}

export function m03SessionRunNullTurnRejected(db, project) {
  const { run, grant } = seedSessionRun(db, project);
  assertConstraint(() => insertReceipt(db, receiptRow(project, run.id, grant.id)), 'null-turn receipt for a session run');
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', run.id), 0);
}

export function m03OneShotRunWithTurnRejected(db, project) {
  const { run, grant } = seedOneShot(db, project);
  // A turn-bearing receipt on a one-shot run is refused; the whole write set is rolled back.
  assertConstraint(() => seedTurn(db, project, { run: run.id, grant: grant.id }), 'turn receipt for a one-shot run');
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', run.id), 1);
  assert.equal(countRows(db, 'turns', '"run" = ?', run.id), 0);
}

export function m03RejectedWriteIsAtomic(db, project) {
  const { run, grant, receipt } = seedOneShot(db, project);
  const write = db.transaction(() => {
    seedStatusObservation(db, project, receipt.id, 1);
    insertReceipt(db, receiptRow(project, run.id, grant.id));
  });
  assertConstraint(write, 'transaction containing a duplicate receipt');
  assert.equal(countRows(db, 'invocation_status_observations', '"invocation" = ?', receipt.id), 0);
  assert.equal(countRows(db, 'invocation_receipts', '"run" = ?', run.id), 1);
}

// ---- M04: append-only history ----------------------------------------------

// For each append-only table: how to append a row, and one column an UPDATE
// tries to rewrite with a value that is valid for that column.
export const APPEND_ONLY = {
  invocation_receipts: {
    seed: (db, p) => seedOneShot(db, p).receipt.id,
    column: 'provider',
    value: 'rewritten',
  },
  invocation_status_observations: {
    seed: (db, p) => seedStatusObservation(db, p, seedOneShot(db, p).receipt.id).id,
    column: 'status',
    value: 'ended',
  },
  usage_observations: {
    seed: (db, p) => seedUsageObservation(db, p, seedOneShot(db, p).receipt.id).id,
    column: 'semantics',
    value: 'delta',
  },
  ledger_rows: {
    seed: (db, p) => {
      const { run, receipt } = seedOneShot(db, p);
      return insertLedgerRow(db, ledgerRow(p, { invocation: receipt.id, run: run.id })).id;
    },
    column: 'cost_status',
    value: 'measured_zero',
  },
  git_journal_events: {
    seed: (db, p) => seedJournalEvent(db, p, seedOperation(db, p).id).id,
    column: 'event_kind',
    value: 'applied',
  },
  events: {
    seed: (db) => seedEvent(db).id,
    column: 'type',
    value: 'engine.backup',
  },
};

export function m04AppendOnly(db, project, table) {
  const spec = APPEND_ONLY[table];
  const id = spec.seed(db, project);
  const before = rowById(db, table, id);
  assert.ok(before, `${table}: appended row is readable`);
  assertConstraint(
    () => db.prepare(`UPDATE "${table}" SET "${spec.column}" = ? WHERE "id" = ?`).run(spec.value, id),
    `UPDATE on ${table}`,
  );
  assertConstraint(() => db.prepare(`DELETE FROM "${table}" WHERE "id" = ?`).run(id), `DELETE on ${table}`);
  assertConstraint(() => db.prepare(`DELETE FROM "${table}"`).run(), `unqualified DELETE on ${table}`);
  assert.deepEqual(rowById(db, table, id), before, `${table}: row unchanged`);
}
