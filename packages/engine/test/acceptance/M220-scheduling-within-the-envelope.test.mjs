// M220, scheduling (M3 slice 18; sandbox lane). M3 plan §3.4 M220;
// D3-R14; D3 §2.5 ("Scheduling"), §7.1 L2; D2 §3.7; SEAM.md §§156, 168,
// 203, 210.
//
// (a) The envelope, reached by configuration only (SEAM.md §156's way):
//     `max_concurrent_domains` 1 with a role's run holding the one domain;
//     then `host_reserve_memory` and `host_reserve_disk`, each set so that
//     the host qualifies with room for one domain beside the reserve but not
//     for two, with a role's run holding the one (objection 028; SEAM.md
//     §§168, 210). Each time an operator's request
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

// Memory admission reserves each admitted domain's domain_memory_max beside
// host_reserve_memory (SEAM.md §168); at the defaults two domains need 18 GiB
// available. The cases mean the limits they name, so domain_memory_max is the
// contract's minimum (512 MiB), as M133 and M214 configure it.
const ADMIT = Object.freeze({ domain_memory_max: CONTRACT.engine.domain_memory_max.min });
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

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

// A role of `other` holds a domain; an operator's request for the check is
// then held by the envelope at `limit`; once the role's run has ended, the
// check runs and passes.
async function heldWhileARoleRuns(fx, project, candidate, other, limit) {
  const role = await roleHolding(fx, other.id, await addItem(fx, other.id, 'fix'));
  const held = await heldByEnvelope(fx, project.id, candidate.id, 'quick', limit);
  await stopRun(fx.engine, other.id, role.run.id);
  await waitForRunState(fx.home, role.run.id, 'ended', { timeoutMs: 60_000 });
  await waitFor(
    async () => {
      await tick(fx.engine, project.id, { rounds: 1 });
      return executionRow(fx.home, held.id).status === 'recorded' ? true : undefined;
    },
    { timeoutMs: 60_000, what: `the check held at ${limit} to run once the role's domain has ended` },
  );
  const r = resultRow(fx.home, executionRow(fx.home, held.id).result);
  assert.deepEqual([r.execution_established, r.exit_status], [1, 0], `${limit}: released, it ran and passed`);
}

describe('M220 scheduling within the envelope', () => {
  test('(a) max_concurrent_domains and the two host reserves: a check is held, shown as resource_envelope; released, it runs', async (t) => {
    const fx = await sandboxEngine(t, { config: { max_concurrent_domains: 1, ...ADMIT } });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const project = await checkProject(fx, { files: { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('quick')]: smoke('quick', { command: ['probe', 'exit', '0'], gates: ['stage'] }) } });
    const { candidate } = await buildStage(fx, project);
    await waitRecorded(fx, project.id, candidate.id, ['quick'], { what: "the nomination's check, before anything holds the domain" });

    const other = await addGitProject(fx);

    // max_concurrent_domains 1, the one domain held by another project's role.
    await heldWhileARoleRuns(fx, project, candidate, other, 'max_concurrent_domains');

    // The reserves (objection 028). A reserve above what the host has free
    // fails H12 and leaves no host qualification, so nothing is held: it is
    // isolation_unqualified. Each reserve is therefore set between H12's need
    // (the reserve and one domain's limit) and the envelope's need once a
    // domain is running (the reserve and two domains' limits): the host
    // qualifies, the role's domain is admitted, and the check is held.
    // Configuration only; nothing consumes memory or disk (SEAM.md §§168, 210).
    const memAvailable = Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024;
    const diskFree = Number(statfsSync(fx.home).bavail) * Number(statfsSync(fx.home).bsize);
    const memoryReserve = CONTRACT.engine.host_reserve_memory.min;
    const memoryLimit = Math.floor((0.7 * (memAvailable - memoryReserve)) / MIB) * MIB;
    const writable = 4 * GIB;
    const diskReserve = Math.floor((diskFree - 1.5 * writable) / MIB) * MIB;
    for (const [limit, config, h12, envelope, free] of [
      ['host_reserve_memory', { host_reserve_memory: memoryReserve, domain_memory_max: memoryLimit }, memoryReserve + memoryLimit, memoryReserve + 2 * memoryLimit, memAvailable],
      ['host_reserve_disk', { ...ADMIT, host_reserve_disk: diskReserve, domain_writable_bytes: writable }, diskReserve + writable, diskReserve + 2 * writable, diskFree],
    ]) {
      for (const [k, v] of Object.entries(config)) assert.ok(v >= CONTRACT.engine[k].min && v <= CONTRACT.engine[k].max, `the fixture is live: ${k} ${v} lies within its configured range`);
      assert.ok(h12 <= free && envelope > free, `the fixture is live: ${limit}: one domain fits beside the reserve (${h12} <= ${free}) and two do not (${envelope} > ${free})`);
      await fx.engine.stop();
      writeEngineConfig(fx.home, { api_port: fx.port, ...SANDBOX_CONFIG, ...config });
      await fx.start();
      await qualifyRunnerByFixture(fx.engine);
      await heldWhileARoleRuns(fx, project, candidate, other, limit);
    }
  });

  test("(b) a role's run of the project holding it: a check runs meanwhile; (c) one candidate's checks run one at a time", async (t) => {
    const fx = await sandboxEngine(t, { config: ADMIT });
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
