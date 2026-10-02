// Reads and commands for the ledger and budget rows of slice 4 (M59 to M62,
// and the over-budget case of M12; SEAM.md §§53 to 55). Expected numbers are
// stated in each test's fixture, never computed from what the engine stored.

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { withStore } from './store.mjs';

// The scripted provider's price table (SEAM.md §53): the one labeled rule by
// which a cost that was not reported becomes an estimate.
export const PRICES = Object.freeze({ version: 'scripted-prices-1', model: 'scripted-priced', usd_per_million: Object.freeze({ billable_in: 2, cached_in: 0.5, out: 8 }) });
export const NORMALIZATION = 'scripted-1';

// A project's ledger rows as stored, in the order they were written.
export const ledgerRows = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "project" = ? ORDER BY rowid').all(project));

// The one invocation of a one-shot run.
export const invocationOf = (home, run) => withStore(home, (db) => db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ?').get(run).id);

// The original ledger row of a run's invocation, or undefined.
export const originalRowOf = (home, run) => ledgerRows(home, withStore(home, (db) => db.prepare('SELECT "project" FROM "runs" WHERE "id" = ?').get(run).project)).find((row) => row.run === run && row.corrects === null);

// GET /v1/projects/:p/ledger: every day, or one.
export async function getLedger(engine, project, day) {
  const res = await engine.get(`/v1/projects/${project}/ledger${day === undefined ? '' : `?day=${day}`}`);
  assert.equal(res.status, 200, `GET ledger (body: ${res.text})`);
  return res.body;
}

// A later correction from the scripted provider, with a fixed identity
// (SEAM.md §54). Returns the raw response.
export const correct = (engine, { invocation, seq, raw, usage_complete }) =>
  engine.post('/v1/harness/ledger/corrections', { invocation, correction_seq: seq, raw, ...(usage_complete === undefined ? {} : { usage_complete }) });

// The numeric fields of a stored row that the API's row must repeat.
export const AMOUNTS = ['billable_in', 'cached_in', 'out', 'cost_status', 'cost_usd', 'corrects', 'correction_seq'];
export const amounts = (row) => Object.fromEntries(AMOUNTS.map((key) => [key, row[key]]));

// The API's rows are the stored rows: same ids in the same order, same amounts.
export function assertRowsMatchStore(ledger, home, project) {
  const stored = ledgerRows(home, project);
  assert.deepEqual(ledger.rows.map((row) => row.id), stored.map((row) => row.id), 'the API lists the stored ledger rows, in the order they were written');
  for (const [i, row] of stored.entries()) assert.deepEqual(amounts(ledger.rows[i]), amounts(row), `the API repeats the amounts of ledger row ${row.id}`);
}

// A day budget is counted per UTC day of the engine's clock, which in these
// tests is the host's. A test that fills a day and then looks at it must not
// straddle midnight: if midnight is less than `marginMs` away, wait it out.
export async function awayFromMidnight(marginMs = 120_000) {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (midnight - now.getTime() < marginMs) await sleep(midnight - now.getTime() + 5000);
}
