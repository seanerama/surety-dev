// M111, another home's scope and domains are untouched (M2 slice 11,
// sandbox lane). M2 plan §3.2 M111; D2 §3.1, §3.3, K2 (D2-B08); AR §3.3;
// SEAM.md §§122, 124, 129.
//
// Two engines on two homes have two scopes under the user manager, named
// by their homes' hashes. One engine ending its run, two engines creating
// their scopes at the same moment, a failed duplicate start and an engine's
// crash and recovery each leave the other home's scope, supervisor leaf and
// domain exactly as they were: its role alive, its domain populated, its
// engine in its own leaf.
//
// Every case here is expected to fail on the engine these tests were
// written against, which creates no scope (COVERAGE.md, "M2 slice 11").

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { EXIT } from './harness/engine.mjs';
import { assertRunEnded, runsOf, waitForRunState, waitForWork } from './harness/runs.mjs';
import { cgroupExists, listScopes, populated, procsOf, scopeUnitPrefix, waitScopes } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, projectWithRoleHolding, releaseScopeBarrier, roleAlive, sandboxEngine, scopeOf, waitScopeBarrier } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';

// Two sandbox-lane engines, each with a role holding in a populated domain.
async function twoHomes(t) {
  const A = await sandboxEngine(t);
  const B = await sandboxEngine(t);
  const a = await projectWithRoleHolding(A, { on_term: 'ignore', after: [step.result()] });
  const b = await projectWithRoleHolding(B, { on_term: 'ignore', after: [step.result()] });
  return { A, B, a, b };
}

// B is exactly as it was: its engine in its leaf, its domain populated by
// its live role, its one scope listed.
async function assertUntouched(B, b, what) {
  const scope = await assertEngineInScope(B);
  assert.equal(populated(b.domain.cgroup_path), 1, `${what}: B's domain is still populated`);
  assert.equal(roleAlive(b.domain, b.launch), true, `${what}: B's role is still alive in its domain`);
  assert.ok(procsOf(b.domain.cgroup_path).includes(b.member.pid), `${what}: the same host process is in B's domain`);
  const scopes = listScopes(scopeUnitPrefix(B.home));
  assert.deepEqual(scopes.map((s) => s.unit), [scope.unit], `${what}: the manager lists B's one scope`);
  assert.equal(B.engine.isRunning(), true, `${what}: B's engine is running`);
  assert.equal((await B.engine.get('/v1/health')).status, 200, `${what}: and answers`);
}

