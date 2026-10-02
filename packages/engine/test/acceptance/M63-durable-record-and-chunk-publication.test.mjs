// M63, durable record and chunk publication (slice 4). Plan §3.6 M63; D1
// §14.1, D1-23, D1-26; build spec §6 correction 21; Review B17; SEAM.md §56.
//
// A role's output is streamed into a record: chunk by chunk into a file
// under the engine home, each chunk with a receipt once its bytes are
// durable, and published as a record only when the stream has ended. The
// stream's identity exists before its first receipt, and a stream that is
// not published is never a record anyone may depend on. The engine is
// killed at the four points the Plan names; after each, every chunk receipt
// still has its parent and its retained bytes, nothing is published that is
// not whole, and the work goes on.
//
// The last case is the cap on a role's output that the slice-2 review asked
// for (E25): output beyond the cap is not retained, and a transcript that
// does not hold all the role wrote is not published as one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { TRANSCRIPT_CAP, assertRecordHolds, assertRecordsSound, chunkReceipts, readRecord, recordFile, recordRow, recordsOf, waitForPostScan } from './harness/records.mjs';
import { addProject, addWork, assertRunEnded, countOf, requestTick, resumeWork, run as runRow, runsOf, scriptedEngine, tickUntil, waitForRunState, workItem } from './harness/runs.mjs';
import { RESULT_LINE, VALID_RESULT, step, usageLine } from './harness/scripted.mjs';

const MIB = 1 << 20;
const USAGE = { input_tokens: 5 };

// A role that writes `bytes` of filler, a usage line and a valid result, and
// what its standard output then is, byte for byte.
const roleWriting = (bytes) => ({ steps: [step.stdoutFill(bytes), step.stdout('\n'), step.usage(USAGE), step.result()] });
const outputOf = (bytes) => `${'x'.repeat(bytes)}\n${usageLine(USAGE)}\n${RESULT_LINE}\n`;

async function fixture(t, { bytes, barriers = [] }) {
  const fx = await scriptedEngine(t, { barriers });
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.defaultScript(roleWriting(bytes));
  return { fx, project, item };
}

// The Plan's four crash points, as barriers (SEAM.md §56), with what the
// store and the records directory must show when the engine has been killed
// there, and again after the restart.
const CRASHES = [
  {
    name: 'before the stream is registered',
    barrier: 'stream.before_registration',
    killed: ({ fx, project }) => {
      assert.deepEqual(recordsOf(fx.home, project, 'transcript'), [], 'no stream identity yet');
      assert.equal(countOf(fx.home, 'stream_chunk_receipts'), 0, 'and so no chunk receipt');
    },
    restarted: ({ fx, project, run }) => {
      assert.equal(recordsOf(fx.home, project, 'transcript').filter((r) => r.published === 1).length, 0, 'nothing was published for the interrupted stream');
      assert.equal(runRow(fx.home, run.id).transcript, null);
    },
  },
  {
    name: 'after a durable chunk',
    barrier: 'stream.chunk_durable',
    killed: ({ fx, project }) => {
      const [stream, ...more] = recordsOf(fx.home, project, 'transcript');
      assert.ok(stream && more.length === 0, 'one stream');
      assert.equal(stream.published, 0, 'the stream is not a published record');
      assert.ok(chunkReceipts(fx.home, stream.id).length >= 1, 'it has a receipt for the chunk that is durable');
      return { stream, receipts: chunkReceipts(fx.home, stream.id) };
    },
    restarted: async ({ fx, project, run, seen }) => {
      const now = recordRow(fx.home, seen.stream.id);
      assert.equal(now.published, 0, 'recovery does not publish a stream it cannot know to be whole');
      assert.deepEqual(chunkReceipts(fx.home, now.id).slice(0, seen.receipts.length), seen.receipts, 'the receipts that were durable are still there, unchanged');
      assert.equal(runRow(fx.home, run.id).transcript, null, 'the run does not name it as its transcript');
      assertRefused(await readRecord(fx.engine, project, now.id), 409, 'record_unpublished', 'reading an unpublished stream');
    },
  },
  {
    name: 'before the final rename',
    barrier: 'stream.before_rename',
    killed: ({ fx, project }) => {
      const [stream] = recordsOf(fx.home, project, 'transcript');
      assert.equal(stream?.published, 0, 'not published before its rename');
      return { stream };
    },
    restarted: async ({ fx, project, run, seen, output }) => {
      // Fully published or not at all (D1-23): never published with less than the role wrote.
      const now = recordRow(fx.home, seen.stream.id);
      if (now.published === 1) await assertRecordHolds(fx.engine, project, now.id, { kind: 'transcript', content: output });
      else assert.equal(runRow(fx.home, run.id).transcript, null);
    },
  },
  {
    name: 'after publication, before anything refers to the record',
    barrier: 'stream.published',
    killed: ({ fx, project, output }) => {
      const [stream] = recordsOf(fx.home, project, 'transcript');
      assert.equal(stream?.published, 1, 'published');
      assert.equal(sha256Hex(readFileSync(recordFile(fx.home, stream))), sha256Hex(output), 'and whole');
      return { stream };
    },
    restarted: async ({ fx, project, run, seen, output }) => {
      await assertRecordHolds(fx.engine, project, seen.stream.id, { kind: 'transcript', content: output });
      assert.ok([null, seen.stream.id].includes(runRow(fx.home, run.id).transcript), 'the run names that record or none');
    },
  },
];

