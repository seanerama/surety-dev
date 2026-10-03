// Developer tests for slice 12's pure parts (D2 §§1.4, 2.3, 2.4, 2.5, 2.7,
// A.6; rows M119 to M128): the egress proxy's address policy and its reading
// of a CONNECT authority; the collector's read of a file on the volatile
// filesystem, which never follows a link nor opens a FIFO; the
// materialization of what a role left, which writes only into the run's own
// workspace, never through a link and never its `.git`, and nothing at all
// on a secret; the protected roots' binds; the published plan's entries; the
// git view's configuration. Nothing here needs a sandbox: the acceptance
// rows run those.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { addressReason, answerVerdict } = await import(join(dist, 'invoke', 'proxy', 'address.js'));
const { parseAuthority, canonicalHost } = await import(join(dist, 'invoke', 'proxy', 'proxy.js'));
const { readRegular, components } = await import(join(dist, 'invoke', 'sandbox', 'volatile.js'));
const { materialize, verifyWorkspace } = await import(join(dist, 'invoke', 'sandbox', 'materialize.js'));
const { protectedBinds } = await import(join(dist, 'invoke', 'sandbox', 'prepare.js'));
const { viewConfig, objectFormat } = await import(join(dist, 'invoke', 'sandbox', 'gitview.js'));
const { holdSecret } = await import(join(dist, 'records', 'redact.js'));

const scratch = () => mkdtempSync(join(tmpdir(), 'surety-unit-s12-'));

