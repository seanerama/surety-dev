// M344, the hands-on run Sean makes (M4 slice 30, manifest slice 30; no
// engine, no model, nothing paid). M4 plan §3.8 M344 and BS4 §16 question 9
// (E121 item 4: a script in M3's form); BS4 §13; E45, E109 (the form);
// SEAM.md §337. M3's form: M241.
//
// The row itself is Sean's: he runs `docs/acceptance/reports/M4-hands-on.sh`
// and checks (1) to (6) for himself. What a test can hold without running it
// is the script's form and its guards:
//   (a) it parses;
//   (b) it prints each of M344's six checks with a command he can run;
//   (c) it needs no model: no backend, no token, no paid step; scripted roles
//       in the engine's test mode with the real adapter; the runner qualified
//       by its self-test and the adapter by `qualify-adapter`, never a fixture;
//   (d) it refuses before starting anything without a login session or a
//       terminal (the no-pause switch skips pauses only), run with a scrubbed
//       environment in which `node`, `curl`, `git`, `jq`, `systemctl`,
//       `journalctl` and `claude` are fakes that only record that they were
//       started; none may be;
//   (e) it never acts on a unit itself: no acting `systemctl` verb and no
//       `systemd-run` outside a line that only prints; the manual restart is
//       printed by the unit's exact name, after the containment read; the
//       only signal is to its own engine, after /proc names it;
//   (f) every step that makes the engine act reads the prefix first;
//   (g) its temporary directory is removed unless KEEP=1, and kept, with
//       each leftover printed by exact name, while anything of its prefix
//       is loaded.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const SCRIPT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M4-hands-on.sh');
const text = () => readFileSync(SCRIPT, 'utf8');
const lines = () => text().split('\n');
// The script's code: no comment line.
const code = () => lines().map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*#/.test(l));

// M344's six checks, as the plan words them, by what each command must read.
const CHECKS = {
  1: { what: /unit[\s\S]*cgroup/i, command: /systemctl --user show[\s\S]*cgroup\.procs/ },
  2: { what: /application instance[\s\S]*identity read[\s\S]*sealed digest/i, command: /\/proc\/\$APP_PID\/(stat|exe)/ },
  3: { what: /verification row[\s\S]*first and second identity reads[\s\S]*post-deploy check/i, command: /environments\/alpha/ },
  4: { what: /restart[\s\S]*launcher is refused[\s\S]*out of band[\s\S]*teardown and acknowledge/i, command: /^"systemctl --user restart -- \$UNIT"$/ },
  5: { what: /last_verified[\s\S]*attempted[\s\S]*observed/, command: /environments\/alpha/ },
  6: { what: /teardown[\s\S]*no unit, cgroup, socket or directory/i, command: /list-units[\s\S]*cgroup[\s\S]*\$SURETY_HOME\/run/ },
};

function fakes(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-m344-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'started.log');
  mkdirSync(bin);
  for (const name of ['node', 'curl', 'git', 'jq', 'systemctl', 'journalctl', 'claude', 'sha256sum', 'mktemp']) {
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

// A function's body: {start, end, text, lines}.
function body(name) {
  const all = lines();
  const start = all.findIndex((l) => new RegExp(`^${name}\\(\\) \\{`).test(l));
  assert.ok(start >= 0, `a ${name}() function`);
  const end = all.findIndex((l, i) => i > start && l === '}');
  return { start, end, lines: all.slice(start, end + 1), text: all.slice(start, end + 1).join('\n') };
}

// A line that only prints: echo, printf, note, die, or a string argument of check() on its own line.
const printsOnly = (l) => /^\s*(echo|printf|note|die|say) /.test(l) || /^\s*"[^"]*"\s*\\?$/.test(l) || /^\s*check \d+ "/.test(l);

