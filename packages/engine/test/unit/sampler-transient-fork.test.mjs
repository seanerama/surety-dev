// Developer tests for the host sampler's count of backends (D2 §7.2; the
// dress rehearsal's second engine finding, SEAM §171): a process the backend
// forks runs the backend's binary until its exec, so a look that catches it
// then must not read as a second backend; a second backend that persists
// must still count. The sampler's reads are given here, look by look, with
// the time of each look: no process is made and nothing is signalled.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startBackendSampler, PERSIST_MS } = await import(join(root, 'dist', 'invoke', 'sampler.js'));
const { claudeCapabilities } = await import(join(root, 'dist', 'invoke', 'adapters', 'claude.js'));

const INIT = 1;
const SHELL = 50;

// A domain whose members, and which of them run the backend's binary, are
// set before each look. `members: null` is a domain whose directory is gone.
function scripted() {
  const state = { at: 0, members: [], backends: new Set(), gone: new Set() };
  const io = {
    procs: () => (state.members === null ? null : [...state.members]),
    classify: (pid) => (state.gone.has(pid) ? null : state.backends.has(pid)),
    cmdline: (pid) => (state.backends.has(pid) ? `/surety/backend/claude -p prompt (${pid})` : null),
    now: () => state.at,
  };
  const sampler = startBackendSampler('/unused', '/unused', 0, io);
  const look = (at, members, backends, gone = []) => {
    Object.assign(state, { at, members, backends: new Set(backends), gone: new Set(gone) });
    sampler.sample();
  };
  return { look, stop: () => sampler.stop() };
}

test('one backend, looked at for a while: one backend, nothing transient', () => {
  const s = scripted();
  for (const at of [0, 250, 500, 750]) s.look(at, [INIT, 10], [10]);
  const r = s.stop();
  assert.deepEqual([r.samples, r.max_backend, r.transient_backend, r.max_members], [4, 1, 0, 2]);
});

test('a backend seen at one look only is still identified', () => {
  const s = scripted();
  s.look(0, [INIT, 10], [10]);
  s.look(250, [INIT], []);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [1, 0]);
});

test("a fork caught before its exec, at one look, then a shell: not a second backend, and counted as transient", () => {
  const s = scripted();
  s.look(0, [INIT, 10], [10]);
  s.look(250, [INIT, 10, 11], [10, 11]);
  s.look(500, [INIT, 10, 11], [10]);
  s.look(750, [INIT, 10], [10]);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [1, 1]);
  assert.equal(claudeCapabilities([], r, []).delegation_verified, false, 'still unverified here: no stream shows the tools');
  assert.ok(!claudeCapabilities([], r, []).reasons.some((x) => /second backend/.test(x)), 'but not for a second backend');
});

test('a fork caught at two looks a few milliseconds apart is not yet a second backend; its exec by the next look settles it', () => {
  const s = scripted();
  s.look(0, [INIT, 10], [10]);
  s.look(250, [INIT, 10, 11], [10, 11]);
  s.look(255, [INIT, 10, 11], [10, 11]);
  s.look(505, [INIT, 10, 11], [10]);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [1, 1]);
});

test('a second backend that persists counts: two at once', () => {
  const s = scripted();
  s.look(0, [INIT, 10], [10]);
  s.look(250, [INIT, 10, SHELL, 12], [10, 12]);
  s.look(250 + PERSIST_MS, [INIT, 10, SHELL, 12], [10, 12]);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [2, 0]);
  assert.ok(r.backend_cmdlines.some((c) => c.includes('(12)')), 'and its command line is kept');
});

test('a second backend that persists after the first has gone counts once the first look is old enough, and two that start together both count', () => {
  const s = scripted();
  s.look(0, [INIT, 10, 12], [10, 12]);
  s.look(250, [INIT, 10, 12], [10, 12]);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [2, 0]);
});

test('a second backend first seen at the last look of a live domain is counted: nothing showed it a fork', () => {
  const s = scripted();
  s.look(0, [INIT, 10], [10]);
  s.look(250, [INIT, 10], [10]);
  s.look(500, [INIT, 10, 13], [10, 13]);
  const r = s.stop();
  assert.equal(r.max_backend, 2);
});

test('a member pending when the domain was removed did not outlive it: transient, not a second backend', () => {
  const s = scripted();
  s.look(0, [INIT, 10], [10]);
  s.look(250, [INIT, 10, 11], [10, 11]);
  s.look(500, null, []);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend], [1, 1]);
});

test('a member gone between its listing and its read is unclassified, not a backend', () => {
  const s = scripted();
  s.look(0, [INIT, 10, 14], [10], [14]);
  s.look(250, [INIT, 10], [10]);
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.unclassified, r.transient_backend], [1, 1, 0]);
});

test('the capabilities still fail on a persisting second backend and on none identified', () => {
  const base = { samples: 4, max_members: 3, unclassified: 0, backend_cmdlines: [], transient_backend: 2 };
  const two = claudeCapabilities([], { ...base, max_backend: 2 }, []);
  assert.ok(two.reasons.some((x) => /second backend/.test(x)));
  const none = claudeCapabilities([], { ...base, max_backend: 0 }, []);
  assert.ok(none.reasons.some((x) => /never identified the backend/.test(x)));
  const one = claudeCapabilities([], { ...base, max_backend: 1 }, []);
  assert.ok(!one.reasons.some((x) => /second backend|never identified/.test(x)));
});
