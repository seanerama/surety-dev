// M114, a restart observes before it believes; a prior supervisor is
// closed (M2 slice 11, sandbox lane). M2 plan §3.3 M114; D2 §3.3, §3.4, K1
// (D2-B05, D2-B06); D1 §16.1; AR B01; SEAM.md §§124, 126, 128, 129. Row
// M06's recovery repeated through the real boundary.
//
// After an engine is killed with a populated domain, the restart first
// closes every non-terminated domain, then kills the prior incarnation's
// supervisor leaf and reads it empty, and only then observes the domain and
// terminates it; a launcher of the prior incarnation paused in that leaf
// dies with it, and releasing it afterwards starts nothing; a recorded path
// outside the verified hierarchy is unknown, an absent path inside it is
// terminated; an unreadable prior supervisor leaf makes every domain of
// that incarnation unknown.
//
// Every case here is expected to fail on the engine these tests were
// written against, which creates no scope (COVERAGE.md, "M2 slice 11").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { assertRecoveredStore, eventsAbout } from './harness/invariants.mjs';
import { addProject, addWork, assertRunEnded, assertRunQuarantined, requestTick, runsOf, waitForQuarantine, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { cgroupExists, cgroupOfPid, killCgroup, makeLeaf, makeUnreadable, moveIntoCgroup, populated, procsOf, restoreReadable, waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, domainOf, domainRow, eventsOf, roleAlive, roleHolding, sandboxEngine, updateDomain, waitForEvent } from './harness/sandbox/lane.mjs';
import { hostProcess } from './harness/sandbox/procs.mjs';
import { cgroupSentinel } from './harness/sandbox/sentinel.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const GRACE = { terminate_grace: 4, kill_grace: 2 };
const ignoring = { on_term: 'ignore', before: [step.descendant({ holds_stdout: false, on_term: 'ignore' })] };

// A sandbox-lane engine with a role that ignores TERM holding in a domain,
// then killed: the role, the domain and the old scope survive it.
async function killedWithRoleHolding(t, opts = {}) {
  const fx = await sandboxEngine(t, { config: GRACE, ...opts });
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, 'verification');
  const held = await roleHolding(fx, project, item, ignoring);
  const scope = await assertEngineInScope(fx);
  await fx.engine.kill();
  assert.equal(roleAlive(held.domain, held.launch), true, 'the fixture is live: the role outlived the engine');
  assert.equal(populated(held.domain.cgroup_path), 1, 'its domain is populated');
  assert.equal(cgroupExists(scope.path), true, 'the scope outlives the engine while a domain of it is populated');
  assert.equal(populated(scope.supervisor), 0, 'the old supervisor leaf is empty: its engine is dead');
  return { fx, project, item, scope, ...held };
}

