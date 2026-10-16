// Developer tests for the host sampler's embedded tool (real loop run 2,
// 2026-10-16: claude 2.1.300's containment canary failed delegation_unverified
// on "a second backend process" that was its embedded ripgrep, the binary
// exec'd with argv[0] `rg`; the driver's ruling). A member running the
// backend's binary under argv[0] `rg` is not a backend, is recorded apart,
// and is one again when its command line carries an agent flag or cannot be
// read whole. The rule is tested on argv, the sampler on scripted reads, and
// the host reads once on a copy of bash exec'd under argv[0] `rg`: the
// children are this test's own, ended by their handles.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startBackendSampler, isEmbeddedTool } = await import(join(root, 'dist', 'invoke', 'sampler.js'));
const { claudeCapabilities } = await import(join(root, 'dist', 'invoke', 'adapters', 'claude.js'));

const INIT = 1;
const RG_LIST = ['rg', '--no-config', '--files', '--hidden', '--no-ignore', '--max-depth', '4', '--glob', '.orphaned_at', '/surety/home/.claude/plugins/cache'];

test('the rule on argv: argv[0] rg without agent flags is the embedded tool; anything else is not', () => {
  assert.equal(isEmbeddedTool(['rg', '--version']), true);
  assert.equal(isEmbeddedTool(RG_LIST), true);
  assert.equal(isEmbeddedTool(['/some/dir/rg', '-n', 'foo', '.']), true, 'the basename is what counts');
  assert.equal(isEmbeddedTool(['/surety/backends/claude-2.1.300', '-p', '--model', 'm']), false, 'the backend itself');
  assert.equal(isEmbeddedTool(['rgx', '--version']), false);
  assert.equal(isEmbeddedTool(['rg.exe', '--version']), false);
  for (const flag of ['-p', '--print', '--output-format', '--model', '--session-id', '--resume', '--continue']) {
    assert.equal(isEmbeddedTool(['rg', '--files', flag, 'x']), false, `${flag} makes it a backend`);
  }
  assert.equal(isEmbeddedTool(['rg', '--output-format=stream-json']), false, '--flag=value');
  assert.equal(isEmbeddedTool(['rg', '-cp']), false, 'p in a cluster of short flags');
  assert.equal(isEmbeddedTool(['rg', '--modelx']), true, 'a different flag');
  assert.equal(isEmbeddedTool(null), false, 'unread: not the tool');
  assert.equal(isEmbeddedTool([]), false);
});

function scripted() {
  const state = { members: [], classes: new Map(), lines: new Map() };
  const io = {
    procs: () => [...state.members],
    classify: (pid) => (state.classes.has(pid) ? state.classes.get(pid) : 'other'),
    cmdline: (pid) => state.lines.get(pid) ?? null,
  };
  const sampler = startBackendSampler('/unused', '/unused', 0, io);
  const look = (members, classes, lines = {}) => {
    state.members = members;
    state.classes = new Map(Object.entries(classes).map(([k, v]) => [Number(k), v]));
    state.lines = new Map(Object.entries(lines).map(([k, v]) => [Number(k), v]));
    sampler.sample();
  };
  return { look, stop: () => sampler.stop() };
}

test('the run 2 shape: the backend and two embedded rg members at once: one backend, the tool recorded apart, no second backend', () => {
  const s = scripted();
  const lines = { 10: '/surety/backends/claude -p --model m', 20: 'rg --version', 21: RG_LIST.join(' ') };
  s.look([INIT, 10], { 10: 'backend' }, lines);
  s.look([INIT, 10, 20, 21], { 10: 'backend', 20: 'embedded_tool', 21: 'embedded_tool' }, lines);
  s.look([INIT, 10, 21], { 10: 'backend', 21: 'embedded_tool' }, lines);
  const r = s.stop();
  assert.deepEqual([r.samples, r.max_backend, r.embedded_tool, r.max_members], [3, 1, 2, 4]);
  assert.deepEqual(r.backend_cmdlines, [lines[10]]);
  assert.deepEqual(r.embedded_tool_cmdlines, [lines[20], lines[21]]);
  assert.ok(!claudeCapabilities([], r, []).reasons.some((x) => /second backend|never identified/.test(x)));
});

test('a member the classifier calls a backend (rg with agent flags, or unread) still counts; forks are as before', () => {
  const s = scripted();
  s.look([INIT, 10, 11, 12], { 10: 'backend', 11: 'fork', 12: 'backend' }, { 10: 'claude -p', 12: 'rg --files --model m' });
  s.look([INIT, 10, 13], { 10: 'backend', 13: null });
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.transient_backend, r.embedded_tool, r.unclassified], [2, 1, 0, 1]);
  assert.ok(claudeCapabilities([], r, []).reasons.some((x) => /second backend/.test(x)));
});

test('the embedded tool alone, the backend not seen: no backend identified', () => {
  const s = scripted();
  s.look([INIT, 20], { 20: 'embedded_tool' }, { 20: 'rg --version' });
  const r = s.stop();
  assert.deepEqual([r.max_backend, r.embedded_tool], [0, 1]);
  assert.ok(claudeCapabilities([], r, []).reasons.some((x) => /never identified the backend/.test(x)));
});

test("the host's reads: a copy of bash exec'd as itself, as rg, and as rg with --model; only the plain rg is the embedded tool", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'srg-'));
  const binary = join(dir, 'claude');
  copyFileSync('/bin/bash', binary);
  const kids = [];
  t.after(() => {
    for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  // `read` waits on the test's pipe in bash itself: no grandchild is made.
  const start = (argv0, extra) =>
    new Promise((resolve, reject) => {
      const k = spawn(binary, ['-c', 'read -r _', ...extra], { argv0, stdio: ['pipe', 'ignore', 'ignore'] });
      kids.push(k);
      k.once('spawn', () => resolve(k.pid));
      k.once('error', reject);
    });
  const backend = await start(binary, []);
  const tool = await start('rg', ['--files', '--hidden']);
  const disguised = await start('rg', ['x', '--model', 'claude-opus-5-5']);
  writeFileSync(join(dir, 'cgroup.procs'), `${backend}\n${tool}\n${disguised}\n`);
  const sampler = startBackendSampler(dir, binary, 0);
  sampler.sample();
  const r = sampler.stop();
  assert.equal(r.samples, 1);
  assert.equal(r.max_backend, 2, JSON.stringify(r));
  assert.equal(r.embedded_tool, 1, JSON.stringify(r));
  assert.deepEqual(r.embedded_tool_cmdlines, ['rg -c read -r _ --files --hidden']);
  assert.ok(r.backend_cmdlines.some((c) => c.startsWith('rg ') && c.includes('--model')), JSON.stringify(r));
  assert.ok(r.backend_cmdlines.some((c) => c.startsWith(binary)), JSON.stringify(r));
});