describe('M63 a role\'s output is streamed into a durable record', () => {
  test('long output is retained chunk by chunk and published whole when the role has ended', async (t) => {
    const { fx, project, item } = await fixture(t, { bytes: 3 * MIB });
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete' });
    const [run] = runsOf(fx.home, item);
    assertRunEnded(fx.home, run.id, { outcome: 'completed' });
    assertRecordsSound(fx.home, project);

    const transcript = await assertRecordHolds(fx.engine, project, run.transcript, { kind: 'transcript', content: outputOf(3 * MIB) });
    assert.ok(chunkReceipts(fx.home, transcript.id).length >= 3, 'more than 3 MiB in chunks of at most 1 MiB');
    const result = recordRow(fx.home, run.result);
    assert.deepEqual([result.kind, result.published], ['result', 1]);
    assert.deepEqual(JSON.parse(readFileSync(recordFile(fx.home, result), 'utf8')), VALID_RESULT, 'the result record holds the result the role sent');
    for (const id of [transcript.id, result.id]) {
      assert.equal(eventsOfType(fx.home, 'record.written').filter((e) => e.subject.record === id).length, 1, `one record.written for ${id}`);
      await waitForPostScan(fx.home, id, 'clean');
    }
  });

  for (const crash of CRASHES) {
    test(`the engine is killed ${crash.name}: every receipt keeps its parent and its bytes, nothing partial is published, and the work goes on`, async (t) => {
      const bytes = 2 * MIB + MIB / 2;
      const output = outputOf(bytes);
      const { fx, project, item } = await fixture(t, { bytes, barriers: [`${crash.barrier}=kill`] });
      const dead = fx.engine;
      await requestTick(dead, project).catch(() => {});
      assert.deepEqual(await dead.exited, { code: null, signal: 'SIGKILL' }, 'the engine killed itself at the barrier');
      const [run] = runsOf(fx.home, item);
      assertRecordsSound(fx.home, project);
      const seen = crash.killed({ fx, project, output });

      await fx.start();
      await waitForRunState(fx.home, run.id, 'ended');
      assertRunEnded(fx.home, run.id);
      assertRecordsSound(fx.home, project);
      await crash.restarted({ fx, project, run, seen, output });

      // The work goes on: after an explicit Resume if recovery held it, a new run streams and publishes its transcript.
      if (workItem(fx.home, item).status === 'held') await resumeWork(fx.engine, project, item);
      await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the work to complete after the restart' });
      const last = runsOf(fx.home, item).at(-1);
      if (last.id !== run.id) await assertRecordHolds(fx.engine, project, last.transcript, { kind: 'transcript', content: output });
      assertRecordsSound(fx.home, project);
    });
  }

  test('output beyond the cap is not retained, what follows it is still acted on, and the incomplete transcript is not published', async (t) => {
    const { fx, project, item } = await fixture(t, { bytes: TRANSCRIPT_CAP + MIB });
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete' });
    const [run] = runsOf(fx.home, item);
    assertRunEnded(fx.home, run.id, { outcome: 'completed' });
    assert.equal(countOf(fx.home, 'usage_observations'), 1, 'the usage line after the overflow was read');
    assertRecordsSound(fx.home, project);

    const [stream, ...more] = recordsOf(fx.home, project, 'transcript');
    assert.ok(stream && more.length === 0, 'one transcript stream');
    assert.equal(stream.published, 0, 'a transcript that does not hold all the role wrote is not published');
    assert.equal(run.transcript, null);
    const retained = chunkReceipts(fx.home, stream.id).reduce((sum, receipt) => sum + receipt.length, 0);
    assert.ok(retained > 0 && retained <= TRANSCRIPT_CAP, `at most ${TRANSCRIPT_CAP} bytes are retained (${retained})`);
    assert.equal(recordRow(fx.home, run.result)?.published, 1, 'the result has its record all the same');
  });
});