describe('M114 a restart observes before it believes', () => {
  test('(a) SIGKILL the engine with a populated domain whose role ignores TERM; restart: every non-terminated domain is closed before any kill, the prior supervisor leaf killed and read empty, then the domain terminated and observed; the run recovered, work held, no process of the old incarnation', async (t) => {
    const { fx, item, scope, run, domain, launch } = await killedWithRoleHolding(t);
    const killedAt = withStore(fx.home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);

    const engine = await fx.start({ until: 'listening' });
    // Closure first: the event is written while the role, which ignores
    // TERM, is still alive (the kill comes only after terminate_grace).
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed', { timeoutMs: 30_000 });
    assert.equal(roleAlive(domain, launch), true, 'the domain is closed before anything is signalled: the role is still alive right after domain.launch_closed');
    assert.equal(domainRow(fx.home, domain.id).launch_state, 'closed');

    await engine.waitUntil('full', { timeoutMs: 60_000 });
    const info = await engine.engineInfo();
    withStore(fx.home, (db) => assertRecoveredStore(db));
    await waitForRunState(fx.home, run.id, 'ended');
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', workspace: 'retained', launched: true, recovery: info.incarnation });
    assert.equal(facts.domains[0].observation, 'terminated', 'the domain was observed terminated');
    assert.equal(roleAlive(domain, launch), false, 'the role is gone');
    assert.equal(cgroupExists(domain.cgroup_path), false, 'the domain directory is removed');
    await waitCgroupGone(scope.path);
    assert.equal(cgroupExists(scope.supervisor), false, 'the prior supervisor leaf is gone with the prior scope');
    const newScope = await assertEngineInScope(fx);
    assert.notEqual(newScope.path, scope.path, 'the new incarnation runs in a scope of its own');
    assert.equal((await waitForWork(fx.home, item, 'held')).status, 'held');
    withStore(fx.home, (db) => {
      const closed = eventsAbout(db, 'domain', domain.id, 'domain.launch_closed')[0];
      const terminated = eventsAbout(db, 'domain', domain.id, 'domain.terminated')[0];
      const lifted = db.prepare(`SELECT "seq" FROM "events" WHERE "seq" > ? AND "type" = 'engine.mode_changed' ORDER BY "seq"`).get(killedAt);
      assert.ok(closed.seq > killedAt && closed.seq < terminated.seq && terminated.seq < lifted.seq, `closed (${closed.seq}) before terminated (${terminated.seq}) before full mode (${lifted.seq}), all by the new incarnation`);
    });
    assert.equal(runsOf(fx.home, item).length, 1, 'the recovered work is not dispatched again by itself');
  });

  test('(b) the engine killed while a launcher waits at launcher.before_placement in the supervisor leaf; restart; release: the launcher dies with the supervisor leaf before the domain is observed, the release is a no-op, no scripted launch was ever recorded', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE, barriers: ['launcher.before_placement=pause'] });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    const launcher = procsOf(scope.supervisor).find((p) => p !== fx.engine.pid && /node$/.test(hostProcess(p)?.cmdline[0] ?? ''));
    assert.ok(launcher, `the launcher waits in the supervisor leaf (${procsOf(scope.supervisor).join(', ')})`);
    assert.equal(populated(domain.cgroup_path), 0, 'the domain is not populated');
    await fx.engine.kill();
    assert.ok(hostProcess(launcher), 'the fixture is live: the paused launcher outlived its engine');
    assert.equal(populated(scope.supervisor), 1, 'the old supervisor leaf holds the launcher');

    const engine = await fx.start();
    const info = await engine.engineInfo();
    assert.equal(hostProcess(launcher), null, 'the launcher died with the prior supervisor leaf');
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', launched: false, recovery: info.incarnation });
    const row = domainRow(fx.home, domain.id);
    assert.deepEqual([row.status, row.launch_state], ['terminated', 'closed']);
    const res = await engine.post('/v1/harness/barriers/launcher.before_placement/release', {});
    assert.ok([200, 404, 409].includes(res.status), `the release is a no-op (${res.status} ${res.text})`);
    await sleep(1500);
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no scripted launch was ever recorded');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.placed'), [], 'never placed');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'never authorized');
    await waitForWork(fx.home, item, 'held');
  });

  test('(c) the recorded cgroup_path edited to a path outside the verified hierarchy: unknown and quarantined, the real role untouched; an absent path inside it: terminated', async (t) => {
    // Outside: the path of another scope's (a test scope with a sentinel).
    const outside = await killedWithRoleHolding(t);
    const other = await cgroupSentinel(t);
    const elsewhere = makeLeaf(cgroupOfPid(other.pid), 'dom_elsewhere');
    moveIntoCgroup(other.pid, elsewhere);
    assert.equal(populated(elsewhere), 1, 'the fixture is live: a populated directory under another scope');
    updateDomain(outside.fx.home, outside.domain.id, { cgroup_path: elsewhere });
    const engineA = await outside.fx.start();
    await waitForQuarantine(outside.fx.home, outside.run.id);
    const facts = assertRunQuarantined(outside.fx.home, outside.run.id, { outcome: 'recovered' });
    assert.equal(facts.domains[0].observation, 'unknown', 'a path outside the verified hierarchy is unknown');
    assert.equal(roleAlive(outside.domain, outside.launch), true, 'the real role, wherever it is, was not touched');
    assert.equal(other.alive(), true, "the other scope's sentinel was not touched");
    assert.equal((await engineA.engineInfo()).mode, 'full', 'a quarantine does not keep the engine restricted');

    // Inside, absent: the role gone and its scope with it before the restart.
    const inside = await killedWithRoleHolding(t);
    killCgroup(inside.domain.cgroup_path);
    await waitCgroupGone(inside.scope.path);
    assert.equal(cgroupExists(inside.domain.cgroup_path), false, 'the fixture is live: the domain directory is absent, inside the hierarchy');
    const engineB = await inside.fx.start();
    const info = await engineB.engineInfo();
    await waitForRunState(inside.fx.home, inside.run.id, 'ended');
    const ended = assertRunEnded(inside.fx.home, inside.run.id, { outcome: 'recovered', reason_class: 'recovered', launched: true, recovery: info.incarnation });
    assert.equal(ended.domains[0].observation, 'terminated', 'absence in the verified hierarchy is termination');
  });

  test("(d) the prior supervisor leaf's cgroup.events unreadable before restart: every domain of that incarnation unknown", async (t) => {
    const { fx, run, domain, launch, scope } = await killedWithRoleHolding(t);
    // The scope must outlive the restart's observation: a leaf of the test's own keeps it populated.
    const keep = makeLeaf(scope.path, 'test_keep');
    const sentinel = await cgroupSentinel(t, keep);
    makeUnreadable(scope.supervisor, 'cgroup.events');
    t.after(() => {
      try {
        restoreReadable(scope.supervisor, 'cgroup.events');
      } catch {
        // gone
      }
    });
    const engine = await fx.start();
    await waitForQuarantine(fx.home, run.id);
    const facts = assertRunQuarantined(fx.home, run.id, { outcome: 'recovered' });
    assert.equal(facts.domains[0].observation, 'unknown', 'a prior supervisor leaf that cannot be read makes the domain unknown');
    assert.equal(roleAlive(domain, launch), true, 'nothing was signalled to a domain whose prerequisites could not be established');
    assert.equal(sentinel.alive(), true);
    assert.equal((await engine.engineInfo()).mode, 'full');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], 'never terminated');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').all(run.id).length), 1);
  });
});
