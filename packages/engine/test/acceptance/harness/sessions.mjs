// The test side of M5's sessions (D6 §2; BS5 §3, §8; SEAM.md §§343, 344):
// the scripted backend as a conversational role, the session routes as the
// tests read them, and the reads of a session's turns and transcript.
//
// A session's turns are launches of one run (D6 §2.1), so a turn is scripted
// by the run: `scriptTurns(fx, run, [turn1, turn2])` writes
// scripts/run-<run>.json and launch n of the run follows element n-1
// (harness/scripted/child.mjs). A turn's script does what the role would do
// in its workspace (writes under its permitted paths) and ends with
// `turnResult(...)`: the M1 result's `status` and `summary` beside D6 B.7's
// `reply`, `artifact_changed`, `questions_for_owner?` and `done?`.
//
// The routes (SEAM.md §344): open answers 201 with the run `allocated`; a
// turn answers 202 once the owner's entry is recorded and the session is
// `turn_running`, and the scheduler dispatches the invocation (a tick in the
// kernel lane); the reply is read on `GET …/sessions/:r` once the turn is
// settled; save and close are commands on the idle session.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { assertRefused } from './fixtures.mjs';
import { recordFile, recordRow } from './records.mjs';
import { getRow, tickUntil } from './runs.mjs';
import { VALID_RESULT, step } from './scripted.mjs';
import { withStore } from './store.mjs';

export const SESSION_ROLES = Object.freeze(['vision', 'spec_writer', 'architect']);

// A turn's result (SEAM.md §343): the M1 fields and D6 B.7's.
export const turnResult = ({ reply = 'Done.', artifact_changed = false, questions_for_owner, done, ...extra } = {}) => ({
  ...VALID_RESULT,
  summary: reply.slice(0, 120),
  reply,
  artifact_changed,
  ...(questions_for_owner === undefined ? {} : { questions_for_owner }),
  ...(done === undefined ? {} : { done }),
  ...extra,
});

// A turn that writes `files` ({path: text}) into the workspace and replies.
export const turnThatWrites = (files, result = {}) => ({
  steps: [...Object.entries(files).map(([path, text]) => step.write(path, text)), step.result(turnResult({ artifact_changed: Object.keys(files).length > 0, ...result }))],
});
// A turn that only talks.
export const turnThatSays = (reply, extra = {}) => ({ steps: [step.result(turnResult({ reply, ...extra }))] });
// A turn that dumps its context package into the launch log first (SEAM.md §343, "the package").
export const turnThatDumps = (files = {}, result = {}) => ({ steps: [step.probe('context_dump'), ...turnThatWrites(files, result).steps] });

// Script the launches of one run, in order.
export function scriptTurns(fx, run, scripts) {
  fx.scripted.script(`run-${run}`, scripts);
}

const sessions = (project) => `/v1/projects/${project}/sessions`;

// POST …/sessions {role}: 201, the run `allocated` with idle generation 0.
export async function openSession(fx, project, role, body = {}) {
  const res = await fx.engine.post(sessions(project), { role, ...body });
  assert.equal(res.status, 201, `POST …/sessions opens a ${role} session (SEAM.md §344) (→ ${res.status} ${res.text})`);
  const run = res.body?.run;
  assert.match(run?.id ?? '', /^run_/, `the answer names the session run (body: ${res.text})`);
  assert.deepEqual([run.role, run.kind, run.session_state], [role, 'session', 'allocated'], `a run of kind session, allocated (body: ${res.text})`);
  return run;
}

// POST …/sessions/:r/turns {text}: 202, the owner's entry recorded, `turn_running`.
export async function postTurn(fx, project, run, text) {
  const res = await fx.engine.post(`${sessions(project)}/${run}/turns`, { text });
  assert.equal(res.status, 202, `POST …/turns admits the owner's message (SEAM.md §344) (→ ${res.status} ${res.text})`);
  assert.equal(res.body?.session_state, 'turn_running', `the session is turn_running (body: ${res.text})`);
  assert.ok(Number.isInteger(res.body?.turn) && res.body.turn >= 1, `the answer numbers the turn (body: ${res.text})`);
  return res.body;
}

// GET …/sessions/:r (SEAM.md §344).
export async function readSession(fx, project, run) {
  const res = await fx.engine.get(`${sessions(project)}/${run}`);
  assert.equal(res.status, 200, `GET …/sessions/:r (→ ${res.status} ${res.text})`);
  return res.body;
}

