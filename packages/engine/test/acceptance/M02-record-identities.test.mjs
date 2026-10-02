// M02, record identities (slice 4; deferred from slice 2). Plan §3.1 M02
// ("legitimate runs have distinct invocation/domain/workspace/record
// identities"); D1-01; SEAM.md §56. Two runs of the same role each have a
// transcript and a result record of their own.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { assertRecordHolds, assertRecordsSound, recordFile, recordRow } from './harness/records.mjs';
import { addProject, addWork, runsOf, scriptedEngine, tickUntil, workItem } from './harness/runs.mjs';
import { RESULT_LINE, VALID_RESULT, script, step } from './harness/scripted.mjs';

describe('M02 distinct work: records', () => {
  test('two dispatched runs of one role each have their own transcript and result records', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const items = [await addWork(fx.engine, project, 'verification'), await addWork(fx.engine, project, 'verification')];
    const said = ['the first run says this\n', 'the second run says that\n'];
    items.forEach((item, i) => fx.scripted.script(item, [script.complete([step.stdout(said[i])])]));
    await tickUntil(fx.engine, project, () => items.every((id) => workItem(fx.home, id).status === 'complete'), { what: 'both items to complete' });

    const runs = items.map((item) => runsOf(fx.home, item)[0]);
    assertRecordsSound(fx.home, project);
    for (const [i, run] of runs.entries()) {
      await assertRecordHolds(fx.engine, project, run.transcript, { kind: 'transcript', content: `${said[i]}${RESULT_LINE}\n` });
      const result = recordRow(fx.home, run.result);
      assert.deepEqual([result.kind, result.published], ['result', 1]);
      assert.deepEqual(JSON.parse(readFileSync(recordFile(fx.home, result), 'utf8')), VALID_RESULT);
    }
    const ids = runs.flatMap((run) => [run.transcript, run.result]);
    assert.equal(new Set(ids).size, 4, `four records, each its own: ${ids.join(', ')}`);
    assert.equal(new Set(ids.map((id) => recordRow(fx.home, id).path)).size, 4, 'and each in its own file');
  });
});
