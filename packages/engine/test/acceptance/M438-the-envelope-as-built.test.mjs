// M438 (a) to (f): the concurrency envelope as built and the per-profile
// maxima (M5 slice 37; kernel lane). M5 plan §3.7 M438; D6-X06; D6 §6.4,
// A.7; K2; E140 N1, N2; reading 12; E126; B09; BS5 §5 ("the envelope is as
// built"); SEAM.md §§156, 168, 256, 427
//
// `MemAvailable` and each domain's `memory.current` are scripted through
// the kernel lane's envelope † (`POST /v1/harness/envelope`); every domain
// is counted at the `memory_max` recorded on it at admission
// (`execution_domains.memory_max`: the project's effective
// `role_memory_max`, min(the project's value or default,
// `domain_memory_max`)). The engine's defaults: `host_reserve_memory`
// 2 GiB, `role_memory_max` 4 GiB, `check_memory_max` 2 GiB,
// `domain_memory_max` 8 GiB, `max_concurrent_domains` 4. Each held role is
// the scripted role program holding in the kernel lane (no process of a
// domain, no memory used).
//   (a) 12 GiB available: three eligible runs, two admitted, the third held
//       `resource_envelope`; at 8 GiB per domain, one;
//   (b) the admitted domain's current usage varied while MemAvailable + Σ
//       current is constant: the same decisions; admission at exactly
//       reserve + Σ maxima = MemAvailable + Σ current (the add-back; not
//       maxima against MemAvailable alone);
//   (c) MemAvailable unreadable; a counted domain's memory.current
//       unreadable: held, `dispatch_hold.subject.unreadable` † naming it,
//       nothing dispatched;
//   (d) `max_concurrent_domains` 4 (always applied on the kernel lane); a
//       running service's reservation and the shared check capacity
//       counted, the capacity sized to the larger of two projects'
//       `check_memory_max` and reserved once. The bound check occupying the
//       capacity is M319 (b)'s on the real boundary (the kernel lane's
//       scripted check boundary makes no check domain);
//   (e) a project value above `domain_memory_max` refused 400
//       `invalid_value`; the defaults and ranges; the engine
//       `max_concurrent_runs` refused at start and the project's at the
//       policy route (`unknown_field`); a lowered ceiling caps the
//       effective value (Q1);
//   (f) `role_memory_max` changed while a domain is admitted: its
//       `memory_max` unchanged, the next domain's the new value.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXIT, makeTempDir, removeDir, startRefused, freePort, writeEngineConfig } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { changePolicy, getPolicy } from './harness/journal.mjs';
import { completeRound, deployToRound, deployable } from './harness/deploy/kernel.mjs';
import { addProject, addWork, runsOf, scriptedEngine, SLICE2_CONFIG, tick } from './harness/runs.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { GIB, MIB, clearEnvelope, domainOfItem, heldItems, holdOf, holding, liveRuns, setEnvelope, settle, ticksUntil } from './harness/exec37/envelope.mjs';

const R = 2 * GIB; // host_reserve_memory's default

// A project whose policy can change: its repository's primary worktree is
// detached (objection 090; the engine refuses to move an integration branch a
// worktree it does not own has checked out, RN R5). Its
// `budget_run_billable_tokens` is at its minimum (a tightening), so the day
// budget's reservation of each run under way (D1 §13.3; D6 §6.5, a separate
// bound) admits every run the envelope and the slots admit, and the case meets
// the envelope, not the budget (objection 091, the driver's ruling).
async function admittingProject(fx) {
  const id = (await addGitProject(fx)).id;
  await changePolicy(fx.engine, id, { budget_run_billable_tokens: CONTRACT.project.budget_run_billable_tokens.min });
  return id;
}
const ROLE = 4 * GIB; // role_memory_max's default
const held = (fx, project, n) => heldItems(fx, project, n, { addWork });
const admittedOf = (fx, items) => items.filter((i) => runsOf(fx.home, i).length > 0);
async function admitted(fx, project, items, n, what) {
  await ticksUntil(fx, project, () => (admittedOf(fx, items).filter((i) => holding(fx, i)).length >= n ? true : undefined), { what, max: 20 });
  await settle(fx, project, 3);
  return admittedOf(fx, items);
}

