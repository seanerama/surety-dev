// What slice 33's session cases share (D6 §2; M5 plan §3.3 M415 to M420,
// M447; SEAM.md §§388 to 395): a project to hold a session, barriers named
// by the seam, and the reads of a session's settlement.

import assert from 'node:assert/strict';

import { releaseBarrier, waitFor } from './engine.mjs';
import { armBarrier } from './journal.mjs';
import { createWithIdea } from './journey/drive.mjs';
import { readSession, runRow } from './sessions.mjs';
import { tickUntil } from './runs.mjs';
import { withStore } from './store.mjs';

// A project to hold sessions: the reference project at baseline `idea`
// (D6 §1 step 1). A Vision session may write `.surety/idea.md` alone (§2.5).
export const sessionProject = (fx, opts = {}) => createWithIdea(fx, opts);

// The four facts a turn's settlement waits for (D6 §2.1, §2.4; B01;
// M447), and the pause barrier the seam names for each (§389 †): it fires
// once, in a turn's settlement, after that fact is established and before
// the next one is attempted.
export const SETTLEMENT_FACTS = Object.freeze(['terminated', 'collected', 'reply_recorded', 'usage_recorded']);
export const settling = (fact) => `session.turn_settling.${fact}`;
// The admission barrier (§389 †): fires once, in the admission of a save, a
// turn or a close, after the idle generation is read and before its
// compare-and-swap.
export const ADMISSION = 'session.admission';

export async function barrierWaiting(fx, name) {
  const res = await fx.engine.get('/v1/harness/barriers');
  return res.status === 200 && (res.body?.barriers ?? []).some((b) => b.name === name && b.state === 'waiting');
}
export async function pauseAt(fx, name) {
  await armBarrier(fx.engine, name, 'pause');
}
export const reached = (fx, name, what = name) => waitFor(() => barrierWaiting(fx, name), { what: `the engine to wait at ${what}` });
export const release = (fx, name) => releaseBarrier(fx.engine, name);

export const sessionState = (home, run) => runRow(home, run)?.session_state;
export const idleGeneration = (home, run) => runRow(home, run)?.idle_generation;
export const eventsOfRun = (home, type, run) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "type" = ? ORDER BY "seq"').all(type)).filter((e) => JSON.parse(e.subject ?? '{}').run === run);
export const invocationsOf = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ? ORDER BY rowid').all(run));
export const domainsOfRun = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ? ORDER BY rowid').all(run));
export const countRows = (home, table, where = '1 = 1', ...params) => withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...params).n);

// The owner's message posted without waiting: the raw response.
export const postTurnRaw = (fx, project, run, text) => fx.engine.post(`/v1/projects/${project}/sessions/${run}/turns`, { text });
export const postSaveRaw = (fx, project, run) => fx.engine.post(`/v1/projects/${project}/sessions/${run}/save`, {});
export const postCloseRaw = (fx, project, run, body = {}) => fx.engine.post(`/v1/projects/${project}/sessions/${run}/close`, body);

export function assertOneWinner(results, what) {
  const won = results.filter((r) => r.status >= 200 && r.status < 300);
  assert.equal(won.length, 1, `${what}: exactly one winner (${results.map((r) => `${r.status} ${r.body?.code ?? ''}`).join(', ')})`);
  const lost = results.filter((r) => !(r.status >= 200 && r.status < 300));
  for (const r of lost) assert.deepEqual([r.status, r.body?.code], [409, 'session_generation_stale'], `${what}: the loser refused session_generation_stale, never queued (${r.text})`);
}

// Ticks until turn `turn` of the session is no longer running; its read.
export const untilSettled = (fx, project, run, turn, { max = 12 } = {}) =>
  tickUntil(
    fx.engine,
    project,
    async () => {
      const body = await readSession(fx, project, run);
      const t = (body.turns ?? []).find((x) => x.turn === turn);
      return t && t.state !== 'running' ? body : undefined;
    },
    { max, what: `turn ${turn} of ${run} to settle` },
  );
