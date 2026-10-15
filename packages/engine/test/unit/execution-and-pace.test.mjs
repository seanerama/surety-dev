// Developer tests for M5 slice 37 (D6 §§6.2 to 6.5, §7.6; K1, K2, K3; B07,
// B09, N01): the envelope at per-profile maxima on the kernel lane and its
// scripted observations, the hold reasons, the role profile's identity, and
// an authoring result's deferrals. Pure functions over stubs; nothing is
// allocated, started or read from the host.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { envelopeHold, setEnvelope, setScriptedEnvelope } = await import(join(dist, 'store', 'transitions', 'envelope.js'));
const { holdReasonOf } = await import(join(dist, 'scheduler', 'holds.js'));
const { sameProfile } = await import(join(dist, 'store', 'transitions', 'trust.js'));
const { fieldAllowed, parseReport } = await import(join(dist, 'runs', 'report.js'));

const GiB = 1024 ** 3;

// A store stub: the live domain rows the envelope reads.
const stubOf = (rows) => ({ prepare: () => ({ all: () => rows }) });
const kernel = (over = {}) => ({ real: false, max_concurrent_domains: 4, host_reserve_memory: 2 * GiB, host_reserve_disk: 0, domain_memory_max: 8 * GiB, domain_writable_bytes: 0, home: '/nonexistent', ...over });
const role = (id, memoryMax) => ({ id, cgroup_path: null, profile: 'role', reservation: null, project: 'p', status: 'launched', observation: null, memory_max: memoryMax, bound: 0 });

function withEnvelope(t, settings, scripted = null) {
  setEnvelope(settings);
  setScriptedEnvelope(scripted);
  t.after(() => {
    setEnvelope(null);
    setScriptedEnvelope(null);
  });
}

test('kernel lane: the slots cap whether or not memory is scripted; nothing else holds without a script', (t) => {
  withEnvelope(t, kernel());
  assert.equal(envelopeHold(stubOf([role('a', 4 * GiB), role('b', 4 * GiB), role('c', 4 * GiB)]), { kind: 'role', memory: 4 * GiB }), null, 'three running, a fourth admitted');
  const hold = envelopeHold(stubOf([1, 2, 3, 4].map((i) => role(`d${i}`, 4 * GiB))), { kind: 'role', memory: 4 * GiB });
  assert.deepEqual([hold?.subject.limit, hold?.subject.value], ['max_concurrent_domains', 4]);
});

test('kernel lane, scripted: each domain at its recorded maximum, with the add-back', (t) => {
  withEnvelope(t, kernel(), { mem_available: 7 * GiB, memory_current: { a: 3 * GiB }, default_current: 0 });
  // 2 + 4 + 4 = 10 <= 7 + 3: admitted (against MemAvailable alone it would not be).
  assert.equal(envelopeHold(stubOf([role('a', 4 * GiB)]), { kind: 'role', memory: 4 * GiB }), null);
  withEnvelope(t, kernel(), { mem_available: 6.5 * GiB, memory_current: { a: 3 * GiB }, default_current: 0 });
  const hold = envelopeHold(stubOf([role('a', 4 * GiB)]), { kind: 'role', memory: 4 * GiB });
  assert.equal(hold?.subject.limit, 'host_reserve_memory');
  assert.equal(hold.subject.needed, 10 * GiB);
  assert.equal(hold.subject.memory_max, 4 * GiB, 'the new domain counted at its own maximum');
});

test('kernel lane, scripted: an unreadable observation holds, naming it; never zero', (t) => {
  withEnvelope(t, kernel(), { mem_available: 'unreadable', memory_current: {}, default_current: 0 });
  const a = envelopeHold(stubOf([]), { kind: 'role', memory: 4 * GiB });
  assert.deepEqual([a?.code, a?.subject.unreadable], ['resource_envelope', 'MemAvailable']);
  withEnvelope(t, kernel(), { mem_available: 64 * GiB, memory_current: { a: 'unreadable' }, default_current: 0 });
  const b = envelopeHold(stubOf([role('a', 4 * GiB)]), { kind: 'role', memory: 4 * GiB });
  assert.deepEqual([b?.subject.unreadable, b?.subject.domain], ['memory.current', 'a']);
});

test('the hold reasons the scheduler records (N01): each blocker to its HoldReason, the rest none', () => {
  assert.equal(holdReasonOf('session_busy'), 'session_busy');
  assert.equal(holdReasonOf('chaining boundary'), 'chain_boundary');
  assert.equal(holdReasonOf('held by an open decision'), 'open_decision');
  assert.equal(holdReasonOf('authoring not ready'), 'authoring_readiness');
  assert.equal(holdReasonOf('depends on stage stg_1'), 'depends_on');
  assert.equal(holdReasonOf('depends on a protected-path writer running'), 'depends_on');
  assert.equal(holdReasonOf('project paused'), null);
  assert.equal(holdReasonOf('budget exhausted'), null);
});

test('the role profile is the qualification identity: every bound alike; none for an entry without one', () => {
  const p = { memory_max: 4 * GiB, writable_bytes: 4 * GiB, writable_inodes: 200000, tasks_max: 1024 };
  assert.equal(sameProfile({ ...p }, p), true);
  assert.equal(sameProfile({ ...p, memory_max: 8 * GiB }, p), false);
  assert.equal(sameProfile({ ...p, tasks_max: 64 }, p), false);
  assert.equal(sameProfile(null, p), false);
});

test("a phase authoring's deferrals and governed changes (B.7): the Verifier's fields, each in its form", () => {
  const result = {
    status: 'completed',
    summary: 's',
    deferred_criteria: [
      { criterion: 'R1.1', reason: 'no interface yet', prerequisite: { interface: 'sum' } },
      { criterion: 'R2.2', reason: 'no route yet', prerequisite: { stage: 2 } },
    ],
    governed_changes: { check_commands: true, programs: ['node'] },
  };
  assert.equal(fieldAllowed(result, 'verifier'), true);
  assert.equal(fieldAllowed(result, 'builder'), false, "a Builder's result carries no deferral");
  assert.ok(parseReport(result));
  for (const bad of [{ stage: 0 }, { stage: 1, interface: 'x' }, {}, { module: 'lib' }]) {
    assert.equal(parseReport({ ...result, deferred_criteria: [{ criterion: 'R1.1', reason: 'r', prerequisite: bad }] }), null, `prerequisite ${JSON.stringify(bad)} refused`);
  }
  assert.equal(parseReport({ ...result, governed_changes: { check_commands: 'yes' } }), null);
});
