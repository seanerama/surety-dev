// Developer tests for descriptors inherited without close-on-exec (D2 §§2.2,
// 2.3; A.6 P14; the finding from the second host, where a Tailscale SSH
// session left two /dev/ptmx descriptors open in the engine and they reached
// the role through the launcher's and the init's execs). A process started
// with an extra descriptor that lacks close-on-exec passes it through an
// exec; the engine's, the launcher's and the init's closing of inherited
// descriptors stops it there. Nothing here builds a sandbox.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const descriptors = join(dist, 'invoke', 'descriptors.js');

// A child of node with `/dev/null` as an extra descriptor, 40, past a gap
// in its descriptors: node marks close-on-exec only the descriptors up to
// the first gap past 15 (libuv's uv_disable_stdio_inheritance), so one there
// keeps no close-on-exec, as the second host's inherited pty descriptors 28
// and 29 did. The child runs `script`, which may close what it inherited,
// then execs `ls /proc/self/fd`, as the launcher execs unshare. Returns the
// descriptors the exec'd program held (3 is ls's own listing).
function afterExec(script) {
  const fd = openSync('/dev/null', 'r');
  try {
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${script}\nprocess.execve('/usr/bin/ls', ['ls', '/proc/self/fd'], { PATH: '/usr/bin:/bin' });`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', ...Array.from({ length: 37 }, () => 'ignore'), fd], encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
  } finally {
    closeSync(fd);
  }
}

test('control: a descriptor inherited without close-on-exec survives an exec', () => {
  const fds = afterExec('');
  assert.ok(fds.includes(40), `the exec'd program holds descriptor 40 (${fds.join(' ')})`);
});

test("the engine's closing of inherited descriptors keeps them from the next exec", () => {
  const fds = afterExec(`const { closeInheritedDescriptors } = await import(${JSON.stringify(descriptors)}); const closed = closeInheritedDescriptors(); if (!closed.includes(40)) process.exit(9);`);
  assert.deepEqual(fds, [0, 1, 2, 3], `only 0 to 2 and ls's own listing remain (${fds.join(' ')})`);
});

test('the launcher and the domain init carry the same closing, before their execs and before the backend', () => {
  for (const file of ['launcher.js', 'domain-init.js']) {
    const text = readFileSync(join(dist, 'invoke', file), 'utf8');
    assert.match(text, /function closeInherited\(\)/, `${file} has the closing`);
    const execve = text.indexOf('.execve(');
    assert.ok(execve > 0 && text.lastIndexOf('closeInherited();', execve) > 0, `${file} closes before it execs`);
  }
  const init = readFileSync(join(dist, 'invoke', 'domain-init.js'), 'utf8');
  const spawnAt = init.indexOf('child = spawn(spec.argv[0]');
  assert.ok(spawnAt > 0 && init.lastIndexOf('closeInherited();', spawnAt) > init.indexOf('async function init('), 'the init closes before it starts the backend');
});
