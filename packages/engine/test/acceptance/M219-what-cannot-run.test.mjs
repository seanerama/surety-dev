// M219, what cannot run (M3 slice 18; sandbox lane). M3 plan §3.4 M219;
// D3-R15; D3 §2.7, A.2 `NotRunReason`, A.5 (materializing → recorded);
// D1 §12.3; SEAM.md §§200, 203, 204, 209.
//
// Each reason the runner knows a check did not start for is a row with
// `execution_established` false, `skipped` at the gate, the reason on the
// gate read; the host-level reasons make NOW `refused` with cause
// `check_unrunnable`; `materialization_failed` is registered again as
// `recovery`, at most `check_infra_retries_max` times; a registration
// never attempted has no row and leaves the check `missing`.
//   definition_invalid      a definition whose `cwd` is no directory of the
//                           check tree (SEAM.md §209)
//   toolchain_missing       a `check_commands` program whose path is absent
//                           (the pinned-hash case is M215 (d))
//   mount_plan_refused      `read_paths` naming the engine home
//   materialization_failed  more entries than `checktree_max_entries`;
//                           registered again twice, then no more
//   isolation_unqualified   an operator's re-run on a start whose host check
//                           H5 the harness fails
//   never attempted         a registration held behind the project's one
//                           check slot
// Read elsewhere: `runner_unqualified` (M221 (b)), `environment_unbound`
// (M222 (c)), `exec_failed` (M205 (e)).
//
// SAFETY: the check program only holds at its release file and exits 0, or
// is never started. Nothing is filled: the entries case is 1001 empty
// files, refused before the tree is written.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { stageGate } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  entryByKey,
  executionsOf,
  gateCheckEntries,
  heldExecution,
  holdArgs,
  installCheckProgram,
  qualifyRunnerByFixture,
  requestChecks,
  resultRow,
  sandboxGoverned,
  smoke,
  terminalExecution,
} from './harness/checks/fixtures.mjs';
import { askingForTicks } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import { projectNow, retriesOf } from './harness/checks/execution.mjs';

// The row of a not-run execution and its gate entry (D3 §2.7).
async function assertNotRun(fx, project, stage, candidate, key, reason) {
  const x = await terminalExecution(fx, project.id, candidate.id, key, `${key} to be recorded ${reason}`);
  assert.equal(x.status, 'recorded', `${key}: the runner attempted it and knows it did not start: a row (${x.status})`);
  const r = resultRow(fx.home, x.result);
  assert.deepEqual([r.execution_established, r.not_run_reason, r.exit_status], [0, reason, null], `${key}: execution_established false, ${reason}`);
  assert.equal(x.not_run_reason, reason, `${key}: the execution carries the reason`);
  const entry = entryByKey(gateCheckEntries(await stageGate(fx, { project, stage }, candidate)), key);
  assert.deepEqual([entry.state, entry.not_run_reason], ['skipped', reason], `${key}: skipped, the reason on the gate read`);
  return x;
}

