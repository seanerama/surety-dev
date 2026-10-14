// M422 (a), (b) under a clock that steps back (slice 36; kernel lane). M5
// plan §3.4 M422; D6 §3.2 ("parsed at every save"), §3.4 (the approval binds
// the session's last save); D1 §7.3; the driver's ruling of 2026-10-13 ("the
// latest" row is by insertion order, never wall time); SEAM.md §§18, 274,
// 425 †. Found and reproduced by the driver: the workstation's clock steps
// back about 1.1 s every ~31 s, and a step between a Spec Writer's two saves
// made `approve` carry `spec_criterion_mismatch:R2.2` from the older save.
//
// The first save is SPEC_DEFECTIVE (R2.2 in the index, absent from §4); the
// engine's clock then steps back; the second save is SPEC; the close raises
// `spec_approval`, whose `approve` carries no blocker, and the owner's
// answer gives spec version 1 with the second save's `semantic_digest`.
//   (1) the step within one engine's life: `POST /v1/harness/clock/advance`
//       with a negative `seconds` † (SEAM §425: the smallest seam that moves
//       the controlled clock back);
//   (2) the step across a restart, with the seams the engine already has: the
//       first save under `--harness-clock-offset 60` (§274), the engine
//       restarted with no offset (its clock 60 s earlier), and the open
//       session continued by its next turn and save.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { closeSession, openSession, sayAndSettle, saveSession, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { createWithIdea, specRevisions, visionSession } from './harness/journey/drive.mjs';
import { SPEC, SPEC_DEFECTIVE } from './harness/journey/reference.mjs';
import { SPEC_PATH, blockersOf, specApproval } from './harness/journey/spec34.mjs';

// The project's spec_semantics rows in the order they were inserted.
const semanticsInOrder = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT s.*, s.rowid AS "seq" FROM "spec_semantics" s JOIN "runs" r ON r."id" = s."run" WHERE r."project" = ? ORDER BY s.rowid').all(project));

// The close's approval: no blocker on `approve`; answered, version 1 with the
// digest of the save inserted last.
async function approvedFromTheLastSave(fx, project, what) {
  const rows = semanticsInOrder(fx.home, project);
  assert.ok(rows.length >= 2, `${what}: the fixture is live: both saves parsed (${rows.length})`);
  const last = rows.at(-1);
  const earlier = rows.at(-2);
  assert.ok(String(earlier.created_at) >= String(last.created_at), `${what}: the fixture is live: the second save's wall time is not after the first's (${earlier.created_at}, then ${last.created_at})`);
  const approval = specApproval(fx.home, project);
  assert.ok(approval, `${what}: the close raised spec_approval`);
  assert.deepEqual(blockersOf(approval), [], `${what}: approve is not blocked by the earlier save's findings: the latest save is the one inserted last, not the one with the latest wall time`);
  await consume(fx, project, approval, 'approve');
  const [v1] = specRevisions(fx.home, project);
  assert.ok(v1, `${what}: spec version 1 approved`);
  assert.equal(v1.version, 1);
  assert.equal(v1.semantic_digest, last.semantic_digest, `${what}: with the second save's semantic_digest, not the first's (${earlier.semantic_digest})`);
}

const TURNS = [turnThatWrites({ [SPEC_PATH]: SPEC_DEFECTIVE }, { reply: 'A first draft.' }), turnThatWrites({ [SPEC_PATH]: SPEC }, { reply: 'The index and section 4 now agree.', done: true })];

describe('M422 the latest save is the one inserted last, whatever the clock says', () => {
  test('(1) the clock steps back 10 s between the two saves (a negative advance †): approve unblocked, version 1 from the second save', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    await visionSession(fx, p.id);
    const run = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, run.id, TURNS);
    await sayAndSettle(fx, p.id, run.id, 'Write the specification.');
    await saveSession(fx, p.id, run.id);
    const back = await fx.engine.post('/v1/harness/clock/advance', { seconds: -10 });
    assert.equal(back.status, 200, `the controlled clock steps back 10 s (SEAM §425 †) (→ ${back.status} ${back.text})`);
    await sayAndSettle(fx, p.id, run.id, 'Fix what the engine reported.');
    await saveSession(fx, p.id, run.id);
    await closeSession(fx, p.id, run.id);
    await approvedFromTheLastSave(fx, p.id, 'a step back within one engine');
  });

  test('(2) the clock 60 s earlier after a restart between the two saves (--harness-clock-offset, then none; the open session continued): approve unblocked, version 1 from the second save', async (t) => {
    const fx = await scriptedEngine(t);
    await fx.engine.kill();
    await fx.start({ args: ['--harness-clock-offset', '60'] });
    const p = await createWithIdea(fx);
    await visionSession(fx, p.id);
    const run = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, run.id, TURNS);
    await sayAndSettle(fx, p.id, run.id, 'Write the specification.');
    await saveSession(fx, p.id, run.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 2 });
    // The open session survives the restart idle and is continued by its turns.
    await sayAndSettle(fx, p.id, run.id, 'Fix what the engine reported.');
    await saveSession(fx, p.id, run.id);
    await closeSession(fx, p.id, run.id);
    await approvedFromTheLastSave(fx, p.id, 'a step back across a restart');
  });
});