describe('M111 another home is untouched', () => {
  test('(a) engine A ends its run: B\'s role is still alive and B\'s domain populated', async (t) => {
    const { A, B, a, b } = await twoHomes(t);
    const scopeA = await assertEngineInScope(A);
    const scopeB = await assertEngineInScope(B);
    assert.notEqual(scopeA.unit, scopeB.unit, 'two homes, two scope units');
    assert.notEqual(scopeA.path, scopeB.path);
    assert.ok(!a.domain.cgroup_path.startsWith(scopeB.path) && !b.domain.cgroup_path.startsWith(scopeA.path), 'each domain is under its own scope');

    A.scripted.release(a.item);
    await waitForRunState(A.home, a.run.id, 'ended');
    assertRunEnded(A.home, a.run.id, { outcome: 'completed', launched: true, recovery: false });
    await waitForWork(A.home, a.item, 'complete');
    assert.equal(cgroupExists(a.domain.cgroup_path), false, "A's domain directory is removed after its termination");
    await assertUntouched(B, b, '(a)');
  });

  test('(b) concurrent starts of A and B held at scope.before_create and released together: each engine in its own scope', async (t) => {
    const A = await sandboxEngine(t, { start: false });
    const B = await sandboxEngine(t, { start: false });
    const starts = [A, B].map((fx) => fx.start({ barriers: ['scope.before_create=pause'], until: 'none' }));
    const [engineA, engineB] = await Promise.all(starts);
    await waitScopeBarrier(A.home);
    await waitScopeBarrier(B.home);
    assert.equal(listScopes('surety-').filter((s) => s.unit.startsWith(scopeUnitPrefix(A.home)) || s.unit.startsWith(scopeUnitPrefix(B.home))).length, 0, 'neither scope exists while both wait at the barrier');
    releaseScopeBarrier(A.home);
    releaseScopeBarrier(B.home);
    await Promise.all([engineA.waitUntil('full'), engineB.waitUntil('full')]);
    const scopeA = await assertEngineInScope(A);
    const scopeB = await assertEngineInScope(B);
    assert.notEqual(scopeA.path, scopeB.path, 'two scopes');
    assert.deepEqual(procsOf(join(scopeA.path, 'supervisor')), [engineA.pid], "A's supervisor leaf holds A's engine and nothing else");
    assert.deepEqual(procsOf(join(scopeB.path, 'supervisor')), [engineB.pid], "B's supervisor leaf holds B's engine and nothing else");
  });

  test('(c) a failed duplicate start of A exits 3 and its transient scope is gone: the manager lists one scope for home A, and A\'s scope and domain are unchanged', async (t) => {
    const { A, B, a, b } = await twoHomes(t);
    const scopeA = await assertEngineInScope(A);
    const before = { supervisor: procsOf(join(scopeA.path, 'supervisor')), populated: populated(a.domain.cgroup_path) };

    const owner = A.engine;
    const duplicate = await A.start({ until: 'none' });
    A.engine = owner;
    const status = await duplicate.exited;
    assert.equal(status.code, EXIT.locked, `the duplicate start exits 3, engine_locked (exited ${JSON.stringify(status)})\n${duplicate.output().stderr.slice(-1000)}`);
    const scopes = await waitScopes(A.home, 1);
    assert.deepEqual(scopes.map((s) => s.unit), [scopeA.unit], "after the duplicate's exit the manager lists only the owner's scope for home A");
    assert.deepEqual(procsOf(join(scopeA.path, 'supervisor')), before.supervisor, "A's supervisor leaf is unchanged");
    assert.equal(populated(a.domain.cgroup_path), before.populated, "A's domain is unchanged");
    assert.equal(roleAlive(a.domain, a.launch), true, "A's role is still alive");
    assert.equal(A.engine.isRunning(), true, 'the owner runs on');
    await assertUntouched(B, b, '(c)');
  });

  test('(d) A killed and restarted while B runs: A\'s recovery kills only prior incarnations of home A; B\'s supervisor leaf and domain are untouched', async (t) => {
    const { A, B, a, b } = await twoHomes(t);
    const oldScope = await scopeOf(A);
    await A.engine.kill();
    assert.equal(roleAlive(a.domain, a.launch), true, "the fixture is live: A's role outlived its engine");
    assert.equal(cgroupExists(oldScope.path), true, "A's old scope outlives the engine while its domain is populated");

    const engine = await A.start();
    const info = await engine.engineInfo();
    assert.notEqual(info.incarnation, oldScope.incarnation);
    await waitForRunState(A.home, a.run.id, 'ended');
    assertRunEnded(A.home, a.run.id, { outcome: 'recovered', reason_class: 'recovered', launched: true, recovery: info.incarnation });
    assert.equal(roleAlive(a.domain, a.launch), false, "A's prior role was terminated by A's recovery");
    assert.equal(cgroupExists(a.domain.cgroup_path), false, "A's prior domain directory is gone");
    const newScope = await assertEngineInScope(A);
    assert.notEqual(newScope.unit, oldScope.unit, 'the new incarnation has a scope of its own');
    const scopes = await waitScopes(A.home, 1);
    assert.deepEqual(scopes.map((s) => s.unit), [newScope.unit], "the old scope is gone once empty; the manager lists the new incarnation's");
    await assertUntouched(B, b, '(d)');
    assert.equal(runsOf(B.home, b.item)[0].state, 'executing', "B's run is still executing");
  });
});
