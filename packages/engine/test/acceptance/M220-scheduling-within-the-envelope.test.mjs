// M220, scheduling (M3 slice 18; sandbox lane). M3 plan §3.4 M220;
// D3-R14; D3 §2.5 ("Scheduling"), §7.1 L2; D2 §3.7; SEAM.md §§156, 168,
// 203, 210.
//
// (a) The envelope, reached by configuration only (SEAM.md §156's way):
//     `max_concurrent_domains` 1 with a role's run holding the one domain;
//     then `host_reserve_memory` and `host_reserve_disk` each at their
//     maximum, above what the host has free. Each time an operator's request
//     for a check stays queued, no domain allocated, its hold shown on the
//     candidate's checks route as `resource_envelope` naming the limit; once
//     the role's run has ended, the check runs.
// (b) A role's run of the same project is executing: a check of the project
//     runs and is recorded meanwhile (an execution is not a run).
// (c) One candidate's two checks, `max_concurrent_checks` at its default 1:
//     while the first runs the second stays queued; then it runs.
//
// SAFETY: the check program holds at a release file and exits 0. Nothing
// consumes host memory or disk: the reserves are configuration.

import assert from 'node:assert/strict';
import { readFileSync, statfsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { writeEngineConfig, waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject, addItem } from './harness/gitruns.mjs';
import { run as runRow, stopRun, tick, waitForRunState } from './harness/runs.mjs';
import { SANDBOX_CONFIG, roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  executionRow,
  executionsOf,
  heldExecution,
  holdArgs,
  installCheckProgram,
  listExecutions,
  qualifyRunnerByFixture,
  release,
  requestChecks,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

// An operator's request for `key`, held by the envelope: the route's entry
// for it, once it shows its hold. Returns {entry, id}.
async function heldByEnvelope(fx, project, candidate, key, limit) {
  const asked = await requestChecks(fx.engine, project, candidate, { keys: [key] });
  assert.equal(asked.status, 202, `an operator requests ${key} (body: ${asked.text})`);
  const id = asked.body.executions[0].id;
  const entry = await waitFor(
    async () => {
      await tick(fx.engine, project, { rounds: 1 });
      const e = (await listExecutions(fx.engine, project, candidate)).find((x) => x.id === id);
      return e?.hold ? e : undefined;
    },
    { timeoutMs: 30_000, what: `the requested execution to show its hold (${limit})` },
  );
  assert.deepEqual([entry.status, entry.hold?.code, entry.hold?.subject?.limit], ['queued', 'resource_envelope', limit], `${limit}: queued, held as resource_envelope (SEAM.md §210) (${JSON.stringify(entry)})`);
  assert.equal(executionRow(fx.home, id).domain, null, `${limit}: no domain was allocated for it`);
  return { entry, id };
}

describe('M220 scheduling within the envelope', () => {
  test('(a) max_concurrent_domains and the two host reserves: a check is held, shown as resource_envelope; released, it runs', async (t) => {
    const fx = await sandboxEngine(t, { config: { max_concurrent_domains: 1 } });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const project = await checkProject(fx, { files: { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('quick')]: smoke('quick', { command: ['probe', 'exit', '0'], gates: ['stage'] }) } });
    const { candidate } = await buildStage(fx, project);
    await waitRecorded(fx, project.id, candidate.id, ['quick'], { what: "the nomination's check, before anything holds the domain" });

    // max_concurrent_domains 1, the one domain held by another project's role.
    const other = await addGitProject(fx);
    const role = await roleHolding(fx, other.id, await addItem(fx, other.id, 'fix'));
    const domains = await heldByEnvelope(fx, project.id, candidate.id, 'quick', 'max_concurrent_domains');
    await stopRun(fx.engine, other.id, role.run.id);
    await waitForRunState(fx.home, role.run.id, 'ended', { timeoutMs: 60_000 });
    await waitFor(
      async () => {
        await tick(fx.engine, project.id, { rounds: 1 });
        return executionRow(fx.home, domains.id).status === 'recorded' ? true : undefined;
      },
      { timeoutMs: 60_000, what: 'the held check to run once the domain is free' },
    );
    assert.deepEqual([resultRow(fx.home, executionRow(fx.home, domains.id).result).execution_established, resultRow(fx.home, executionRow(fx.home, domains.id).result).exit_status], [1, 0], 'released, it ran and passed');

    // The reserves, each above what the host has free, by configuration only.
    const memAvailable = Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024;
    for (const [key, value, free] of [
      ['host_reserve_memory', CONTRACT.engine.host_reserve_memory.max, memAvailable],
      ['host_reserve_disk', CONTRACT.engine.host_reserve_disk.max, Number(statfsSync(fx.home).bavail) * Number(statfsSync(fx.home).bsize)],
    ]) {
      assert.ok(value > free, `the fixture is live: ${key} ${value} is above what the host has free (${free})`);
      await fx.engine.stop();
      writeEngineConfig(fx.home, { api_port: fx.port, ...SANDBOX_CONFIG, [key]: value });
      await fx.start();
      await qualifyRunnerByFixture(fx.engine);
      await heldByEnvelope(fx, project.id, candidate.id, 'quick', key);
    }
  });

  test("(b) a role's run of the project holding it: a check runs meanwhile; (c) one candidate's checks run one at a time", async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const files = { [GOVERNED_FILE]: sandboxGoverned(prog) };
    for (const key of ['one', 'two']) files[defPath(key)] = smoke(key, { command: ['probe', ...holdArgs(prog, key), 'exit', '0'], gates: ['stage'], timeout: 300 });
    const project = await checkProject(fx, { files });
    const { candidate } = await buildStage(fx, project);

    // (c) The first admitted holds; the other stays queued however many ticks pass.
    const first = await heldExecution(fx, project.id, candidate.id, { one: 'one', two: 'two' });
    const second = first.key === 'one' ? 'two' : 'one';
    await tick(fx.engine, project.id, { rounds: 3 });
    const waiting = executionsOf(fx.home, candidate.id).find((x) => x.key === second);
    assert.deepEqual([waiting.status, waiting.domain], ['queued', null], `(c) while the first check runs, the second stays queued: serially by default (max_concurrent_checks 1)`);
    release(prog, first.key);
    const ran = await heldExecution(fx, project.id, candidate.id, { [second]: second });
    assert.equal(ran.execution.id, waiting.id, '(c) then the second runs');
    release(prog, second);
    await waitRecorded(fx, project.id, candidate.id, ['one', 'two']);

    // (b) A role's run of this project holds it; an operator's request runs meanwhile.
    const role = await roleHolding(fx, project.id, await addItem(fx, project.id, 'fix'));
    const asked = await requestChecks(fx.engine, project.id, candidate.id, { keys: ['one'] });
    assert.equal(asked.status, 202, `an operator requests a check while the role's run executes (body: ${asked.text})`);
    const id = asked.body.executions[0].id;
    await waitFor(
      async () => {
        await tick(fx.engine, project.id, { rounds: 1 });
        return executionRow(fx.home, id).status === 'recorded' ? true : undefined;
      },
      { timeoutMs: 60_000, what: "the check to run while the project's run executes" },
    );
    assert.deepEqual([resultRow(fx.home, executionRow(fx.home, id).result).execution_established, resultRow(fx.home, executionRow(fx.home, id).result).exit_status], [1, 0], '(b) the check ran to its end');
    assert.equal(runRow(fx.home, role.run.id).state, 'executing', "(b) and the role's run is executing still: a check is not counted by the one-run rule");
    await stopRun(fx.engine, project.id, role.run.id);
  });
});
