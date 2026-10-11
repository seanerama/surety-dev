// Objection 056: the domain init's mounts go through the legacy mount(2)
// (LIBMOUNT_FORCE_MOUNT2=always in the constructed environment of every
// util-linux tool it runs), so one option string is bounded at a page, not
// at the fd-based mount API's 256 bytes; a check plan whose input overlay
// reaches the page is refused with the reason before any domain starts; a
// sandbox the init could not build names its failure in the interruption.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { mountEnvironment } = await import(join(dist, 'invoke', 'domain-init.js'));
const { MOUNT_OPTIONS_MAX, overlongMountOptions } = await import(join(dist, 'invoke', 'sandbox', 'mounts.js'));
const { inputOverlayOverlong, inputsOverlayOptions } = await import(join(dist, 'checks', 'profile.js'));
const { boundedSetupFailure, decideResult, fromReports, SETUP_FAILURE_MAX_BYTES } = await import(join(dist, 'checks', 'run.js'));

test('the init runs its mounts under a constructed environment that forces the legacy mount(2)', () => {
  process.env.SURETY_UNIT_STRAY = 'inherited?';
  try {
    const env = mountEnvironment();
    assert.equal(env.LIBMOUNT_FORCE_MOUNT2, 'always', 'libmount is told to use mount(2), never fsconfig');
    assert.ok(typeof env.PATH === 'string' && env.PATH !== '', 'a PATH for the tools');
    assert.equal(env.LANG, 'C.UTF-8');
    assert.deepEqual(Object.keys(env).sort(), ['LANG', 'LIBMOUNT_FORCE_MOUNT2', 'PATH'], 'nothing of the parent environment passes through');
  } finally {
    delete process.env.SURETY_UNIT_STRAY;
  }
  // The one `run` every tool of the setup stage goes through spawns with
  // that environment: the first fstab, the late fstab, the tmpfs mounts, the
  // overlay trial and the final remount alike.
  const init = readFileSync(join(dist, 'invoke', 'domain-init.js'), 'utf8');
  assert.match(init, /function run\(cmd, args\) \{\s*const r = spawnSync\(cmd, args, \{[^}]*env: mountEnvironment\(\)/, 'run() spawns under mountEnvironment()');
  const spawns = [...init.matchAll(/spawnSync\(/g)].length;
  const withEnv = [...init.matchAll(/spawnSync\([^;]*env: /g)].length;
  assert.equal(spawns, withEnv, `every spawnSync of the init names its environment (${withEnv} of ${spawns})`);
});

test('one option string is bounded at the page mount(2) carries it in', () => {
  assert.equal(MOUNT_OPTIONS_MAX, 4096);
  assert.equal(overlongMountOptions('a'.repeat(4095)), null, '4095 bytes and a terminator fit the page');
  assert.match(overlongMountOptions('a'.repeat(4096)), /4096 bytes, which with the terminator passes the 4096-byte page/);
  // Bytes, not characters.
  assert.match(overlongMountOptions('é'.repeat(2048)), /4096 bytes/);
});

// Two projection paths each under PATH_MAX whose joined `lowerdir=` passes
// the page: ten components of 220 bytes under a temporary directory.
function deep(base, name) {
  let at = join(base, name);
  for (let i = 0; i < 10; i++) at = join(at, `${String(i)}${'d'.repeat(219)}`);
  mkdirSync(at, { recursive: true });
  return at;
}

test('a check plan whose input overlay cannot be carried is refused with the reason, before any domain starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-056-'));
  try {
    const manifest = [['.surety/checks/x.json', 'blob', '100644', 'a'.repeat(40)]];
    const source = deep(dir, 'src');
    const projection = deep(dir, 'inputs');
    mkdirSync(join(projection, '.surety', 'checks'), { recursive: true });
    // No `.surety` beside the input in the source: a plain bind, nothing to bound.
    assert.equal(inputOverlayOverlong(source, projection, manifest), null, 'no overlay without the source top');
    mkdirSync(join(source, '.surety'), { recursive: true });
    const options = inputsOverlayOptions(join(projection, '.surety'), join(source, '.surety'));
    assert.ok(Buffer.byteLength(options) >= MOUNT_OPTIONS_MAX, `the trial's option string passes the page (${Buffer.byteLength(options)} bytes)`);
    const why = inputOverlayOverlong(source, projection, manifest);
    assert.match(why, /the top-level directory "\.surety" holds a protected input beside the candidate's own/);
    assert.match(why, new RegExp(`its mount options are ${Buffer.byteLength(options)} bytes, which with the terminator passes the 4096-byte page`));
    // A short pair of paths: the same overlay, well within the page.
    const shortSrc = join(dir, 's');
    const shortProj = join(dir, 'p');
    mkdirSync(join(shortSrc, '.surety'), { recursive: true });
    mkdirSync(join(shortProj, '.surety', 'checks'), { recursive: true });
    assert.equal(inputOverlayOverlong(shortSrc, shortProj, manifest), null);
    // A file at the top is bound, never overlaid: nothing to bound either.
    const fileManifest = [['README.md', 'blob', '100644', 'a'.repeat(40)]];
    writeFileSync(join(projection, 'README.md'), 'x');
    writeFileSync(join(source, 'README.md'), 'y');
    assert.equal(inputOverlayOverlong(source, projection, fileManifest), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sandbox the init could not build names its failure in the interruption, live and from the recorded reports', () => {
  const stderr = '/usr/bin/mount --all --fstab /x/.fstab: mount: /x/root/surety/workspace/.surety: wrong fs type, bad option, bad superblock on surety-inputs';
  const base = { leaseLost: false, authorized: true, started: false, execFailed: false, report: null, cancelAt: null, cancelCause: null, reportAt: null, orphans: null };
  const unnamed = decideResult(base);
  assert.equal(unnamed.kind, 'interrupt');
  assert.equal(unnamed.why, 'the domain ended with neither a started nor an exec_failed report');
  const named = decideResult({ ...base, setupFailed: stderr });
  assert.equal(named.kind, 'interrupt');
  assert.equal(named.why, `the domain's setup failed before the check started: ${stderr}`);
  // A failed exec, or a started check, is never taken for a setup failure.
  assert.equal(decideResult({ ...base, execFailed: true, setupFailed: stderr }).kind, 'record');
  // From the recorded `setup_failed` report, what ended the supervision is
  // said as it happened (objection 055): a restart keeps its text and the
  // detail; a failure in this engine names the detail and claims no
  // restart; a cause not recorded is said to be unknown.
  const reports = [{ kind: 'setup_failed', detail: { text: stderr } }];
  const recovered = fromReports({ reports, authorized: true });
  assert.equal(recovered.kind, 'interrupt');
  assert.equal(recovered.why, `the engine restarted before the check's exit report was recorded; its domain's setup had failed before the check started: ${stderr}`);
  assert.equal(fromReports({ reports, authorized: true, cause: 'restart' }).why, recovered.why, 'the cause left unsaid is a restart');
  const failed = fromReports({ reports, authorized: true, cause: 'failure' });
  assert.equal(failed.why, `the domain's setup failed before the check started: ${stderr} (no engine restarted)`);
  assert.ok(!failed.why.includes('restarted before'), failed.why);
  const unknown = fromReports({ reports, authorized: true, cause: 'unknown' });
  assert.equal(unknown.why, `the domain's setup failed before the check started: ${stderr} (whether an engine restarted meanwhile is not recorded)`);
  // Without a recorded setup failure, 055's texts, and the unknown cause said.
  const plain = fromReports({ reports: [], authorized: true });
  assert.equal(plain.why, "the engine restarted before the check's exit report was recorded");
  assert.match(fromReports({ reports: [], authorized: true, cause: 'failure' }).why, /no engine restarted/);
  assert.match(fromReports({ reports: [], authorized: true, cause: 'unknown' }).why, /whether by an engine restart or by a failure in the engine that admitted it is not recorded/);
  // A started check whose exit was not recorded is never taken for a setup failure.
  assert.equal(fromReports({ reports: [...reports, { kind: 'started', detail: null }], authorized: true, cause: 'failure' }).why, "the check's setup or supervision failed in the engine that admitted it, before its exit report was recorded (no engine restarted)");
  // The recorded detail is whole up to its bound, else cut with the cut named.
  assert.equal(boundedSetupFailure(stderr), stderr);
  const long = 'm'.repeat(SETUP_FAILURE_MAX_BYTES + 100);
  const cut = boundedSetupFailure(long);
  assert.ok(cut.startsWith('m'.repeat(SETUP_FAILURE_MAX_BYTES)));
  assert.ok(cut.endsWith(' [cut: 100 bytes more]'), cut.slice(-40));
});
