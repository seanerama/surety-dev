// Developer tests for the host sampler's count of backends (D2 §7.2; SEAM.md
// §172, the dress rehearsal's second engine finding): a member running the
// backend's binary is a backend, except a fork of it not yet exec'd
// (PF_FORKNOEXEC) and younger than 1 s; two backends in one sample are a
// second backend. The sampler's reads are given here, look by look, and the
// /proc/<pid>/stat rule on text: no process is made and nothing signalled.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startBackendSampler, forkState, FORK_GRACE_MS } = await import(join(root, 'dist', 'invoke', 'sampler.js'));
const { claudeCapabilities } = await import(join(root, 'dist', 'invoke', 'adapters', 'claude.js'));

const INIT = 1;

// A /proc/<pid>/stat line with the given flags and start time (ticks), its
// command holding a space and parentheses.
const stat = (flags, startTicks) => {
  const after = ['S', '1', '1', '1', '0', '-1', String(flags), '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', String(startTicks), '1000', '10'];
  return `4242 (cla (u) de) ${after.join(' ')}\n`;
};

test('the stat rule: an unexec\'d fork younger than the bound is a fork; older, exec\'d, or unreadable, a backend', () => {
  const PF = 0x40;
  // Up 100 s; started at tick 9950 = 99.5 s: 500 ms old.
  assert.equal(forkState(stat(0x400000 | PF, 9950), 100), 'fork');
  assert.equal(forkState(stat(0x400000, 9950), 100), 'backend', 'exec\'d: the flag is clear');
  assert.equal(forkState(stat(PF, 9850), 100), 'backend', `unexec'd 1.5 s: past ${FORK_GRACE_MS} ms`);
  assert.equal(forkState(stat(PF, 9900), 100), 'backend', 'exactly the bound: a backend');
  assert.equal(forkState(null, 100), 'backend', 'an unreadable stat counts');
  assert.equal(forkState(stat(PF, 9950), null), 'backend', 'an unreadable uptime counts');
  assert.equal(forkState('garbage', 100), 'backend');
  assert.equal(forkState(stat(PF, 20000), 100), 'backend', 'a start time after now is not believed');
});

test("this process's own stat parses: not a fork (it exec'd node)", () => {
  const up = Number(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
  assert.equal(forkState(readFileSync('/proc/self/stat', 'utf8'), up), 'backend');
});

function scripted() {
  const state = { members: [], classes: new Map() };
  const io = {
    procs: () => (state.members === null ? null : [...state.members]),
    classify: (pid) => (state.classes.has(pid) ? state.classes.get(pid) : 'other'),
    cmdline: (pid) => (state.classes.get(pid) === 'backend' ? `/surety/backend/claude -p prompt (${pid})` : null),
  };
  const sampler = startBackendSampler('/unused', '/unused', 0, io);
  const look = (members, classes) => {
    Object.assign(state, { members, classes: new Map(Object.entries(classes).map(([k, v]) => [Number(k), v])) });
    sampler.sample();
  };
  return { look, stop: () => sampler.stop() };
}

test('one backend with forks caught before their exec at several looks: one backend, the forks counted apart', () => {
  const s = scripted();
  s.look([INIT, 10], { 10: 'backend' });
  s.look([INIT, 10, 11], { 10: 'backend', 11: 'fork' });
  s.look([INIT, 10, 11], { 10: 'backend', 11: 'fork' });
  s.look([INIT, 10, 12], { 10: 'backend', 12: 'fork' });
  s.look([INIT, 10, 13], { 10: 'backend', 13: 'other' });
  const r = s.stop();
  assert.deepEqual([r.samples, r.max_backend, r.transient_backend, r.max_members], [5, 1, 2, 3]);
  assert.ok(!claudeCapabilities([], r, []).reasons.some((x) => /second backend|never identified/.test(x)));
});

test('two backends in one sample are a second backend, however briefly; a fork past the bound is one', () => {
  const s = scripted();
  s.look([INIT, 10], { 10: 'backend' });
  s.look([INIT, 10, 12], { 10: 'backend', 12: 'backend' });
  s.look([INIT, 10], { 10: 'backend' });
  const r = s.stop();
  assert.equal(r.max_backend, 2);
  assert.ok(r.backend_cmdlines.some((c) => c.includes('(12)')));
  assert.ok(claudeCapabilities([], r, []).reasons.some((x) => /second backend/.test(x)));
});

test('a fork alone, the backend not seen: no backend identified', () => {
  const s = scripted();
  s.look([INIT, 11], { 11: 'fork' });
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [0, 1]);
  assert.ok(claudeCapabilities([], r, []).reasons.some((x) => /never identified the backend/.test(x)));
});

test('a member unreadable is unclassified, not a backend; a removed domain is not a sample', () => {
  const s = scripted();
  s.look([INIT, 10, 14], { 10: 'backend', 14: null });
  s.look(null, {});
  const r = s.stop();
  assert.deepEqual([r.samples, r.max_backend, r.unclassified], [1, 1, 1]);
});

test("a containment canary whose control did not run is containment_failed, not delegation_unverified (SEAM.md §165)", async () => {
  const { realFailureClass } = await import(join(root, 'dist', 'trust', 'attempts.js'));
  const caps = { delegation_verified: false };
  const base = { stream: null, authFailure: null, obs: undefined, candidates: [], capabilities: caps };
  assert.equal(realFailureClass('containment', 'containment_failed', { ...base, containmentHeld: false }), 'containment_failed');
  assert.equal(realFailureClass('containment', 'containment_failed', { ...base, containmentHeld: true }), 'delegation_unverified');
  assert.equal(realFailureClass('containment', 'containment_failed', { ...base, capabilities: { delegation_verified: true }, containmentHeld: true }), 'containment_failed');
});
