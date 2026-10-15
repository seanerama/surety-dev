// M438 (g): the per-profile maxima read back on the real boundary (M5 slice
// 37; SANDBOX LANE). M5 plan §3.7 M438 (g); D6-X06 ("on the real boundary a
// role domain's memory.max reads back as role_memory_max"); D6 §6.4, A.3
// (`execution_domains.memory_max`); K2; B09; BS5 §4.1 rules 10, 12;
// SEAM.md §§168, 438
//
// The project's `role_memory_max` (768 MiB) and `check_memory_max`
// (640 MiB), set low through the policy route (rule 10: never by filling
// memory). A check domain holds (the check program's hold) and its cgroup's
// `memory.max` is read from the host; then a role domain holds (the scripted
// role program) and its `memory.max` is read. Each equals the project's
// maximum and the `memory_max` recorded on the domain at admission.
//
// SAFETY (BS5 §4.1 rules 1 to 12). Nothing here allocates, forks, writes to
// a limit or signals: the reads are of cgroup files, read only. The domains
// are this test's engine's, under its own home's scope; the held role is
// ended by the engine's own Stop (the owner's route), the held check by its
// release file. No unit is created.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addItem, pinStep } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { stopRun, waitForRunState } from './harness/runs.mjs';
import { roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { scopeUnitPrefix } from './harness/sandbox/cgroup.mjs';
import { GOVERNED_FILE, buildStage, checkProject, defPath, heldExecution, holdArgs, installCheckProgram, qualifyRunnerByFixture, release, sandboxGoverned, smoke, waitRecorded } from './harness/checks/fixtures.mjs';

const MIB = 1024 * 1024;
const ROLE = 768 * MIB;
const CHECK = 640 * MIB;
const readMax = (dir) => readFileSync(join(dir, 'memory.max'), 'utf8').trim();

describe('M438 (g) the per-profile maxima on the real boundary', () => {
  test('a role domain\'s memory.max reads back as role_memory_max; a check domain\'s as check_memory_max; each the memory_max recorded at admission', async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    const files = { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('held')]: smoke('held', { command: ['probe', ...holdArgs(prog, 'held'), 'exit', '0'], gates: ['stage'], timeout: 300 }) };
    const project = await pinStep(fx, await checkProject(fx, { files }));
    await changePolicy(fx.engine, project.id, { role_memory_max: ROLE, check_memory_max: CHECK });
    // The runner qualified after the change, so the check profile it serves is the 640 MiB one (D6-X09).
    await qualifyRunnerByFixture(fx.engine);
    const prefix = scopeUnitPrefix(fx.home);

    // The check domain.
    const { candidate } = await buildStage(fx, project);
    const check = await heldExecution(fx, project.id, candidate.id, { held: 'held' });
    assert.ok(check.domain.cgroup_path.includes(prefix), `the check domain is this home's (${check.domain.cgroup_path})`);
    assert.equal(readMax(check.domain.cgroup_path), String(CHECK), `host-read: the check domain's memory.max is check_memory_max ${CHECK}`);
    assert.equal(check.domain.memory_max, CHECK, `execution_domains.memory_max recorded at admission is check_memory_max (${JSON.stringify(check.domain)})`);
    release(prog, 'held');
    await waitRecorded(fx, project.id, candidate.id, ['held']);

    // The role domain.
    const role = await roleHolding(fx, project.id, await addItem(fx, project.id, 'fix'));
    assert.ok(role.domain.cgroup_path.includes(prefix), `the role domain is this home's (${role.domain.cgroup_path})`);
    assert.equal(readMax(role.domain.cgroup_path), String(ROLE), `host-read: the role domain's memory.max is role_memory_max ${ROLE}`);
    assert.equal(role.domain.memory_max, ROLE, `execution_domains.memory_max recorded at admission is role_memory_max (${JSON.stringify(role.domain)})`);
    await stopRun(fx.engine, project.id, role.run.id);
    await waitForRunState(fx.home, role.run.id, 'ended', { timeoutMs: 60_000 });
  });
});