describe('M438 the envelope as built (kernel lane, MemAvailable scripted)', () => {
  test('(a) 12 GiB available, role_memory_max 4 GiB, reserve 2 GiB: three eligible, two admitted, the third held resource_envelope; at 8 GiB per domain, one', async (t) => {
    const fx = await scriptedEngine(t);
    await setEnvelope(fx, { mem_available: 12 * GIB, default_current: 0 });
    const p = await admittingProject(fx);
    const items = await held(fx, p, 3);
    const runs = await admitted(fx, p, items, 2, 'two of three admitted');
    assert.equal(runs.length, 2, `two admitted (2 + 4 + 4 = 10 <= 12; a third would need 14) (${runs.length})`);
    const [third] = items.filter((i) => !runs.includes(i));
    const hold = await holdOf(fx, p, third);
    assert.deepEqual([hold?.code, runsOf(fx.home, third).length], ['resource_envelope', 0], `the third held resource_envelope with no run (${JSON.stringify(hold)})`);
    for (const i of runs) assert.equal(domainOfItem(fx.home, i)?.memory_max, ROLE, 'each admitted domain recorded at role_memory_max 4 GiB');
    fx.scripted.release('all', 'gate');

    // At 8 GiB per domain (the ceiling as the project's value): one.
    const fx2 = await scriptedEngine(t);
    await setEnvelope(fx2, { mem_available: 12 * GIB, default_current: 0 });
    const q = await admittingProject(fx2);
    await changePolicy(fx2.engine, q, { role_memory_max: 8 * GIB });
    const items2 = await held(fx2, q, 3);
    const runs2 = await admitted(fx2, q, items2, 1, 'one admitted at 8 GiB');
    assert.equal(runs2.length, 1, `one admitted (2 + 8 = 10 <= 12; two would need 18) (${runs2.length})`);
    assert.equal(domainOfItem(fx2.home, runs2[0])?.memory_max, 8 * GIB, 'recorded at 8 GiB');
    fx2.scripted.release('all', 'gate');
  });

  test('(b) the admitted domain\'s current usage varied, MemAvailable + Σ current constant: the same decisions; admitted at exactly the add-back\'s room', async (t) => {
    const fx = await scriptedEngine(t);
    await setEnvelope(fx, { mem_available: 64 * GIB, default_current: 0 });
    const p = (await addProject(fx)).id;
    const [a] = await held(fx, p, 1);
    await admitted(fx, p, [a], 1, 'A admitted');
    const dA = domainOfItem(fx.home, a).id;
    // Room 9.5 GiB (B needs 2 + 4 + 4 = 10): held, whatever the split.
    await setEnvelope(fx, { mem_available: 9.5 * GIB, memory_current: { [dA]: 0 } });
    const [b] = await held(fx, p, 1);
    await settle(fx, p, 3);
    assert.equal(runsOf(fx.home, b).length, 0, '9.5 GiB available, A using nothing: B held');
    await setEnvelope(fx, { mem_available: 6.5 * GIB, memory_current: { [dA]: 3 * GIB } });
    await settle(fx, p, 3);
    assert.equal(runsOf(fx.home, b).length, 0, '6.5 GiB available, A using 3 GiB (the same room): B still held');
    const hold = await holdOf(fx, p, b);
    assert.equal(hold?.code, 'resource_envelope', `held resource_envelope (${JSON.stringify(hold)})`);
    // Room 10 GiB as 7 available + 3 held by A: B admitted (maxima against MemAvailable alone, 10 > 7, would hold it).
    await setEnvelope(fx, { mem_available: 7 * GIB, memory_current: { [dA]: 3 * GIB } });
    await admitted(fx, p, [a, b], 2, 'B admitted at 7 GiB available + 3 GiB held by A');
    assert.equal(runsOf(fx.home, b).length, 1, 'reserve + Σ maxima (10 GiB) <= MemAvailable + Σ current (7 + 3): admitted');
    fx.scripted.release('all', 'gate');
  });

  test('(c) MemAvailable unreadable; a counted domain\'s memory.current unreadable: admission held naming the observation, nothing dispatched', async (t) => {
    const fx = await scriptedEngine(t);
    await setEnvelope(fx, { mem_available: 64 * GIB, default_current: 0 });
    const p = (await addProject(fx)).id;
    const [a] = await held(fx, p, 1);
    await admitted(fx, p, [a], 1, 'A admitted');
    const dA = domainOfItem(fx.home, a).id;
    await setEnvelope(fx, { mem_available: 'unreadable', memory_current: { [dA]: 0 } });
    const [b] = await held(fx, p, 1);
    await settle(fx, p, 3);
    let hold = await holdOf(fx, p, b);
    assert.deepEqual([runsOf(fx.home, b).length, hold?.code, hold?.subject?.unreadable], [0, 'resource_envelope', 'MemAvailable'], `MemAvailable unreadable: held, naming it (dispatch_hold.subject.unreadable †; ${JSON.stringify(hold)})`);
    await setEnvelope(fx, { mem_available: 64 * GIB, memory_current: { [dA]: 'unreadable' } });
    await settle(fx, p, 3);
    hold = await holdOf(fx, p, b);
    assert.deepEqual([runsOf(fx.home, b).length, hold?.code, hold?.subject?.unreadable, hold?.subject?.domain], [0, 'resource_envelope', 'memory.current', dA], `A's memory.current unreadable: held, naming it and the domain (${JSON.stringify(hold)})`);
    // Control: readable again, B admitted.
    await setEnvelope(fx, { mem_available: 64 * GIB, memory_current: { [dA]: 0 } });
    await admitted(fx, p, [a, b], 2, 'B admitted once both read');
    fx.scripted.release('all', 'gate');
  });

  test('(d) max_concurrent_domains 4 caps on the kernel lane with no envelope scripted', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await admittingProject(fx);
    const items = await held(fx, p, 5);
    const runs = await admitted(fx, p, items, 4, 'four admitted');
    assert.equal(runs.length, 4, `four admitted, max_concurrent_domains ${CONTRACT.engine.max_concurrent_domains.default} by default (${runs.length})`);
    const [fifth] = items.filter((i) => !runs.includes(i));
    const hold = await holdOf(fx, p, fifth);
    assert.deepEqual([hold?.code, hold?.subject?.limit, hold?.subject?.value], ['resource_envelope', 'max_concurrent_domains', 4], `the fifth held by the slot cap (${JSON.stringify(hold)})`);
    assert.equal(liveRuns(fx.home, p).length, 4, 'one project, four runs: no project run count');
    fx.scripted.release('all', 'gate');
  });

  test('(d) a running service\'s reservation and the shared check capacity counted, sized to the larger check_memory_max of two projects and reserved once', async (t) => {
    const fx = await scriptedEngine(t);
    // Project one's service (check_memory_max 2 GiB by default), deployed with no envelope scripted.
    const one = await deployable(fx);
    const r1 = await deployToRound(one);
    await completeRound(one, r1.execution);
    // Reserve 2 + role 4 + service 0.5 + capacity 2 = 8.5 GiB.
    const SVC = CONTRACT.project.service_memory_max.default;
    const need1 = R + ROLE + SVC + 2 * GIB;
    await setEnvelope(fx, { mem_available: need1 - MIB, default_current: 0 });
    const q = (await addProject(fx)).id;
    const [x] = await held(fx, q, 1);
    await settle(fx, q, 3);
    assert.equal(runsOf(fx.home, x).length, 0, `with one service, ${need1 - MIB} bytes available: the role held (reserve + role + service + capacity = ${need1})`);
    await setEnvelope(fx, { mem_available: need1, default_current: 0 });
    await admitted(fx, q, [x], 1, `the role admitted at ${need1}`);
    fx.scripted.release('all', 'gate');
    await ticksUntil(fx, q, () => runsOf(fx.home, x).every((r) => r.state === 'ended') || undefined, { what: 'the role ended' });

    // Project two's service, check_memory_max 1 GiB: the capacity is the larger (2 GiB), once.
    await clearEnvelope(fx);
    const two = await deployable(fx, { policy: { check_memory_max: GIB }, qualify: false });
    const r2 = await deployToRound(two);
    await completeRound(two, r2.execution);
    const need2 = R + ROLE + 2 * SVC + 2 * GIB;
    await setEnvelope(fx, { mem_available: need2 - MIB, default_current: 0 });
    const [y] = await held(fx, q, 1);
    await settle(fx, q, 3);
    assert.equal(runsOf(fx.home, y).length, 0, `with two services, ${need2 - MIB} available: held (capacity sized to the larger check_memory_max and reserved once: ${need2})`);
    await setEnvelope(fx, { mem_available: need2, default_current: 0 });
    await admitted(fx, q, [y], 1, `the role admitted at ${need2}, not at the sum of the two capacities (${need2 + GIB}) nor at domain_memory_max`);
    fx.scripted.release('all', 'gate');
  });

  test('(e) the defaults; a project value above domain_memory_max or below its range refused; max_concurrent_runs refused at both scopes; a lowered ceiling caps', async (t) => {
    const fx = await scriptedEngine(t);
    const { config } = await fx.engine.engineInfo();
    assert.deepEqual(config.max_concurrent_domains, { value: 4, source: 'default' }, 'max_concurrent_domains 4 by default (E140 N2)');
    assert.ok(!('max_concurrent_runs' in config), 'no engine max_concurrent_runs');
    const p = (await addGitProject(fx)).id;
    const policy = await getPolicy(fx.engine, p);
    assert.deepEqual([policy.effective.role_memory_max, policy.effective.check_memory_max], [CONTRACT.project.role_memory_max.default, CONTRACT.project.check_memory_max.default], 'role 4 GiB, check 2 GiB by default (E140 N1)');
    assert.ok(!('max_concurrent_runs' in policy.effective), 'no project max_concurrent_runs');
    for (const [field, value] of [['role_memory_max', 9 * GIB], ['check_memory_max', 9 * GIB], ['role_memory_max', 256 * MIB], ['check_memory_max', 256 * MIB]]) {
      const res = await fx.engine.post(`/v1/projects/${p}/policy`, { [field]: value });
      assert.deepEqual([res.status, res.body?.code, res.body?.subject?.field], [400, 'invalid_value', field], `${field} ${value} refused (→ ${res.status} ${res.text})`);
    }
    const scoped = await fx.engine.post(`/v1/projects/${p}/policy`, { max_concurrent_runs: 1 });
    assert.deepEqual([scoped.status, scoped.body?.code, scoped.body?.subject?.field], [400, 'unknown_field', 'max_concurrent_runs'], `the project max_concurrent_runs refused (→ ${scoped.status} ${scoped.text})`);
    // The engine key refused at start; a value outside max_concurrent_domains' range likewise.
    for (const [config_, code, field] of [[{ max_concurrent_runs: 2 }, 'unknown_field', 'max_concurrent_runs'], [{ max_concurrent_domains: 9 }, 'invalid_value', 'max_concurrent_domains'], [{ max_concurrent_domains: 0 }, 'invalid_value', 'max_concurrent_domains']]) {
      const home = makeTempDir('m438');
      t.after(() => removeDir(home));
      writeEngineConfig(home, { api_port: await freePort(), ...config_ });
      const r = await startRefused({ home });
      assert.deepEqual([r.code, r.refusal?.code, r.refusal?.subject?.field], [EXIT.config, code, field], `${JSON.stringify(config_)} refused at start (stderr: ${r.stderr})`);
    }
    // Q1: a lowered ceiling caps the effective value; the start is not refused.
    await changePolicy(fx.engine, p, { role_memory_max: 3 * GIB });
    await fx.engine.kill();
    writeEngineConfig(fx.home, { api_port: fx.port, ...SLICE2_CONFIG, domain_memory_max: 2 * GIB });
    await fx.start();
    const [z] = await held(fx, p, 1);
    await admitted(fx, p, [z], 1, 'a role admitted under the lowered ceiling');
    assert.equal(domainOfItem(fx.home, z)?.memory_max, 2 * GIB, 'the explicit 3 GiB capped at the 2 GiB ceiling: min(project value, domain_memory_max)');
    fx.scripted.release('all', 'gate');
  });

  test('(f) role_memory_max changed while a domain is admitted: its memory_max unchanged, the next domain takes the new value', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await admittingProject(fx);
    const [a] = await held(fx, p, 1);
    await admitted(fx, p, [a], 1, 'A admitted at 4 GiB');
    assert.equal(domainOfItem(fx.home, a)?.memory_max, ROLE, 'A at role_memory_max 4 GiB');
    await changePolicy(fx.engine, p, { role_memory_max: 3 * GIB });
    const [b] = await held(fx, p, 1);
    await admitted(fx, p, [a, b], 2, 'B admitted');
    assert.equal(domainOfItem(fx.home, a)?.memory_max, ROLE, 'A\'s admitted maximum is never resized');
    assert.equal(domainOfItem(fx.home, b)?.memory_max, 3 * GIB, 'B takes the new value');
    fx.scripted.release('all', 'gate');
    await tick(fx.engine, p);
  });
});
