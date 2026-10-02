// M74, accepted fixture semantics (slice 6). Plan §3.7 M74; RN §3 N06; D1
// §§7.3, 7.4, 9.6, 11.2, 11.3, 13.1, D1-10, D1-21; Review N03 and N06;
// SEAM.md §95. The row's source inspections are in
// `M74-invocation-boundary.test.mjs` and `M74-seam-confinement.test.mjs`.
//
// The screens Sean accepted show four states that the review found the
// mockups stating loosely. Each must be a state the kernel's API really
// produces, and none may claim a success that has not happened:
//
//   - a checkpoint a running role has asked for is pending, not a
//     checkpoint: M1 takes no snapshot while writers remain;
//   - an accepted one-shot checkpoint belongs to its ended run, and the work
//     that continues from it shows the successor run;
//   - a project that dispatched nothing has no cost, which is not a cost of
//     zero; a dispatched role that reported zero has a measured zero;
//   - an applied protected correction leaves the old candidate bound to the
//     version it was nominated under, without a satisfied gate to show, and
//     points to the successor candidate; nobody is deployed.
//
// Every state is made by the engine's own paths (a scripted role, a tick, a
// decision); only what the Plan lets in as a fixture is a fixture. The API's
// answer is compared with the durable rows.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROTECTED_FILES, capturedProposal, check, effectiveVersion, evaluationsOf, installChecks, nominated, passAll, reasonCodes, reviewerApproves, stageGate, successor, waitApplied } from './harness/gates.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { revisionsOf } from './harness/journal.mjs';
import { awayFromMidnight, getLedger } from './harness/ledger.mjs';
import { until } from './harness/mono.mjs';
import { readCandidate, readProject, readRun } from './harness/reads.mjs';
import { addProject, addWork, getRow, scriptedEngine, tick, waitForRun, workItem } from './harness/runs.mjs';
import { VALID_RESULT, script, step } from './harness/scripted.mjs';
import { parseJson } from './harness/store.mjs';

const checkpointRevisions = (home, run) => revisionsOf(home, { run }).filter((revision) => revision.kind === 'checkpoint');

