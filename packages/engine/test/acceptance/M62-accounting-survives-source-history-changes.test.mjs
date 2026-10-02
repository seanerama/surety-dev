// M62, accounting survives source-history changes (slice 4). Plan §3.6 M62;
// D1 §§1.6, 6.5, 13, D1-02; Review N01; SEAM.md §§54, 55, 59.
//
// The ledger lives in the engine home, not in the repository. Its rows, its
// totals, the records and the budget refusal are the same after the
// developer has switched branches, rebased, squashed and added a linked
// worktree, after the engine has restarted, and after the repository has
// been moved and explicitly bound again. A correction sent again afterwards
// is still the one that was applied. Nothing of the runtime ledger is in a
// tracked tree.
//
// Deferred (COVERAGE.md): "out-of-band changes block gates without hiding
// accounting", to slice 5, with the gates.

import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { rebind } from './harness/backup.mjs';
import { sha256Hex } from './harness/engine.mjs';
import { addGitProject, runToEnd } from './harness/gitruns.mjs';
import { changePolicy, outOfBand } from './harness/journal.mjs';
import { awayFromMidnight, correct, getLedger, invocationOf } from './harness/ledger.mjs';
import { readRecord } from './harness/records.mjs';
import { addLinkedWorktree, gitQuiet } from './harness/repos.mjs';
import { addWork, assertRunEnded, getRow, runsOf, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

// Two invocations. One completed and reported its cost; a correction later
// added 50 output tokens to it. One was stopped by the budget after reporting
// 2,500 tokens of unknown cost against a day limit of 1,000, so its remainder
// is unknown. These are the totals before anything is done to the repository,
// and after.
const TOTALS = { invocations: 2, billable_in: 2300, cached_in: null, out: 650, usage_incomplete: 1, reported_usd: 0.25, estimated_usd: null, unknown_cost_invocations: 1, unknown_cost_tokens: 2500 };
const BUDGET = { exhausted: ['budget_day_unknown_tokens'] };

describe('M62 accounting survives source-history changes', () => {
  test('ledger, records, totals and the budget refusal are the same after branch switches, a rebase, a squash, a linked worktree, a restart, and a moved and rebound repository', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { budget_day_unknown_tokens: 1000 });
    const paid = await addWork(fx.engine, project.id, 'verification');
    const stopped = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(paid, [script.complete([step.stdout('paid work\n'), step.usage({ input_tokens: 300, output_tokens: 100, cost_usd: 0.25 })])]);
    fx.scripted.script(stopped, [script.hold('gate', { before: [step.usage({ input_tokens: 2000, output_tokens: 500 })], heartbeat_ms: 0 })]);
    fx.scripted.defaultScript(script.complete());
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, paid).status === 'complete', { what: 'the first item to complete' });
    assertRunEnded(fx.home, (await runToEnd(fx, project.id, stopped)).id, { outcome: 'stopped', reason_class: 'budget' });
    const [paidRun] = runsOf(fx.home, paid);
    const correction = { invocation: invocationOf(fx.home, paidRun.id), seq: 1, raw: { output_tokens: 50 } };
    assert.equal((await correct(fx.engine, correction)).status, 201);
    // Ready work that the exhausted budget keeps from being dispatched.
    const waiting = await addWork(fx.engine, project.id, 'verification');

    const recordIds = [paidRun.transcript, paidRun.result, runsOf(fx.home, stopped)[0].transcript];
    // Everything the API says about the project's spend, and the content of its records.
    const accounting = async () => {
      const { rows, totals, by_role, budget } = await getLedger(fx.engine, project.id);
      const records = [];
      for (const id of recordIds) {
        const res = await readRecord(fx.engine, project.id, id);
        assert.equal(res.status, 200, `record ${id} is readable (body: ${res.text.slice(0, 200)})`);
        records.push([id, sha256Hex(Buffer.from(res.text))]);
      }
      return { rows, totals, by_role, budget, records };
    };
    const before = await accounting();
    assert.deepEqual(before.totals, TOTALS, 'the totals stated in the fixture');
    assert.deepEqual(before.budget, BUDGET);
    const same = async (after) => {
      await tick(fx.engine, project.id);
      assert.deepEqual(await accounting(), before, `${after}: the same rows, totals, budget refusal and records`);
      assert.equal(runsOf(fx.home, waiting).length, 0, `${after}: the work the budget refuses is still not dispatched`);
    };

    // The developer's history changes: branches, a rebase onto the integration branch, a squash, a linked worktree.
    let repo = project.repo.path;
    gitQuiet(repo, ['switch', '-q', '-c', 'dev/feature']);
    for (const n of [1, 2]) {
      writeFileSync(join(repo, 'notes.txt'), `developer note ${n}\n`);
      gitQuiet(repo, ['add', 'notes.txt']);
      gitQuiet(repo, ['commit', '-q', '-m', `developer: note ${n}`]);
    }
    gitQuiet(repo, ['rebase', '-q', 'main']);
    gitQuiet(repo, ['reset', '-q', '--soft', 'HEAD~2']);
    gitQuiet(repo, ['commit', '-q', '-m', 'developer: both notes, squashed']);
    gitQuiet(repo, ['switch', '-q', '-c', 'dev/other']);
    addLinkedWorktree(repo, join(fx.root, 'linked'), { branch: 'dev/scratch' });
    await same('after the developer\'s branch switches, rebase, squash and linked worktree');
    assert.deepEqual(outOfBand(fx.home, project.id), [], 'none of that touched anything the engine tracks');

    await fx.engine.stop();
    await fx.start();
    const replayed = await correct(fx.engine, correction);
    assert.deepEqual([replayed.status, replayed.body?.created], [200, false], 'the correction sent again after the restart is the one already applied');
    await same('after a restart');

    // The repository is moved while the engine is down, and bound again explicitly.
    await fx.engine.stop();
    const moved = `${repo}-moved`;
    renameSync(repo, moved);
    repo = moved;
    await fx.start();
    await rebind(fx.engine, project.id, moved);
    assert.equal(getRow(fx.home, 'projects', project.id).dev_repo_path, moved);
    await same('after the repository was moved and rebound');

    // No runtime ledger in a tracked tree: every ref holds only what the fixture, the policy change and the developer put there.
    const tracked = new Set(gitQuiet(repo, ['for-each-ref', '--format=%(refname)']).split('\n').flatMap((ref) => gitQuiet(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n')));
    assert.deepEqual([...tracked].sort(), ['.surety/policy.json', 'README.md', 'notes.txt']);
  });
});
