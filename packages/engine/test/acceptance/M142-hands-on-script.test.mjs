// M142, the hands-on run Sean makes (M2 slice 14, manifest slice 14; no
// engine, no binary, nothing paid). M2 plan §3.9 M142; BS §10; E45 (the M1
// form); SEAM.md §163.
//
// The row itself is Sean's: he runs `docs/acceptance/reports/M2-hands-on.sh`
// and checks (1) to (9) for himself. What a test can hold without running
// anything real is the script's form and its guards: it parses; it prints
// each of M142's checks with a command he can run; every step that starts
// paid work is preceded by the gate that states what it can cost at most;
// and it refuses, before starting anything, without the key's reference as
// a path to a private file and without his spend confirmation. The refusals
// are run with a scrubbed environment in which `node`, `curl`, `git` and
// `claude` are fakes that only record that they were started; none may be.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const SCRIPT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M2-hands-on.sh');
const CONFIRM = 'I accept the M2 real lane on my Claude subscription, up to 25 USD a day as estimated';
const lines = () => readFileSync(SCRIPT, 'utf8').split('\n');

// A directory of fakes and a log of what was started.
function fakes(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-m142-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'started.log');
  spawnSync('mkdir', ['-p', bin]);
  for (const name of ['node', 'curl', 'git', 'claude', 'jq', 'systemctl']) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`);
    chmodSync(path, 0o755);
  }
  const key = join(dir, 'fake.key');
  writeFileSync(key, 'sk-test-surety-m142-not-a-key-0000000000\n', { mode: 0o600 });
  chmodSync(key, 0o600);
  const binary = join(dir, 'claude-pinned');
  writeFileSync(binary, '#!/bin/sh\nexit 1\n');
  chmodSync(binary, 0o755);
  return { dir, bin, log, key, binary };
}

function runScript(f, env) {
  const res = spawnSync('bash', [SCRIPT], { env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 });
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '', started: existsSync(f.log) ? readFileSync(f.log, 'utf8') : '' };
}

describe('M142 the hands-on script: its form and its guards (nothing is run that could spend)', () => {
  test('(a) the script parses (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n: ${res.stderr}`);
  });

  test("(b) each of M142's checks (1) to (9) is printed, each with a command Sean can run himself", () => {
    const all = lines();
    const def = all.findIndex((l) => /^check\(\) \{/.test(l));
    assert.ok(def >= 0, 'a check() that prints a check');
    assert.ok(all.slice(def, def + 4).join('\n').includes('You can run it yourself'), 'and says how to run it');
    for (let n = 1; n <= 9; n++) {
      const at = all.findIndex((l) => new RegExp(`^\\s*check ${n} "`).test(l));
      assert.ok(at >= 0, `CHECK (${n}) is printed`);
      const call = all.slice(at, at + 3).join('\n');
      assert.match(call, /"\s*\\?\s*\n?\s*"[^"]+/, `CHECK (${n}) carries a command (${call})`);
    }
  });

  test('(c) every step that starts paid work is preceded by the gate that states what it can cost at most', () => {
    const all = lines();
    const def = all.findIndex((l) => /^paid\(\) \{/.test(l));
    assert.ok(def >= 0, 'a paid() gate');
    const gate = all.slice(def, def + 14).join('\n');
    assert.ok(/At most/.test(gate) && /hard limit is your subscription's usage limits/.test(gate) && /allowance your own Claude use shares/.test(gate) && /read -r/.test(gate) && /die/.test(gate), 'it states the most a step can use, says it draws on the subscription his own use shares and names the hard limit, asks, and stops on anything but yes (E74 item 1)');
    // The lines that start paid work: Sean's approval of the attempt, every
    // chain-boundary answer, and a stage's first tick.
    const starts = all.map((l, i) => ({ l: l.trim(), i })).filter(({ l }) => /^wait_for_sean qualification_approval\b/.test(l) || /^let_through "\$P"/.test(l) || l === 'tick "$P"');
    assert.ok(starts.length >= 5, `the paid steps are found (${starts.length})`);
    let previous = def + 14;
    for (const { l, i } of starts) {
      const between = all.slice(previous, i);
      assert.ok(between.some((x) => /^\s*paid "/.test(x)), `"${l}" (line ${i + 1}) is preceded by a paid gate since the last paid step`);
      previous = i + 1;
    }
  });

  test('(e) step 0 is Sean\'s own: he makes the subscription token with claude setup-token, keeps it in a mode-600 file, never pastes it into the script, and is told how to revoke it after M2 (E74 item 1)', () => {
    const text = lines().join('\n');
    assert.match(text, /claude setup-token/, 'it tells him to run claude setup-token himself');
    assert.match(text, /install -m 600/, 'to keep the token in a file readable by him only');
    assert.match(text, /never paste the token/i, 'never to paste it into the script');
    assert.match(text, /revoke the (subscription )?token/i, 'and how to end it after M2');
    assert.match(text, /--secret-file "\$KEY_REF_NAME=\$SURETY_REAL_CREDENTIAL_REF"/, 'the engine is given the file, by reference');
    assert.match(text, /KEY_REF_NAME=backend\/claude\/subscription_token/, 'under the subscription token\'s reference (SEAM.md §160)');
    assert.match(text, /--auth-mode "\$AUTH_MODE"/, 'and the attempt asks for the subscription mode');
  });

  test('(d) it refuses before starting anything: without the key reference, with a reference that is not a path, with a key file others can read, without the spend confirmation, and without a terminal', (t) => {
    const f = fakes(t);
    const cases = [
      ['no credential reference', {}, /SURETY_REAL_CREDENTIAL_REF/],
      ['a token, not a path', { SURETY_REAL_CREDENTIAL_REF: 'sk-test-surety-m142-inline-0000000000' }, /absolute path/],
      ['no spend confirmation', { SURETY_REAL_CREDENTIAL_REF: f.key, SURETY_REAL_CLAUDE_BINARY: f.binary }, /SURETY_HANDS_ON_CONFIRM_SPEND/],
      ['no terminal', { SURETY_REAL_CREDENTIAL_REF: f.key, SURETY_REAL_CLAUDE_BINARY: f.binary, SURETY_HANDS_ON_CONFIRM_SPEND: CONFIRM }, /terminal/],
    ];
    for (const [what, env, message] of cases) {
      const res = runScript(f, env);
      assert.notEqual(res.status, 0, `${what}: it refuses (${res.stderr})`);
      assert.match(res.stderr, message, `${what}: it says why (${res.stderr})`);
      assert.match(res.stderr, /Nothing was started/, `${what}: and that nothing was started`);
      assert.equal(res.started, '', `${what}: no node, curl, git or claude was started (${res.started})`);
      assert.ok(!res.stderr.includes('sk-test-surety-m142') && !res.stdout.includes('sk-test-surety-m142'), `${what}: no key is echoed`);
    }
    chmodSync(f.key, 0o640);
    const open = runScript(f, { SURETY_REAL_CREDENTIAL_REF: f.key, SURETY_REAL_CLAUDE_BINARY: f.binary, SURETY_HANDS_ON_CONFIRM_SPEND: CONFIRM });
    assert.notEqual(open.status, 0, `a token file others can read: refused (${open.stderr})`);
    assert.match(open.stderr, /readable by you only/);
    assert.equal(open.started, '', 'and nothing was started');
  });
});