test('the address policy refuses every forbidden family and the host, and lets documentation addresses through', () => {
  const host = new Set(['192.168.7.7']);
  for (const [a, why] of [
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.0.1', 'link_local'],
    ['fe80::1', 'link_local'],
    ['fd00::1', 'unique_local'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['2002:7f00:1::', 'loopback'],
    ['192.168.7.7', 'private'],
    ['not-an-address', 'not_numeric'],
  ]) {
    assert.equal(addressReason(a, host), why, a);
  }
  assert.equal(addressReason('::ffff:8.8.8.8', new Set(['8.8.8.8'])), 'host_address', 'a mapped form of a host address is the host');
  for (const a of ['192.0.2.10', '198.51.100.20', '203.0.113.30', '2001:db8::10']) assert.equal(addressReason(a, host), null, a);
  assert.deepEqual(answerVerdict(['192.0.2.10', '10.0.0.5'], host), { ok: false, address: '10.0.0.5', reason: 'private' }, 'one forbidden address refuses the whole answer');
  assert.deepEqual(answerVerdict([], host), { ok: false, address: null, reason: 'empty_answer' });
  assert.deepEqual(answerVerdict(['192.0.2.10'], host), { ok: true });
});

test('a CONNECT authority is parsed and canonicalized, or refused', () => {
  assert.deepEqual(parseAuthority('Example.COM.:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(parseAuthority('[::1]:8443'), { host: '::1', port: 8443 });
  for (const bad of ['example.com', 'example.com:0', 'example.com:70000', 'a b:443', 'user@host:443', ':443', 'host:443/x']) assert.equal(parseAuthority(bad), null, bad);
  assert.equal(canonicalHost('[FD00::1]'), 'fd00::1');
});

test('the collector reads a regular file under its bound, and refuses a link, a FIFO, a device link, an oversize file and a climbing path, opening none', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'ok.json'), '{"a":1}');
    writeFileSync(join(dir, 'out', 'big.json'), Buffer.alloc(11));
    symlinkSync('/etc/passwd', join(dir, 'out', 'link.json'));
    symlinkSync('/dev/zero', join(dir, 'out', 'dev.json'));
    execFileSync('mkfifo', [join(dir, 'out', 'fifo.json')]);
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'via'));
    writeFileSync(join(dir, 'real', 'x.json'), 'x');
    assert.equal(readRegular(dir, 'out/ok.json', 10).state, 'read');
    assert.equal(readRegular(dir, 'out/big.json', 10).reason, 'oversize');
    assert.equal(readRegular(dir, 'out/link.json', 10).reason, 'link');
    assert.equal(readRegular(dir, 'out/dev.json', 10).reason, 'link');
    assert.equal(readRegular(dir, 'out/fifo.json', 10).reason, 'fifo');
    assert.equal(readRegular(dir, 'via/x.json', 10).reason, 'link', 'a link in a parent component is not followed either');
    assert.equal(readRegular(dir, '../etc/passwd', 10).reason, 'path');
    assert.equal(readRegular(dir, 'out/none.json', 10).state, 'absent');
    assert.equal(components('/abs'), null);
    assert.equal(components('a/../b'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A hold standing for the volatile filesystem: `upper` the overlay's upper
// layer, `merged` the workspace as the role left it.
function fakeHold(dir) {
  mkdirSync(join(dir, 'vol', 'upper'), { recursive: true });
  mkdirSync(join(dir, 'merged'), { recursive: true });
  return { held: true, vol: join(dir, 'vol'), merged: join(dir, 'merged') };
}

test('materialization writes the role\'s changes into the run\'s own workspace only: new, changed, removed, a link replaced by a directory, never through a link and never the .git', () => {
  const dir = scratch();
  try {
    const home = join(dir, 'home');
    const ws = join(home, 'workspaces', 'run_X');
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(ws, 'keep'), { recursive: true });
    writeFileSync(join(ws, '.git'), 'gitdir: /host/path\n');
    writeFileSync(join(ws, 'a.txt'), 'base');
    writeFileSync(join(ws, 'gone.txt'), 'gone');
    writeFileSync(join(ws, 'keep', 'k.txt'), 'k');
    symlinkSync(outside, join(ws, 'ln'));
    const hold = fakeHold(dir);
    // The role changed a.txt, made new/n.txt, removed gone.txt, replaced the
    // link `ln` by a directory holding f.txt.
    for (const base of [join(hold.vol, 'upper'), hold.merged]) {
      writeFileSync(join(base, 'a.txt'), 'changed');
      mkdirSync(join(base, 'new'), { recursive: true });
      writeFileSync(join(base, 'new', 'n.txt'), 'n');
      mkdirSync(join(base, 'ln'), { recursive: true });
      writeFileSync(join(base, 'ln', 'f.txt'), 'f');
    }
    mkdirSync(join(hold.merged, 'keep'));
    writeFileSync(join(hold.merged, 'keep', 'k.txt'), 'k');
    writeFileSync(join(hold.merged, '.git'), 'gitdir: /surety/git\n');
    const r = materialize({ hold, home, workspace: ws });
    assert.equal(r.state, 'materialized', JSON.stringify(r));
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'changed');
    assert.equal(readFileSync(join(ws, 'new', 'n.txt'), 'utf8'), 'n');
    assert.equal(existsSync(join(ws, 'gone.txt')), false);
    assert.equal(lstatSync(join(ws, 'ln')).isDirectory(), true, 'the link is replaced, not written through');
    assert.deepEqual(existsSync(join(outside, 'f.txt')), false, 'nothing reached the link\'s target');
    assert.equal(readFileSync(join(ws, '.git'), 'utf8'), 'gitdir: /host/path\n', 'the workspace\'s own .git is never materialized');
    assert.equal(readFileSync(join(ws, 'keep', 'k.txt'), 'utf8'), 'k');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('materialization refuses a workspace that is not the engine home\'s, and writes nothing when the screen finds a registered secret', () => {
  const dir = scratch();
  try {
    const home = join(dir, 'home');
    mkdirSync(join(home, 'workspaces'), { recursive: true });
    const elsewhere = join(dir, 'checkout');
    mkdirSync(elsewhere);
    assert.notEqual(verifyWorkspace(home, elsewhere), null, 'a developer checkout is not a workspace');
    assert.notEqual(verifyWorkspace(home, join(home, 'workspaces')), null, 'nor is the directory of them all');
    const ws = join(home, 'workspaces', 'run_Y');
    mkdirSync(ws);
    const secret = `sk-unit-secret-${process.pid}-materialize`;
    holdSecret('unit/secret', secret);
    const hold = fakeHold(dir);
    for (const base of [join(hold.vol, 'upper'), hold.merged]) {
      writeFileSync(join(base, 'clean.txt'), 'clean');
      writeFileSync(join(base, 'leak.txt'), `the key is ${JSON.stringify(secret)}`);
    }
    const r = materialize({ hold, home, workspace: ws });
    assert.equal(r.state, 'refused');
    assert.equal(r.reason, 'secret');
    assert.equal(existsSync(join(ws, 'clean.txt')), false, 'nothing is written when any file holds a secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the protected roots are bound from the checkout, a missing directory root made empty, a root reached through a link not bound', () => {
  const dir = scratch();
  try {
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, '.surety', 'checks'), { recursive: true });
    writeFileSync(join(ws, 'PROTECTED.md'), 'p');
    symlinkSync(dir, join(ws, 'linked'));
    const binds = protectedBinds(ws, ['.surety/checks/', 'PROTECTED.md', 'linked/sub/', 'absent/', '../escape/', '.git/'], '/empty');
    const byTarget = (a, b) => (a.target < b.target ? -1 : 1);
    assert.deepEqual([...binds].sort(byTarget), [
      { source: join(ws, '.surety', 'checks'), target: '.surety/checks' },
      { source: join(ws, 'PROTECTED.md'), target: 'PROTECTED.md' },
      { source: '/empty', target: 'absent', make: 'dir' },
    ].sort(byTarget));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the git view\'s configuration is core settings only, and keeps a repository\'s sha256 object format', () => {
  const text = viewConfig('sha1');
  assert.ok(!/include|hookspath|fsmonitor|helper|worktree|askpass|editor|pager|sshcommand|gitproxy|attributesfile|excludesfile/i.test(text), text);
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('[')), ['[core]']);
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'config'), '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n');
    assert.equal(objectFormat(dir), 'sha256');
    assert.match(viewConfig('sha256'), /objectformat = sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  void readlinkSync;
});
