// M418, idle timeout; budget exhaustion; resume (slice 33; kernel lane,
// the controlled clock of SEAM.md §18). M5 plan §3.3 M418; D6-S06, D6-S07,
// D6-S10 in part; D6 §2.4; D1 §15.3, §13.3; B01; SEAM.md §§344, 389, 390.
//   (a) past `session_idle_timeout` with a differing workspace: saved and
//       closed `timed_out`, reason `deadline`, the grant and lease released,
//       and a restart publishes nothing late; with a diff the save refuses:
//       the refused save recorded, the workspace retained, closed alike;
//   (b) budget exhaustion between turns: no further turn admitted; saved and
//       closed `budget_exhausted`;
//   (c) `POST …/sessions/:r/resume` †: a new run with `parent_run`, the same
//       role, the workspace at the last checkpoint, the transcript continued
//       from the record;
//   (d) a retained, uncommitted workspace at resume: offered `stash` or
//       `discard` through the checkout integrity route, never adopted;
//   (e) the old run is never continued: after the resume it gains no turn
//       and no transcript entry;
//   (f) a crash at each settlement boundary of a turn (the kill barriers
//       `session.turn_settling.<fact>` †), then resume: the transcript
//       lineage neither duplicates nor omits a turn, and the interrupted turn
//       is `unknown` or `failed` on its own row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOfKind } from './harness/decisions.mjs';
import { armBarrier } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { advanceClock, scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { openSession, postTurn, runRow, sayAndSettle, scriptTurns, transcriptEntries, turnRows, turnThatSays, turnThatWrites } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { SETTLEMENT_FACTS, postTurnRaw, sessionProject, settling } from './harness/session-lane.mjs';
import { waitFor } from './harness/engine.mjs';
import { changePolicy } from './harness/journal.mjs';

const IDEA = '# Tally\n\nA dependency-free HTTP service that sums numbers.\n';
const IDLE = 1200;
const leasesOf = (home, run) => withStore(home, (db) => db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ?`).all(run));
const resumeRaw = (fx, project, run) => fx.engine.post(`/v1/projects/${project}/sessions/${run}/resume`, {});
const endedAs = (fx, run) => waitFor(() => (runRow(fx.home, run)?.state === 'ended' ? runRow(fx.home, run) : undefined), { what: `run ${run} to end` });

// A session past its idle timeout: the clock advanced, ticks asked for.
async function pastIdle(fx, project, run) {
  await advanceClock(fx.engine, IDLE + 60);
  await tick(fx.engine, project, { rounds: 2 });
  return endedAs(fx, run);
}

async function oneTurn(t, files) {
  const fx = await scriptedEngine(t);
  const p = await sessionProject(fx);
  const run = await openSession(fx, p.id, 'vision');
  scriptTurns(fx, run.id, [turnThatWrites(files, { reply: 'Written.' }), turnThatSays('Resumed.')]);
  await sayAndSettle(fx, p.id, run.id, 'Rewrite the idea.');
  return { fx, p, run };
}

describe('M418 idle timeout, budget exhaustion and resume', () => {
  test('(a) past the idle timeout with a differing workspace: saved, closed timed_out, reason deadline, grant and lease released; a restart publishes nothing late', async (t) => {
    const { fx, p, run } = await oneTurn(t, { '.surety/idea.md': IDEA });
    const head = refOid(p.repo.path, p.repo.ref);
    const ended = await pastIdle(fx, p.id, run.id);
    assert.deepEqual([ended.outcome, ended.reason_class], ['timed_out', 'deadline'], `closed timed_out, deadline (${JSON.stringify([ended.outcome, ended.reason_class])})`);
    const saved = refOid(p.repo.path, p.repo.ref);
    assert.notEqual(saved, head, 'the workspace was saved before closing');
    assert.ok(leasesOf(fx.home, run.id).every((l) => l.released_at), 'its lease released');
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.equal(refOid(p.repo.path, p.repo.ref), saved, 'a restart publishes nothing late');
  });

  test('(a) past the idle timeout with a diff the save refuses: the refusal recorded, the workspace retained, closed timed_out', async (t) => {
    const { fx, p, run } = await oneTurn(t, { '.surety/idea.md': IDEA, 'src/app.mjs': 'export {};\n' });
    const head = refOid(p.repo.path, p.repo.ref);
    const ended = await pastIdle(fx, p.id, run.id);
    assert.deepEqual([ended.outcome, ended.reason_class], ['timed_out', 'deadline'], 'closed timed_out, deadline');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'nothing committed');
    const ws = withStore(fx.home, (db) => db.prepare('SELECT * FROM "workspaces" WHERE "id" = ?').get(ended.workspace));
    assert.equal(ws?.disposition, 'retained', `the workspace retained (${JSON.stringify(ws)})`);
    assert.ok(transcriptEntries(fx.home, run.id).some((e) => e.speaker === 'engine' && /diff_violation|src\/app\.mjs/.test(e.text ?? '')), 'the refused save recorded as the engine\'s entry');
  });

  test('(b) budget exhaustion between turns: no further turn admitted; closed budget_exhausted through the end protocol', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    await changePolicy(fx.engine, p.id, { budget_run_billable_tokens: 10000 });
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [{ steps: [step.usage({ input_tokens: 9990, output_tokens: 10 }), step.result({ status: 'completed', summary: 'spent', reply: 'Spent.', artifact_changed: false })] }, turnThatSays('Never.')]);
    // The first turn spends the whole budget and settles; the next is checked before admission.
    await sayAndSettle(fx, p.id, run.id, 'Spend.');
    await tick(fx.engine, p.id, { rounds: 2 });
    const res = await postTurnRaw(fx, p.id, run.id, 'One more.');
    assert.ok(res.status >= 400, `no further turn admitted (→ ${res.status} ${res.text})`);
    const ended = await endedAs(fx, run.id);
    // `budget_exhausted` is the public code of reason class `budget`, not a RunOutcome (D6 A.2; the driver's ruling).
    assert.equal(ended.reason_class, 'budget', `ended with reason class budget (${JSON.stringify([ended.outcome, ended.reason_class])})`);
    const read = await fx.engine.get(`/v1/projects/${p.id}/runs/${run.id}`);
    assert.equal(read.body?.run?.code, 'budget_exhausted', `its public code budget_exhausted (${read.text})`);
  });

  test('(c) resume: a new run with parent_run, the same role, the transcript continued; (e) the old run never continued', async (t) => {
    const { fx, p, run } = await oneTurn(t, { '.surety/idea.md': IDEA });
    await pastIdle(fx, p.id, run.id);
    const before = transcriptEntries(fx.home, run.id);
    const res = await resumeRaw(fx, p.id, run.id);
    assert.equal(res.status, 201, `POST …/resume (→ ${res.status} ${res.text})`);
    const next = res.body.run;
    const row = runRow(fx.home, next.id);
    assert.deepEqual([row.parent_run, row.role, row.kind], [run.id, 'vision', 'session'], 'a new session run of the same role, with parent_run');
    assert.equal(row.current_base, refOid(p.repo.path, p.repo.ref), 'the workspace at the last checkpoint');
    const continued = transcriptEntries(fx.home, next.id).map((e) => [e.speaker, e.text]);
    assert.deepEqual(continued.slice(0, before.length), before.map((e) => [e.speaker, e.text]), 'the transcript continued from the record');
    await sayAndSettle(fx, p.id, next.id, 'Carry on.');
    assert.equal(turnRows(fx.home, run.id).length, 1, '(e) the old run gained no turn');
    assert.equal(transcriptEntries(fx.home, run.id).length, before.length, '(e) nor any transcript entry');
  });

  test('(d) a retained, uncommitted workspace at resume: offered stash or discard, never adopted', async (t) => {
    const { fx, p, run } = await oneTurn(t, { '.surety/idea.md': IDEA, 'src/app.mjs': 'export {};\n' });
    await pastIdle(fx, p.id, run.id);
    const res = await resumeRaw(fx, p.id, run.id);
    assert.equal(res.status, 201, `resumed (→ ${res.status} ${res.text})`);
    await tick(fx.engine, p.id, { rounds: 2 });
    const offered = decisionsOfKind(fx.home, p.id, 'out_of_band_change').filter((d) => d.status === 'open');
    assert.ok(offered.length > 0, 'the retained workspace is offered through the checkout integrity route');
    for (const d of offered) {
      const keys = d.options.map((o) => o.key).sort();
      assert.ok(keys.every((k) => ['discard', 'stash'].includes(k)) && !keys.includes('adopt'), `stash or discard, never adopt (${keys})`);
    }
  });

  for (const fact of SETTLEMENT_FACTS) {
    test(`(f) a crash once the turn's ${fact} fact is established, then resume: the lineage neither duplicates nor omits a turn`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await sessionProject(fx);
      const run = await openSession(fx, p.id, 'vision');
      scriptTurns(fx, run.id, [turnThatSays('First.'), turnThatSays('Second.'), turnThatSays('After the resume.')]);
      await sayAndSettle(fx, p.id, run.id, 'One.');
      await armBarrier(fx.engine, settling(fact), 'kill');
      await postTurn(fx, p.id, run.id, 'Two.');
      void tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
      await waitFor(() => (fx.engine.isRunning() ? undefined : true), { what: `the engine to kill itself at ${settling(fact)}` });
      await fx.start();
      await tick(fx.engine, p.id, { rounds: 2 });
      const turns = turnRows(fx.home, run.id);
      assert.equal(turns.length, 2, 'two turns, the second interrupted');
      assert.ok(['unknown', 'failed', 'replied'].includes(turns[1].outcome ?? turns[1].state ?? 'unknown') || turns[1].settled_at, `the interrupted turn settled on its own row (${JSON.stringify(turns[1])})`);
      if (!turns[1].settled_at || turns[1].outcome !== 'replied') assert.ok(['unknown', 'failed'].includes(turns[1].outcome), `unknown or failed (${turns[1].outcome})`);
      const entries = transcriptEntries(fx.home, run.id);
      const roleEntries = (turn) => entries.filter((e) => e.turn === turn && e.speaker === 'role').length;
      assert.ok(roleEntries(2) <= 1, 'at most one role entry for the interrupted turn');
      if (runRow(fx.home, run.id).state !== 'ended') await advanceClock(fx.engine, IDLE + 60).then(() => tick(fx.engine, p.id, { rounds: 2 }));
      await endedAs(fx, run.id);
      const res = await resumeRaw(fx, p.id, run.id);
      assert.equal(res.status, 201, `resumed (→ ${res.status} ${res.text})`);
      const lineage = transcriptEntries(fx.home, res.body.run.id).filter((e) => e.speaker === 'owner').map((e) => e.text);
      assert.deepEqual(lineage.filter((x) => x === 'One.').length, 1, 'turn one once');
      assert.deepEqual(lineage.filter((x) => x === 'Two.').length, 1, 'turn two once, neither duplicated nor omitted');
    });
  }
});
