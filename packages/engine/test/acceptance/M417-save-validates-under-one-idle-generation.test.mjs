// M417, save validates; one idle generation (slice 33; kernel lane). M5 plan
// §3.3 M417; D6-S04; D6 §2.4, §2.5; D1 §7.3; B01; SEAM.md §§344, 389.
//   (a) a save at `open_idle`: a `checkpoint` commit through the journal,
//       `current_base` advanced, the idle generation unchanged;
//   (b) a diff outside the role's permitted paths: refused whole,
//       `diff_violation`, the workspace retained, the refusal the engine's
//       transcript entry before the next turn;
//   (c) a save at `turn_running`: `session_not_idle` (409);
//   (d) a save and a turn admitted against the same idle generation, and a
//       save against a close, each held at `session.admission` †: exactly
//       one winner, the other `session_generation_stale` (409), never
//       queued; a save while the turn's collection is in flight (held at
//       `session.turn_settling.terminated` †): refused, never a save of an
//       unmaterialized workspace;
//   (e) a checkpoint makes no `spec_revisions`, baseline, stage or work row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { projectRow, revisionRows, specRevisions, stagesOfProject, workOf } from './harness/journey/drive.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { openSession, readSession, runRow, saveSession, sayAndSettle, scriptTurns, transcriptEntries, turnThatSays, turnThatWrites } from './harness/sessions.mjs';
import { ADMISSION, assertOneWinner, idleGeneration, pauseAt, postCloseRaw, postSaveRaw, postTurnRaw, reached, release, sessionProject, settling } from './harness/session-lane.mjs';

const IDEA = '# Tally\n\nA dependency-free HTTP service that sums numbers.\n';

async function idleWithEdit(t, extraTurns = []) {
  const fx = await scriptedEngine(t);
  const p = await sessionProject(fx);
  const run = await openSession(fx, p.id, 'vision');
  scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA }, { reply: 'Rewritten.' }), ...extraTurns]);
  await sayAndSettle(fx, p.id, run.id, 'Rewrite the idea.');
  return { fx, p, run };
}

describe('M417 save validates under one idle generation', () => {
  test('(a) a save at open_idle commits a checkpoint through the journal, advances current_base, keeps the idle generation; (e) and changes no baseline', async (t) => {
    const { fx, p, run } = await idleWithEdit(t);
    const before = { generation: idleGeneration(fx.home, run.id), base: runRow(fx.home, run.id).current_base, head: refOid(p.repo.path, p.repo.ref), specs: specRevisions(fx.home, p.id).length, stages: stagesOfProject(fx.home, p.id).length, work: workOf(fx.home, p.id).length, baseline: projectRow(fx.home, p.id).baseline_state };
    const saved = await saveSession(fx, p.id, run.id);
    assert.equal(saved.saved, true, 'saved');
    assert.equal(saved.idle_generation, before.generation, 'the idle generation unchanged by a save');
    assert.equal(idleGeneration(fx.home, run.id), before.generation, 'and in the store');
    assert.notEqual(refOid(p.repo.path, p.repo.ref), before.head, 'the integration branch moved by the checkpoint');
    assert.equal(runRow(fx.home, run.id).current_base, saved.revision, 'current_base advanced to the checkpoint');
    assert.ok(revisionRows(fx.home, p.id).some((r) => r.kind === 'checkpoint' && r.sha === saved.revision), `a checkpoint revision recorded (${JSON.stringify(revisionRows(fx.home, p.id).map((r) => r.kind))})`);
    assert.deepEqual(
      [specRevisions(fx.home, p.id).length, stagesOfProject(fx.home, p.id).length, workOf(fx.home, p.id).length, projectRow(fx.home, p.id).baseline_state],
      [before.specs, before.stages, before.work, before.baseline],
      '(e) no spec revision, stage, work or baseline change from a save',
    );
  });

  test('(b) a diff outside the role\'s paths: refused whole, diff_violation naming the path, the workspace retained, the refusal the engine\'s entry before the next turn', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA, 'src/app.mjs': 'export {};\n' }, { reply: 'Also some code.' }), turnThatSays('Understood.')]);
    await sayAndSettle(fx, p.id, run.id, 'Rewrite the idea.');
    const head = refOid(p.repo.path, p.repo.ref);
    const res = await postSaveRaw(fx, p.id, run.id);
    assertRefused(res, 422, 'diff_violation', 'a save touching src/');
    assert.match(JSON.stringify(res.body.subject), /src\/app\.mjs/, 'naming the path');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'refused whole: nothing committed');
    assert.equal((await readSession(fx, p.id, run.id)).run.session_state, 'open_idle', 'the session idle, its workspace retained');
    await sayAndSettle(fx, p.id, run.id, 'Why was it refused?');
    const entries = transcriptEntries(fx.home, run.id);
    const refusal = entries.findIndex((e) => e.speaker === 'engine' && /diff_violation|src\/app\.mjs/.test(e.text ?? ''));
    const reply2 = entries.findIndex((e) => e.speaker === 'role' && e.turn === 2);
    assert.ok(refusal >= 0, `the refusal is the engine's transcript entry (${JSON.stringify(entries.map((e) => [e.turn, e.speaker, (e.text ?? '').slice(0, 60)]))})`);
    assert.ok(reply2 < 0 || refusal < reply2, 'recorded before the next turn\'s reply, so its package carries it');
  });

  test('(c) a save at turn_running: session_not_idle', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatSays('Hello.')]);
    const posted = await postTurnRaw(fx, p.id, run.id, 'Hi.');
    assert.equal(posted.status, 202, posted.text);
    assertRefused(await postSaveRaw(fx, p.id, run.id), 409, 'session_not_idle', 'a save while the turn runs');
  });

  test('(d) a save and a turn against one idle generation; a save and a close: exactly one winner, the loser session_generation_stale', async (t) => {
    for (const [label, other] of [
      ['a save and a turn', (fx, p, run) => postTurnRaw(fx, p.id, run.id, 'Next.')],
      ['a save and a close', (fx, p, run) => postCloseRaw(fx, p.id, run.id, { refuse: true })],
    ]) {
      const { fx, p, run } = await idleWithEdit(t, [turnThatSays('Next.')]);
      await pauseAt(fx, ADMISSION);
      const held = postSaveRaw(fx, p.id, run.id);
      await reached(fx, ADMISSION, `${label}: the save's admission`);
      const second = await other(fx, p, run);
      await release(fx, ADMISSION);
      const first = await held;
      assertOneWinner([first, second], label);
    }
  });

  test('(d) a save while the turn\'s collection is in flight: refused, never a save of an unmaterialized workspace', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA }, { reply: 'Rewritten.' })]);
    await pauseAt(fx, settling('terminated'));
    const posted = await postTurnRaw(fx, p.id, run.id, 'Rewrite.');
    assert.equal(posted.status, 202, posted.text);
    void tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
    await reached(fx, settling('terminated'), 'the turn held after its domain terminated, before collection');
    const head = refOid(p.repo.path, p.repo.ref);
    assertRefused(await postSaveRaw(fx, p.id, run.id), 409, 'session_not_idle', 'a save while collection is in flight');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'nothing committed');
    await release(fx, settling('terminated'));
  });
});