// The owner says `text`; the turn is dispatched by the scheduler and settled;
// returns the session read with the settled turn. `max` ticks.
export async function say(fx, project, run, text, { max = 12 } = {}) {
  const posted = await postTurn(fx, project, run, text);
  const read = await tickUntil(
    fx.engine,
    project,
    async () => {
      const body = await readSession(fx, project, run);
      const turn = (body.turns ?? []).find((t) => t.turn === posted.turn);
      if (turn && ['settled', 'failed', 'unknown'].includes(turn.state)) return body;
      if (body.run?.state === 'ended') return body;
      return undefined;
    },
    { max, what: `turn ${posted.turn} of ${run} to settle` },
  );
  const turn = read.turns.find((t) => t.turn === posted.turn);
  assert.ok(turn, `the read lists turn ${posted.turn}`);
  return { posted, read, turn };
}

// A turn that must have settled with the role's reply accepted.
export async function sayAndSettle(fx, project, run, text, opts) {
  const done = await say(fx, project, run, text, opts);
  assert.equal(done.turn.state, 'settled', `turn ${done.turn.turn} settled (${JSON.stringify(done.turn)})`);
  assert.equal(done.read.run.session_state, 'open_idle', 'the session is idle again');
  return done;
}

// POST …/save {}: 200 {saved, revision, idle_generation, findings}.
export async function saveSession(fx, project, run) {
  const res = await fx.engine.post(`${sessions(project)}/${run}/save`, {});
  assert.equal(res.status, 200, `POST …/save (SEAM.md §344) (→ ${res.status} ${res.text})`);
  return res.body;
}
export async function saveRefused(fx, project, run, status, code) {
  const res = await fx.engine.post(`${sessions(project)}/${run}/save`, {});
  assertRefused(res, status, code, 'the save');
  return res;
}

// POST …/close {refuse?}: 200 {run, saved, decisions}.
export async function closeSession(fx, project, run, body = {}) {
  const res = await fx.engine.post(`${sessions(project)}/${run}/close`, body);
  assert.equal(res.status, 200, `POST …/close (SEAM.md §344) (→ ${res.status} ${res.text})`);
  return res.body;
}
export async function closeRefused(fx, project, run, status, code, body = {}) {
  const res = await fx.engine.post(`${sessions(project)}/${run}/close`, body);
  assertRefused(res, status, code, 'the close');
  return res;
}

// ---- store reads --------------------------------------------------------------------------

export const runRow = (home, run) => getRow(home, 'runs', run);

// The session's transcript record (D6 A.3 `session_transcripts`: one row per
// run, `entries` [{turn, speaker, at, text_ref}]), each entry with its text
// read from the record `text_ref` names where the record file can be read.
export function transcriptEntries(home, run) {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "session_transcripts" WHERE "run" = ?').get(run));
  if (!row) return [];
  const entries = JSON.parse(row.entries ?? '[]');
  return entries.map((e) => {
    let text = null;
    try {
      const record = recordRow(home, e.text_ref);
      const file = record ? recordFile(home, record) : null;
      if (file && existsSync(file)) text = readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    return { ...e, text };
  });
}

// The turns of a session run as the store holds them (D1 A.3 `turns`), in order.
// The column is `number` (D1 A.3; migration 0001); the session read calls it `turn` (§344; objection 073).
export const turnRows = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "turns" WHERE "run" = ? ORDER BY "number"').all(run));

// Ledger rows of a project naming the given run.
export const ledgerRowsOf = (home, project, run) => withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "project" = ? AND "run" = ? ORDER BY rowid').all(project, run));

// The launches of a run's turns, from the scripted log.
export const launchesOfRun = (fx, run) => fx.scripted.launches({ run });

// The context package a turn's role dumped (`turnThatDumps`): {name: text}.
export function packageOf(fx, run, index = 0) {
  const launch = launchesOfRun(fx, run)[index];
  if (!launch) return null;
  const dump = fx.scripted.probes(launch.invocation, 'context_dump').at(-1) ?? fx.scripted.eventsOf(launch.pid, 'probe').find((e) => e.action === 'context_dump');
  if (!dump || dump.outcome !== 'dumped') return null;
  return Object.fromEntries((dump.files ?? []).filter((f) => f.type === 'file').map((f) => [f.name, f.text ?? null]));
}