describe('M74 the states the accepted screens show are states the kernel produces', () => {
  test('a checkpoint that a running role has asked for is pending, and is no checkpoint: nothing is snapshotted or committed while the role lives, and the run read says so', async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    // The role asks for a checkpoint in its result and goes on running.
    fx.scripted.script(item, [{ steps: [permittedEdit(), step.result({ ...VALID_RESULT, checkpoint: true }), step.hold('gate', { heartbeat_ms: 0 })] }]);
    await tick(engine, project.id);
    // Whether a run whose role has sent its result and lives on is still
    // `executing` or already `validating` is the engine's choice (SEAM.md §95).
    const run = await waitForRun(fx.home, item, { state: ['executing', 'validating'] });
    await fx.scripted.waitForHolding({ run: run.id });

    const pending = await until(async () => ((await readRun(engine, project.id, run.id)).checkpoint ? readRun(engine, project.id, run.id) : undefined), { timeoutMs: 15_000, what: 'the run read to show the checkpoint request' });
    assert.deepEqual(pending.checkpoint, { status: 'pending', revision: null }, 'the request is shown as pending, with no revision');
    assert.ok(['executing', 'validating'].includes(pending.state), `the run has not ended (${pending.state})`);
    assert.equal(fx.scripted.isLive(fx.scripted.launches({ run: run.id })[0]), true, 'its role is alive');
    const workspace = getRow(fx.home, 'workspaces', run.workspace);
    assert.deepEqual([workspace.snapshot_tree, parseJson(workspace.checkpoints) ?? []], [null, []], 'no snapshot was taken while the role lives, and the workspace has no checkpoint');
    assert.deepEqual(checkpointRevisions(fx.home, run.id), [], 'no checkpoint revision exists');
    assert.equal(workItem(fx.home, item).status, 'executing', 'and the work is where it was');

    // Once the role is gone the engine may snapshot: the request becomes a checkpoint.
    fx.scripted.release(item);
    const ended = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
    assert.equal(ended.outcome, 'completed', ended.reason_text ?? '');
    const [revision] = checkpointRevisions(fx.home, run.id);
    assert.ok(revision, 'the checkpoint was committed after the role had ended');
    assert.deepEqual((await readRun(engine, project.id, run.id)).checkpoint, { status: 'accepted', revision: revision.id }, 'and only then is it shown as accepted, with its revision');
  });

  test('an accepted one-shot checkpoint is linked to its ended run, and the work that continues from it shows the successor run, once there is one', async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()], { checkpoint: true }), roleThat([step.write('src/second.js', 'export const second = 2;\n')])]);

    const first = await runToEnd(fx, project.id, item);
    assert.equal(first.outcome, 'completed', first.reason_text ?? '');
    const [revision] = checkpointRevisions(fx.home, first.id);
    assert.ok(revision, 'the fixture is live: the first run made a checkpoint');
    const before = await readRun(engine, project.id, first.id);
    assert.deepEqual([before.state, before.checkpoint, before.successor_run], ['ended', { status: 'accepted', revision: revision.id }, null], 'the checkpoint belongs to an ended run, and no successor is claimed before one exists');

    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assert.equal(second.outcome, 'completed', second.reason_text ?? '');
    assert.equal((await readRun(engine, project.id, first.id)).successor_run, second.id, 'the checkpointing run names the run that continued its work');
    const continued = await readRun(engine, project.id, second.id);
    assert.deepEqual([continued.parent_run, continued.checkpoint, continued.successor_run], [first.id, null, null], 'the successor names its parent, asked for no checkpoint, and has no successor');
    assert.equal(getRow(fx.home, 'runs', second.id).parent_run, first.id, 'as the stored run does');
  });

  test('no dispatch differs from a measured zero: a project that dispatched nothing shows no cost; a project whose role reported a cost of zero shows zero', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const untouched = (await addProject(fx)).id;
    const zero = (await addProject(fx)).id;
    const item = await addWork(engine, zero, 'verification');
    fx.scripted.script(item, [script.complete([step.usage({ input_tokens: 5, output_tokens: 2, cost_usd: 0 })])]);
    await tick(engine, zero);
    await waitForRun(fx.home, item, { state: 'ended' });

    const nothing = (await readProject(engine, untouched)).project.spend_today;
    assert.deepEqual([nothing.no_dispatch, nothing.invocations, nothing.reported_usd], [true, 0, null], 'nothing was dispatched: no dispatch, and no amount');
    assert.deepEqual((await getLedger(engine, untouched)).rows, [], 'and no ledger row');

    const measured = (await readProject(engine, zero)).project.spend_today;
    assert.deepEqual([measured.no_dispatch, measured.invocations, measured.reported_usd, measured.unknown_cost_invocations], [false, 1, 0, 0], 'a dispatched role that reported zero: one invocation, a known cost of zero');
    const [row] = (await getLedger(engine, zero)).rows;
    assert.deepEqual([row.cost_status, row.cost_usd], ['measured_zero', 0], 'with its ledger row saying the zero was measured');
  });

  test('an applied protected correction leaves the old candidate under the version it was nominated with, with no satisfied gate to show, and names the successor candidate; no candidate is shown as deployed', async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const login = check('login', { requirements: ['R1'] });
    const ctx = await nominated(fx, { files: PROTECTED_FILES });
    const project = ctx.project.id;
    const checks = await installChecks(engine, project, [login]);
    await passAll(engine, project, ctx.candidate.id, [checks.id.login]);
    const satisfied = await stageGate(fx, ctx);
    assert.equal(satisfied.outcome, 'satisfied', `the fixture is live: the stage gate was satisfied before the correction (reasons: ${reasonCodes(satisfied).join(', ')})`);
    const previous = effectiveVersion(fx.home, project);

    // A tightening correction, approved by a Reviewer and applied; then the next candidate.
    const proposal = await capturedProposal(fx, ctx.project, { changeKind: 'tightening' });
    await reviewerApproves(fx, ctx.project, proposal);
    await waitApplied(fx, ctx.project, proposal);
    const version = effectiveVersion(fx.home, project);
    assert.notEqual(version.id, previous.id, 'the fixture is live: a new protected version is in effect');
    const next = await successor(fx, ctx);

    const old = await readCandidate(engine, project, ctx.candidate.id);
    assert.deepEqual(old.protected_version, { nominated: previous.id, effective: version.id }, 'the old candidate shows the version it was nominated under beside the one now in effect');
    assert.equal(old.successor, next.id, 'and names the candidate that succeeds it');
    const latest = evaluationsOf(fx.home, ctx.candidate.id, 'stage').at(-1);
    assert.equal(old.gates?.stage?.id, latest.id, "its stage gate is shown as the latest stored evaluation");
    assert.deepEqual([old.gates.stage.outcome, Boolean(old.gates.stage.stale)], [latest.outcome, latest.stale === 1], 'with that evaluation\'s outcome and staleness');
    assert.equal(old.gates.stage.outcome === 'satisfied' && !old.gates.stage.stale, false, 'which is not a current satisfied gate: the evidence it rested on belongs to the superseded version');

    const fresh = await readCandidate(engine, project, next.id);
    assert.deepEqual(fresh.protected_version, { nominated: version.id, effective: version.id }, 'the successor candidate is under the new version');
    assert.equal(fresh.successor, null, 'it has no successor');
    assert.notEqual(fresh.gates?.stage?.outcome ?? null, 'satisfied', 'and shows no satisfied gate it has not earned');
    for (const candidate of [old, fresh]) assert.equal(candidate.progress, 'developing', 'no candidate is shown as deployed');
  });
});