describe('M344 the M4 hands-on script: its form and its guards (nothing is run)', () => {
  test('(a) the script parses (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n: ${res.stderr}`);
  });

  test("(b) each of M344's checks (1) to (6) is printed, each with what to look for and a command Sean can run himself", () => {
    const all = lines();
    const def = all.findIndex((l) => /^check\(\) \{/.test(l));
    assert.ok(def >= 0, 'a check() that prints a check');
    assert.ok(all.slice(def, def + 4).join('\n').includes('You can run it yourself'), 'and says how to run it');
    for (const [n, want] of Object.entries(CHECKS)) {
      const at = all.findIndex((l) => new RegExp(`^\\s*check ${n} "`).test(l));
      assert.ok(at >= 0, `CHECK (${n}) is printed`);
      const call = all.slice(at, at + 2).join('\n');
      assert.match(call, /"\s*\\\s*\n\s*"[^"]+"/, `CHECK (${n}) carries a command (${call})`);
      assert.match(all[at], want.what, `CHECK (${n}) says what M344 asks Sean to see (${all[at]})`);
      assert.match(all[at + 1].trim(), want.command, `CHECK (${n})'s command reads what it shows (${all[at + 1]})`);
    }
  });

  test('(c) it needs no model: no backend binary, no token, no paid step; scripted roles in the test mode with the real adapter; the runner qualified by its self-test and the adapter by qualify-adapter, never a fixture', () => {
    const src = code().map(({ l }) => l).join('\n');
    assert.ok(!/\bclaude\b/.test(src), 'no claude binary is named outside comments');
    assert.ok(!/SURETY_REAL_|setup-token|subscription_token|api_key|paid\(\)/.test(src), 'no credential, no real-lane switch, no paid step');
    assert.match(src, /serve --harness --harness-scripted "\$SCRIPTED" --harness-host-checks run --harness-runner-self-test run --harness-deploy-adapter real/, 'the engine runs scripted roles in its test mode, with the host checks, the runner self-test and the real adapter');
    assert.match(src, /"\$CLI" qualify-adapter local_service/, 'the adapter is qualified by the command in the script\'s own home');
    assert.ok(!/fixtures\/(adapter-qualification|runner-qualification|check-result|authorization)/.test(src), 'no qualification, check-result or authorization fixture');
    assert.match(src, /--secret-file "deploy\/ref_secret=\$SECRETS\/ref_secret"/, 'the service\'s one secret by reference, from a file of the script\'s own');
    assert.match(src, /randomBytes\(18\)[\s\S]*> "\$SECRETS\/ref_secret"/, 'a disposable random value the script makes');
  });

  test('(d) it refuses before starting anything: without a login session, and without a terminal, the no-pause switch included', (t) => {
    const f = fakes(t);
    const cases = [
      ['no login session', {}, /login session/],
      ['no terminal', { XDG_RUNTIME_DIR: f.runtime }, /terminal/],
      ['no terminal, with the pauses switched off (it skips the pauses, never the terminal)', { XDG_RUNTIME_DIR: f.runtime, SURETY_HANDS_ON_NO_PAUSE: '1' }, /terminal/],
    ];
    for (const [what, env, message] of cases) {
      const res = runScript(f, env);
      assert.notEqual(res.status, 0, `${what}: it refuses (${res.stderr})`);
      assert.match(res.stderr, message, `${what}: it says why (${res.stderr})`);
      assert.match(res.stderr, /Nothing was started/, `${what}: and that nothing was started`);
      assert.equal(res.started, '', `${what}: none of node, curl, git, jq, systemctl, journalctl, claude, sha256sum or mktemp was started (${res.started})`);
    }
  });

  test('(e) it never acts on a unit itself: an acting systemctl verb only on a line that prints, the restart printed by the exact name after the containment read; no systemd-run; the only signal to its own engine, after /proc names it', () => {
    const acting = /systemctl\s+--user\s+(stop|restart|start|kill|reset-failed|reload|daemon-reload|daemon-reexec|try-restart|reload-or-restart|try-reload-or-restart|isolate|enable|disable|mask|unmask|set-property|revert|edit|link|preset|exit|poweroff|reboot|halt|clean|freeze|thaw|import-environment|set-environment|unset-environment)\b/;
    const hits = code().filter(({ l }) => acting.test(l));
    assert.ok(hits.length >= 1, 'the restart is printed for Sean');
    for (const { l, i } of hits) assert.ok(printsOnly(l), `line ${i + 1} only prints an acting systemctl command, never runs it: ${l.trim()}`);
    for (const { l, i } of code()) assert.ok(!/\bsystemd-run\b/.test(l), `no systemd-run (line ${i + 1}: ${l.trim()})`);
    for (const { l, i } of code()) assert.ok(!/cgroup\.kill|cgroup\.procs"?\s*>|\b(sudo|loginctl|docker)\b/.test(l), `no cgroup write, sudo, loginctl or docker (line ${i + 1}: ${l.trim()})`);
    // The restart: printed by check 4 with the unit's exact name, after the containment read of step 6.
    const all = lines();
    const restart = all.findIndex((l) => /^\s*"systemctl --user restart -- \$UNIT"$/.test(l));
    assert.ok(restart > 0 && /^\s*check 4 "/.test(all[restart - 1]), 'the restart command is check 4\'s, printed');
    const step6 = all.findIndex((l) => /^say "6\./.test(l));
    const window = all.slice(step6, restart).join('\n');
    assert.match(window, /read_prefix/, 'the prefix is read before the restart is printed');
    assert.match(window, /intended_units \| grep -qxF -- "\$UNIT" \|\| die/, 'the unit is named in an attempt intent of the home\'s store, or nothing is printed');
    assert.match(window, /case \$APP_CG in "\$CG"\|"\$CG"\/\*\) ;; \*\) die/, 'the application is in the unit\'s cgroup, host-read, or nothing is printed');
    assert.match(window, /grep -qx "\$APP_PID" "\$APP_CG\/cgroup\.procs" \|\| die/, 'and listed in its cgroup.procs');
    assert.match(window, /for ns in pid net mnt;[\s\S]*readlink "\/proc\/\$APP_PID\/ns\/\$ns"[\s\S]*die/, 'and in none of the host\'s pid, network or mount namespaces');
    // Signals: `kill -0` (a probe, no signal) or TERM to its own engine, guarded by own_engine.
    const kills = code().filter(({ l }) => /\bkill\b/.test(l) && !/kill -0 "\$ENGINE_PID"/.test(l) && !printsOnly(l));
    assert.deepEqual(kills.map(({ l }) => l.trim()), ['if own_engine; then kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" 2>/dev/null; fi'], 'the only signal is TERM to its own engine, after own_engine');
    const own = body('own_engine');
    assert.match(own.text, /\/proc\/\$ENGINE_PID\/cmdline"[\s\S]*grep -qx serve/, 'own_engine reads the pid\'s command line: serve');
    assert.match(own.text, /\/proc\/\$ENGINE_PID\/environ"[\s\S]*SURETY_HOME=\$SURETY_HOME/, 'and its environment: this home');
  });

  test('(f) every step that makes the engine act on a unit (the qualification, the deployment request, the decision\'s answer, a teardown) is made by a function that reads the prefix first; read_prefix stops on a unit of the prefix the store names in no intent', () => {
    const actingCall = /\/deployments\b|\/teardown\b|\/answer\b|qualify-adapter local_service/;
    const fns = ['act_qualify', 'act_deploy', 'act_answer', 'act_teardown'].map((name) => ({ name, ...body(name) }));
    for (const fn of fns) {
      const read = fn.lines.findIndex((l) => /^\s*read_prefix$/.test(l));
      const act = fn.lines.findIndex((l) => actingCall.test(l));
      assert.ok(read > 0 && act > read, `${fn.name} reads the prefix before it asks the engine to act`);
    }
    for (const { l, i } of code()) {
      if (!actingCall.test(l) || printsOnly(l)) continue;
      assert.ok(fns.some((fn) => i > fn.start && i < fn.end), `line ${i + 1} asks the engine to act outside the act_* functions: ${l.trim()}`);
    }
    const rp = body('read_prefix');
    assert.match(rp.text, /is-system-running[\s\S]*die/, 'read_prefix requires the manager running');
    assert.match(rp.text, /grep -qxF -- "\$u" \|\| die "\$u carries this home's prefix but this home's store names it in no attempt intent/, 'and stops on a unit of the prefix no intent names');
    assert.match(text(), /PREFIX="surety-\$\(printf '%s' "\$SURETY_HOME" \| sha256sum \| cut -c1-12\)-"/, 'the prefix is derived from the script\'s own home as the engine derives it (D4 §9.3)');
  });

  test('(g) its temporary directory is removed at the end unless KEEP=1, and kept, each leftover printed by its exact name, while anything of its prefix is loaded; an existing directory is never reused', () => {
    const cl = body('cleanup');
    const rms = code().filter(({ l }) => /\brm\b/.test(l) && !printsOnly(l));
    assert.deepEqual(rms.map(({ l }) => l.trim()), ['rm -rf -- "$WORK" && echo "removed: $WORK (KEEP=1 keeps it)"'], 'the one removal is of the work directory');
    assert.ok(rms[0].i > cl.start && rms[0].i < cl.end, 'in cleanup()');
    assert.match(cl.text, /left=\$\(units_of_prefix\)\n\s*if \[ -n "\$left" \]; then[\s\S]*KEPT[\s\S]*systemctl --user stop -- \$i[\s\S]*elif \[ "\$\{KEEP:-0\}" = 1 \][\s\S]*else\n\s*rm -rf/, 'kept while anything of the prefix is loaded, each printed with the exact-name command for Sean; kept with KEEP=1; removed otherwise');
    assert.match(text(), /trap cleanup EXIT/, 'cleanup runs at every exit');
    assert.match(text(), /\[ ! -e "\$WORK" \] && \[ ! -L "\$WORK" \] \|\| die "\$WORK exists already/, 'a named directory that exists is refused');
    assert.match(text(), /mktemp -d "\$\{TMPDIR:-\/tmp\}\/surety-m4-hands-on-XXXXXX"/, 'by default a new temporary directory');
  });
});
