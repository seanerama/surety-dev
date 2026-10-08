// M241, the hands-on run Sean makes (M3 slice 22, manifest slice 22; no
// engine, no model, nothing paid). M3 plan §3.8 M241 and question 6 (E92
// item 2 (6)); BS3 §10; E45, E88 (the form); SEAM.md §239. M2's form: M142.
//
// The row itself is Sean's: he runs `docs/acceptance/reports/M3-hands-on.sh`
// and checks (1) to (5) for himself. What a test can hold without running
// it is the script's form and its guards: it parses; it prints each of
// M241's five checks with a command he can run; it needs no model (no
// backend, no token, no paid step: scripted roles in the engine's test
// mode, the runner qualified by its own self-test); its one writing check is
// released only after the host has read it contained (E64); and it refuses
// before starting anything without a login session or a terminal. The
// refusals are run with a scrubbed environment in which `node`, `curl`,
// `git`, `jq`, `systemctl` and `claude` are fakes that only record that they
// were started; none may be.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const SCRIPT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M3-hands-on.sh');
const text = () => readFileSync(SCRIPT, 'utf8');
const lines = () => text().split('\n');

const CHECKS = {
  1: /cgroup\.procs/,
  2: /\.git/,
  3: /refused[\s\S]*src\/app\.js|src\/app\.js[\s\S]*refused/,
  4: /deciding[\s\S]*history/,
  5: /unclassifiable/,
};

function fakes(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-m241-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'started.log');
  mkdirSync(bin);
  for (const name of ['node', 'curl', 'git', 'jq', 'systemctl', 'claude']) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`);
    chmodSync(path, 0o755);
  }
  const runtime = join(dir, 'runtime');
  mkdirSync(runtime);
  return { dir, bin, log, runtime };
}

function runScript(f, env) {
  const res = spawnSync('bash', [SCRIPT], { env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 });
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '', started: existsSync(f.log) ? readFileSync(f.log, 'utf8') : '' };
}

describe('M241 the M3 hands-on script: its form and its guards (nothing is run)', () => {
  test('(a) the script parses (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n: ${res.stderr}`);
  });

  test("(b) each of M241's checks (1) to (5) is printed, each with what to look for and a command Sean can run himself", () => {
    const all = lines();
    const def = all.findIndex((l) => /^check\(\) \{/.test(l));
    assert.ok(def >= 0, 'a check() that prints a check');
    assert.ok(all.slice(def, def + 4).join('\n').includes('You can run it yourself'), 'and says how to run it');
    for (const [n, what] of Object.entries(CHECKS)) {
      const at = all.findIndex((l) => new RegExp(`^\\s*check ${n} "`).test(l));
      assert.ok(at >= 0, `CHECK (${n}) is printed`);
      const call = all.slice(at, at + 3).join('\n');
      assert.match(call, /"\s*\\\s*\n\s*"[^"]+/, `CHECK (${n}) carries a command (${call})`);
      assert.match(call, what, `CHECK (${n}) is the plan's: ${what}`);
    }
  });

  test('(c) it needs no model: no backend binary, no token, no paid step; scripted roles in the test mode; the runner qualified by the self-test, never the fixture', () => {
    const body = lines().filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/\bclaude\b/.test(body), 'no claude binary is named outside comments');
    assert.ok(!/--secret-file|SURETY_REAL_|setup-token|paid\(\)/.test(body), 'no credential, no real-lane switch, no paid step');
    assert.match(body, /serve --harness --harness-scripted "\$SCRIPTED" --harness-host-checks run --harness-runner-self-test run/, 'the engine runs scripted roles in its test mode, with the host checks and the runner self-test');
    assert.ok(!/fixtures\/(runner-qualification|check-result)|qualifyRunner/.test(body), 'neither the runner qualification fixture nor the check-result fixture');
  });

  test('(e) the writing check is released only after the host has read the program inside its own check domain (E64, both halves)', () => {
    const all = lines();
    const release = all.findIndex((l) => /^touch "\$RELEASE\/go"/.test(l));
    assert.ok(release > 0, 'the release');
    const before = all.slice(0, release).join('\n');
    assert.match(before, /cat "\$CG\/cgroup\.procs"/, 'it reads the domain\'s cgroup.procs from the host');
    assert.match(before, /die "the check program was not found in its domain: nothing is released"/, 'it refuses to release a program it did not find in the domain');
    assert.match(before, /\/proc\/\$PROG_PID\/cgroup[\s\S]*die "[^"]*nothing is released"/, "and one whose own /proc/<pid>/cgroup is not the domain's");
    assert.match(text(), /"--host-ns", \$ns, "write"/, "the program's own guard is given the host's namespaces");
  });

  test('(d) it refuses before starting anything: without a login session, and without a terminal (unless told not to pause)', (t) => {
    const f = fakes(t);
    const cases = [
      ['no login session', {}, /login session/],
      ['no terminal', { XDG_RUNTIME_DIR: f.runtime }, /terminal/],
    ];
    for (const [what, env, message] of cases) {
      const res = runScript(f, env);
      assert.notEqual(res.status, 0, `${what}: it refuses (${res.stderr})`);
      assert.match(res.stderr, message, `${what}: it says why (${res.stderr})`);
      assert.match(res.stderr, /Nothing was started/, `${what}: and that nothing was started`);
      assert.equal(res.started, '', `${what}: no node, curl, git, jq, systemctl or claude was started (${res.started})`);
    }
  });
});
