// M65, retention and corrupt evidence (slice 4). Plan §3.6 M65; D1 §§14.3,
// 16, D1-16, D1-23; Review N05; SEAM.md §58.
//
// A record nothing refers to any more expires when its retention has passed:
// its row stays, with its identity, and its content is gone and is not
// served as if it were empty. A record that live work refers to is kept.
// Referenced bytes that are missing or corrupt when the engine starts are
// found by the recovery step, before full mode, and reading such a record
// is refused: missing evidence is never an empty record.
//
// Deferred (COVERAGE.md), all to slice 5: retention held by an open
// decision, a finding, a gate evaluation, a pending effect intent or a
// pending journal entry (nothing of those refers to a record before then),
// and missing evidence blocking the gates and effects that depend on it.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { runToHold } from './harness/gitruns.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { assertRecordHolds, readRecord, recordFile, recordRow } from './harness/records.mjs';
import { addProject, addWork, advanceClock, runsOf, scriptedEngine, stopRun, tick, tickUntil, waitForRunState, waitForWork, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

const RETENTION_DAYS = 90; // record_retention_days, the default (contract/config.json)
const SAID = 'what the stopped role had written\n';

// A run stopped while its role was waiting: its work is held, which is live
// work, and its transcript is a published record that work refers to.
async function heldWork(fx, project) {
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [script.hold('gate', { before: [step.stdout(SAID)], heartbeat_ms: 0 })]);
  const { run } = await runToHold(fx, project, item);
  await stopRun(fx.engine, project, run.id);
  const ended = await waitForRunState(fx.home, run.id, 'ended');
  await waitForWork(fx.home, item, 'held');
  await assertRecordHolds(fx.engine, project, ended.transcript, { kind: 'transcript', content: SAID });
  return { item, run: ended, transcript: recordRow(fx.home, ended.transcript) };
}

describe('M65 retention', () => {
  test('a record nothing refers to expires and keeps its identity without its content; a record of live work is retained', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const finished = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(finished, [script.complete([step.stdout('work that is over\n')])]);
    await tickUntil(fx.engine, project, () => workItem(fx.home, finished).status === 'complete', { what: 'the first item to complete' });
    const [over] = runsOf(fx.home, finished);
    const unreferenced = [over.transcript, over.result].map((id) => recordRow(fx.home, id));
    const live = await heldWork(fx, project);
    for (const record of unreferenced) assert.equal((await readRecord(fx.engine, project, record.id)).status, 200, 'before its retention has passed the record is served');

    await advanceClock(fx.engine, (RETENTION_DAYS + 1) * 86_400);
    await tick(fx.engine, project);
    await waitFor(() => unreferenced.every((record) => recordRow(fx.home, record.id).path === null), { what: 'the unreferenced records to expire' });

    for (const before of unreferenced) {
      const now = recordRow(fx.home, before.id);
      const identity = (record) => ({ id: record.id, kind: record.kind, sha256: record.sha256, bytes: record.bytes, published: record.published });
      assert.deepEqual(identity(now), identity(before), `record ${before.id} keeps its row: identity, kind, hash and length`);
      assert.equal(existsSync(recordFile(fx.home, before)), false, 'its bytes are gone');
      assert.equal(eventsOfType(fx.home, 'record.expired').filter((e) => e.subject.record === before.id).length, 1, 'one record.expired');
      assertRefused(await readRecord(fx.engine, project, before.id), 410, 'record_expired', 'reading an expired record');
    }
    await assertRecordHolds(fx.engine, project, live.transcript.id, { kind: 'transcript', content: SAID });
    assert.equal(eventsOfType(fx.home, 'record.expired').length, unreferenced.length, 'nothing that live work refers to expired');
  });
});

describe('M65 referenced bytes that are missing or corrupt at startup', () => {
  const DAMAGE = {
    removed: (file) => rmSync(file),
    corrupted: (file) => {
      const bytes = readFileSync(file);
      bytes[0] ^= 0xff;
      writeFileSync(file, bytes);
    },
  };

  for (const [how, damage] of Object.entries(DAMAGE)) {
    test(`bytes ${how} while the engine was down are found by the recovery step, and the record is refused, not served empty`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = (await addProject(fx)).id;
      const { transcript } = await heldWork(fx, project);
      await fx.engine.stop();
      damage(recordFile(fx.home, transcript));

      const engine = await fx.start();
      assert.equal((await engine.engineInfo()).mode, 'full', 'missing evidence does not keep the engine restricted');
      const found = eventsOfType(fx.home, 'record.missing').filter((e) => e.subject.record === transcript.id);
      assert.equal(found.length, 1, 'one record.missing for the record');
      assert.ok(found[0].seq < eventsOfType(fx.home, 'engine.mode_changed').at(-1).seq, 'it was found before this incarnation reached full mode');
      const res = await readRecord(engine, project, transcript.id);
      assertRefused(res, 409, 'record_missing', 'reading a record whose bytes are missing or corrupt');
      assert.equal(recordRow(fx.home, transcript.id).sha256, transcript.sha256, 'the row still says what the record was');
    });
  }
});