describe('M219 what cannot run', () => {
  test('definition_invalid, toolchain_missing: a row each, skipped, the reason on the gate read; NOW refused, check_unrunnable', async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const withGone = sandboxGoverned(prog, { check_commands: { probe: { path: prog.program }, gone: { path: join(prog.dir, 'no-such-program') } } });
    const files = {
      [GOVERNED_FILE]: withGone,
      [defPath('nocwd')]: smoke('nocwd', { command: ['probe', 'exit', '0'], cwd: 'not-in-the-tree', gates: ['stage'] }),
      [defPath('noprog')]: smoke('noprog', { command: ['gone'], gates: ['stage'] }),
    };
    const project = await checkProject(fx, { files });
    const { stage, candidate } = await buildStage(fx, project);
    await assertNotRun(fx, project, stage, candidate, 'nocwd', 'definition_invalid');
    await assertNotRun(fx, project, stage, candidate, 'noprog', 'toolchain_missing');
    const now = await projectNow(fx.engine, project.id);
    assert.deepEqual([now.state, now.cause], ['refused', 'check_unrunnable'], `a host-level reason makes NOW refused, check_unrunnable (D3 §2.7; SEAM.md §209) (now: ${JSON.stringify(now)})`);
  });

  test('mount_plan_refused; materialization_failed registered again as recovery at most check_infra_retries_max times; a registration never attempted leaves the check missing with no row', async (t) => {
    const fx = await sandboxEngine(t, { config: { checktree_max_entries: 1000, check_infra_retries_max: 2 } });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);

    // mount_plan_refused: read_paths naming the engine home.
    const refusedProject = await checkProject(fx, {
      files: {
        [GOVERNED_FILE]: sandboxGoverned(prog, { runner_config: { direct: { read_paths: [...prog.readPaths, fx.home] } } }),
        [defPath('plan')]: smoke('plan', { command: ['probe', 'exit', '0'], gates: ['stage'] }),
      },
    });
    const refused = await buildStage(fx, refusedProject);
    await assertNotRun(fx, refusedProject, refused.stage, refused.candidate, 'plan', 'mount_plan_refused');
    const now = await projectNow(fx.engine, refusedProject.id);
    assert.deepEqual([now.state, now.cause], ['refused', 'check_unrunnable'], `mount_plan_refused makes NOW refused, check_unrunnable (now: ${JSON.stringify(now)})`);

    // materialization_failed, and its recovery registrations.
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`bulk/e${String(i).padStart(4, '0')}`, '']));
    const bigProject = await checkProject(fx, { files: { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('tree')]: smoke('tree', { command: ['probe', 'exit', '0'], gates: ['stage'] }), ...many } });
    const big = await buildStage(fx, bigProject);
    const chain = await askingForTicks(
      fx,
      bigProject.id,
      () => {
        const rows = executionsOf(fx.home, big.candidate.id).filter((x) => x.key === 'tree');
        return rows.length === 3 && rows.every((x) => x.status === 'recorded') ? rows : undefined;
      },
      'the materialization to fail, and be registered again and fail, twice',
    );
    for (const x of chain) assert.deepEqual([resultRow(fx.home, x.result).execution_established, x.not_run_reason], [0, 'materialization_failed'], `${x.id}: materialization_failed`);
    const retries = retriesOf(chain, chain[0]);
    assert.deepEqual(retries.map((x) => [x.trigger?.source, x.infra_retries]), [['recovery', 1], ['recovery', 2]], 'registered again as recovery, twice (SEAM.md §204)');
    await tick(fx.engine, bigProject.id, { rounds: 2 });
    assert.equal(executionsOf(fx.home, big.candidate.id).filter((x) => x.key === 'tree').length, 3, 'and no more than check_infra_retries_max times');

    // Never attempted: two checks, one slot; the first admitted holds it.
    const waitProject = await checkProject(fx, {
      files: {
        [GOVERNED_FILE]: sandboxGoverned(prog),
        [defPath('first')]: smoke('first', { command: ['probe', ...holdArgs(prog, 'first'), 'exit', '0'], gates: ['stage'], timeout: 300 }),
        [defPath('later')]: smoke('later', { command: ['probe', ...holdArgs(prog, 'later'), 'exit', '0'], gates: ['stage'], timeout: 300 }),
      },
    });
    const waiting = await buildStage(fx, waitProject);
    const holder = await heldExecution(fx, waitProject.id, waiting.candidate.id, { first: 'first', later: 'later' });
    const other = holder.key === 'first' ? 'later' : 'first';
    const queued = executionsOf(fx.home, waiting.candidate.id).find((x) => x.key === other);
    assert.deepEqual([queued.status, queued.result], ['queued', null], 'the other registration is queued, never attempted, with no row');
    const entry = entryByKey(gateCheckEntries(await stageGate(fx, { project: waitProject, stage: waiting.stage }, waiting.candidate)), other);
    assert.deepEqual([entry.state, entry.pending?.execution, entry.pending?.status, entry.not_run_reason ?? null], ['missing', queued.id, 'queued', null], 'the check is missing, naming the queued registration; no not-run reason');
  });

  test('isolation_unqualified: with no current host qualification an operator\'s re-run is a row, skipped; NOW refused, check_unrunnable', async (t) => {
    // The candidate is built on a qualified start (a Builder's run needs the
    // sandbox); its nomination's check is recorded runner_unqualified there,
    // since nothing qualified the runner. The next start fails H5.
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    const project = await checkProject(fx, { files: { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('host')]: smoke('host', { command: ['probe', 'exit', '0'], gates: ['stage'] }) } });
    const { stage, candidate } = await buildStage(fx, project);
    await terminalExecution(fx, project.id, candidate.id, 'host', "the nomination's execution to end");
    await fx.engine.stop();
    await fx.start({ args: ['--harness-host-check', 'H5=failed'] });
    const asked = await requestChecks(fx.engine, project.id, candidate.id, { keys: ['host'] });
    assert.equal(asked.status, 202, `an operator re-runs the check (body: ${asked.text})`);
    const x = await assertNotRun(fx, project, stage, candidate, 'host', 'isolation_unqualified');
    assert.equal(x.id, asked.body.executions[0].id, "the operator's registration");
    const now = await projectNow(fx.engine, project.id);
    assert.deepEqual([now.state, now.cause], ['refused', 'check_unrunnable'], `isolation_unqualified makes NOW refused, check_unrunnable (now: ${JSON.stringify(now)})`);
  });
});
