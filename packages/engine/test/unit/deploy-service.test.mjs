// Developer tests for M4 slice 24, deploy and identify on a real unit (D4
// §§3.1, 3.4, 9.2, 9.5; BS4 §4.1; SEAM.md §§256 to 262): the guards that keep
// every act to the engine's own derived names and recorded resources, the
// service init's kill(-1) guard, the start command's checks, the artifact
// sweep's removal guards, and reconcile's reading of a disagreeing launch.
// Pure functions and scratch directories; no engine is started, no unit is
// created, no process is signalled, and no systemctl or systemd-run runs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { mayKillAll } = await import(join(dist, 'invoke', 'domain-init.js'));
const { ownUnit, unitPrefix, writeServiceKill, homeHash12 } = await import(join(dist, 'deploy', 'adapters', 'local-service.js'));
const { checkStart } = await import(join(dist, 'deploy', 'commands.js'));
const { sweepArtifacts, removeUnrecorded, removeStaging } = await import(join(dist, 'deploy', 'artifact.js'));
const { judgeReconcile } = await import(join(dist, 'deploy', 'reconcile.js'));

const ENV = 'env_01M4J9JJJ4KMQNWQCR5XPPTVNJ';
const OTHER = 'env_01M4J9JJJ4KMQNWQCR5XPPTVNK';
const PROJECT = 'proj_01M4J8BZV6C5W7PAYWHVXSE7W7';
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-s24-'));
  t.after(() => {
    const open = (d) => {
      let st;
      try {
        st = lstatSync(d);
      } catch {
        return;
      }
      if (!st.isDirectory()) return;
      chmodSync(d, 0o700);
      for (const n of readdirSync(d)) open(join(d, n));
    };
    open(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

test("the service init sends kill(-1) only as process 1 of a pid namespace that is not the initial one; an unreadable namespace refuses", () => {
  assert.equal(mayKillAll(1, () => 'pid:[4026532123]'), true, 'pid 1 of a namespace of its own');
  assert.equal(mayKillAll(1, () => 'pid:[4026531836]'), false, 'pid 1 of the initial pid namespace (the host init) never');
  assert.equal(mayKillAll(4242, () => 'pid:[4026532123]'), false, 'any pid but 1 never');
  assert.equal(mayKillAll(1, () => 'mnt:[4026532123]'), false, 'a namespace link that is not a pid namespace refuses');
  assert.equal(
    mayKillAll(1, () => {
      throw new Error('EACCES');
    }),
    false,
    'an unreadable namespace refuses',
  );
  assert.equal(mayKillAll(process.pid), false, 'this test process (not pid 1) never');
  // The source sends kill(-1) at one site only, inside the guarded helper.
  const source = readFileSync(join(root, 'src', 'invoke', 'domain-init.ts'), 'utf8');
  const sites = [...source.matchAll(/process\.kill\(\s*-1/g)];
  assert.equal(sites.length, 1, 'one kill(-1) site');
  const helper = source.slice(source.indexOf('function killAll('), source.indexOf('function killAll(') + 200);
  assert.match(helper, /if \(!mayKillAll\(\)\) return;[\s\S]*process\.kill\(-1, signal\)/, 'and it is guarded by mayKillAll');
});

test("the adapter's guard: only names derived from this home's prefix for the environment, and for an effect only the intent's", () => {
  const home = '/tmp/surety-acc-home-x';
  const own = `${unitPrefix(home, ENV)}g1.service`;
  assert.equal(own, `surety-${createHash('sha256').update(home).digest('hex').slice(0, 12)}-${ENV}-g1.service`, 'the prefix is sha256 of the home, 12 hex, and the environment id (D4 §9.3)');
  assert.equal(homeHash12(home).length, 12);
  assert.equal(ownUnit(home, ENV, own), null, 'its own name');
  assert.equal(ownUnit(home, ENV, own, [own]), null, 'named in the intent');
  assert.match(ownUnit(home, ENV, own, []), /frozen intent/, 'not named in the intent: refused');
  assert.match(ownUnit('/tmp/surety-acc-home-y', ENV, own), /prefix/, "another home's name: refused");
  assert.match(ownUnit(home, OTHER, own), /prefix/, "another environment's name: refused");
  for (const bad of [`${unitPrefix(home, ENV)}*`, `${unitPrefix(home, ENV)}g0.service`, `${unitPrefix(home, ENV)}g1.scope`, 'sdlcx-decoy-0123456789ab.service', `${unitPrefix(home, ENV)}g1.service --all`, '', 'user@1000.service']) {
    assert.notEqual(ownUnit(home, ENV, bad), null, `${JSON.stringify(bad)} is refused`);
  }
});

test('cgroup.kill is written only to the recorded cgroup of the exact unit, of the service-unit form', (t) => {
  const unit = `${unitPrefix('/h', ENV)}g1.service`;
  const good = `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
  assert.match(writeServiceKill(good, { unit, recorded: `${good}x`, inode: null }), /not the recorded cgroup/, 'not the recorded path: refused');
  assert.match(writeServiceKill('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice', { unit, recorded: '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice', inode: null }), /not the recorded cgroup/, 'the slice: refused');
  assert.match(writeServiceKill(`/sys/fs/cgroup/user.slice/../${unit}`, { unit, recorded: `/sys/fs/cgroup/user.slice/../${unit}`, inode: null }), /not the recorded cgroup/, 'a path with ..: refused');
  const dir = scratch(t);
  const fake = join(dir, unit);
  mkdirSync(fake);
  assert.match(writeServiceKill(fake, { unit, recorded: fake, inode: null }), /not the recorded cgroup/, 'outside /sys/fs/cgroup: refused');
  assert.equal(existsSync(join(fake, 'cgroup.kill')), false, 'nothing was written');
  const other = `${unitPrefix('/h', ENV)}g2.service`;
  assert.match(writeServiceKill(good, { unit: other, recorded: good, inode: null }), /not the recorded cgroup/, "another unit's name: refused");
});

test("the start command: the entry point a file of the artifact, relative to /surety/app; no argument names a host path", () => {
  const paths = new Set(['server.js', 'lib/greeting.js']);
  checkStart(['/usr/bin/node', 'server.js'], paths);
  checkStart(['/usr/bin/node', '/surety/app/server.js', '--max-old-space-size=64'], paths);
  const field = (start) => {
    try {
      checkStart(start, paths);
      return null;
    } catch (err) {
      return err.subject?.field;
    }
  };
  assert.equal(field(['/usr/bin/node', 'missing.js']), 'start.1');
  assert.equal(field(['/usr/bin/node', '/home/someone/repo/server.js']), 'start.1');
  assert.equal(field(['/usr/bin/node']), 'start.1');
  assert.equal(field(['/usr/bin/node', 'server.js', '--require=/home/someone/x.js']), 'start.2');
  assert.equal(field(['/usr/bin/node', 'server.js', '/etc/passwd']), 'start.2');
});

test("the artifact sweep removes staging and sealed directories no row records, never a recorded one or anything outside the home's artifacts/", (t) => {
  const home = scratch(t);
  const arts = join(home, 'artifacts');
  const proj = join(arts, PROJECT);
  const hex = (c) => c.repeat(64);
  const recorded = join(proj, hex('a'));
  const unrecorded = join(proj, hex('b'));
  for (const d of [recorded, unrecorded, join(arts, '.staging-0123456789abcdef'), join(proj, '.staging-fedcba9876543210')]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'f'), 'x');
    chmodSync(join(d, 'f'), 0o444);
    chmodSync(d, 0o555);
  }
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'keep');
  symlinkSync(outside, join(proj, hex('c')));
  writeFileSync(join(arts, 'notes.txt'), 'not the engine\'s');
  const { removed, refused } = sweepArtifacts(home, [recorded]);
  assert.deepEqual(removed.sort(), [join(arts, '.staging-0123456789abcdef'), join(proj, '.staging-fedcba9876543210'), unrecorded].sort(), 'the staging and the unrecorded sealed directory');
  assert.deepEqual(refused, [join(proj, hex('c'))], 'a link in place of a sealed directory is refused');
  assert.ok(existsSync(join(recorded, 'f')), 'the recorded artifact is kept');
  assert.ok(existsSync(join(outside, 'keep')), 'nothing outside artifacts/ is touched');
  assert.ok(existsSync(join(arts, 'notes.txt')), 'a name of another form is left');
  assert.throws(() => removeStaging(home, outside), /not a staging directory/);
  assert.throws(() => removeUnrecorded(home, outside, true), /not a sealed directory/);
});

test("reconcile reads a launch whose init's report and host read disagreed as conflicting, never applied", () => {
  const prefix = `surety-0123456789ab-${ENV}-`;
  const unit = `${prefix}g1.service`;
  const result = { ok: { outcome: 'unknown', complete: true, inventory: [{ resource: unit, kind: 'unit', recorded: true, state: 'active', pendingJob: false, generation: 1, instance: 'unread', tree: 'unread' }], reads: [], identity: [] } };
  const base = { kind: 'deploy', prefix, digest: 'sha256:x', create_units: [unit], prior: [], stop_units: [], recorded: [unit], launch_granted: true, app_instance: null };
  assert.equal(judgeReconcile(result, base).outcome, 'unknown', 'no instance recorded: unknown');
  assert.equal(judgeReconcile(result, { ...base, binding_conflict: true }).outcome, 'conflicting', 'a disagreement recorded: conflicting');
});
