// M446, the hands-on run Sean makes (M5 slice 38, manifest slice 38; no
// engine, no model, nothing paid). M5 plan §3.8 M446; BS5 §13, §16 question
// 5 (decided E141 item 4); E45, E109, E138 (the form); SEAM.md §457. M4's
// form: M344.
//
// The row itself is Sean's: he runs `docs/acceptance/reports/M5-hands-on.sh`
// and sees (1) to (6) for himself. What a test can hold without running it
// is the script's form and its guards:
//   (a) it parses;
//   (b) it prints each check M446 lists with a command he can run: the named
//       defect and the blocked approve; a session's two turns, their ledger
//       rows, the transcript and the checkpoint commit; a plan refused for a
//       named reason then registered with its stages and depends_on; the
//       dispatch under phase with no decision; the pace read's unknowns; the
//       optional Alpha and its teardown;
//   (c) it needs no model: every role the package-driven fake on the
//       scripted backend; no backend binary, no token, no paid step; the
//       runner qualified by its self-test and the adapter by
//       `qualify-adapter`, never a fixture; the defect and the refusal made
//       by omitting a package element (SEAM.md §453);
//   (d) it refuses before starting anything without a login session or a
//       terminal, with fakes that record any start;
//   (e) it never acts on a unit itself, and signals only its own engine;
//   (f) every step that makes the engine act on a unit reads the prefix first;
//   (g) its temporary directory is removed unless KEEP=1 and kept while
//       anything of its prefix is loaded; its home is at most 56 bytes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const SCRIPT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M5-hands-on.sh');
const text = () => readFileSync(SCRIPT, 'utf8');
const lines = () => text().split('\n');
// The script's code: no comment line.
const code = () => lines().map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*#/.test(l));

// M446's checks, by what each says and what its command reads.
const CHECKS = {
  1: { what: /defect[\s\S]*approve option is blocked/i, command: /session show[\s\S]*spec_approval[\s\S]*options/ },
  2: { what: /two turns[\s\S]*ledger row[\s\S]*transcript[\s\S]*checkpoint commit/i, command: /session show[\s\S]*git -C \$PROJ_REPO show/ },
  3: { what: /refused[\s\S]*plan_refused[\s\S]*registered[\s\S]*depending on/i, command: /\/plan[\s\S]*depends_on/ },
  4: { what: /no decision was raised/i, command: /decisions[\s\S]*open/ },
  5: { what: /pace read[\s\S]*unknown/i, command: /pace --project \$P --json/ },
  6: { what: /alpha_deployed[\s\S]*teardown applied[\s\S]*no unit, cgroup or runtime file/i, command: /list-units[\s\S]*cgroup[\s\S]*\$SURETY_HOME\/run/ },
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

describe('M446 the M5 hands-on script: its form and its guards (nothing is run)', () => {
  test('(a) the script parses (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n: ${res.stderr}`);
  });

  test("(b) each of M446's checks (1) to (6) is printed, each with what to look for and a command Sean can run himself", () => {
    const all = lines();
    const def = all.findIndex((l) => /^check\(\) \{/.test(l));
    assert.ok(def >= 0, 'a check() that prints a check');
    assert.ok(all.slice(def, def + 4).join('\n').includes('You can run it yourself'), 'and says how to run it');
    for (const [n, want] of Object.entries(CHECKS)) {
      const at = all.findIndex((l) => new RegExp(`^\\s*check ${n} "`).test(l));
      assert.ok(at >= 0, `CHECK (${n}) is printed`);
      const call = all.slice(at, at + 2).join('\n');
      assert.match(call, /"\s*\\\s*\n\s*"[^"]+"/, `CHECK (${n}) carries a command (${call})`);
      assert.match(all[at], want.what, `CHECK (${n}) says what M446 asks Sean to see (${all[at]})`);
      assert.match(all[at + 1].trim(), want.command, `CHECK (${n})'s command reads what it shows (${all[at + 1]})`);
    }
  });

  test('(c) it needs no model: every role the package-driven fake on the scripted backend; no backend binary, no token, no paid step; the runner by its self-test, the adapter by qualify-adapter; the defect and the refusal made by omitting a package element', () => {
    const src = code().map(({ l }) => l).join('\n');
    assert.ok(!/\bclaude\b/.test(src), 'no claude binary is named outside comments');
    assert.ok(!/SURETY_REAL_|setup-token|subscription_token|api_key|paid\(\)/.test(src), 'no credential, no real-lane switch, no paid step');
    assert.match(src, /serve --harness --harness-scripted "\$SCRIPTED" --harness-host-checks run --harness-runner-self-test run --harness-deploy-adapter real/, 'scripted roles in the test mode, with the host checks, the runner self-test and the real adapter');
    assert.match(src, /cp "\$CHILD_SOURCE" "\$FAKES_SOURCE" "\$SCRIPTED\/"/, 'the package-driven fakes beside the role program');
    assert.match(src, /FAKE='\{"steps": \[\{"package_fake": \{\}\}\]\}'/, 'every role plays the package-driven fake');
    assert.match(src, /omit '\["spec_writer\.marks"\]'[\s\S]*omit '\[\]'[\s\S]*omit '\["architect\.plan_reasons"\]'[\s\S]*omit '\[\]'/, 'the defect and the refusal by an omitted element, cleared after each');
    assert.match(src, /"\$CLI" qualify-adapter local_service/, 'the adapter is qualified by the command in the script\'s own home');
    assert.ok(!/fixtures\/(adapter-qualification|runner-qualification|check-result|authorization|plan|trust-entry)/.test(src), 'no fixture of a qualification, a check result, an authorization, a plan or an entry');
    assert.match(src, /--secret-file "deploy\/ref_secret=\$SECRETS\/ref_secret"/, 'the service\'s one secret by reference, from a file of the script\'s own');
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

  test('(e) it never acts on a unit itself: an acting systemctl verb only on a line that prints; no systemd-run; the only signal to its own engine, after /proc names it', () => {
    const acting = /systemctl\s+--user\s+(stop|restart|start|kill|reset-failed|reload|daemon-reload|daemon-reexec|try-restart|reload-or-restart|try-reload-or-restart|isolate|enable|disable|mask|unmask|set-property|revert|edit|link|preset|exit|poweroff|reboot|halt|clean|freeze|thaw|import-environment|set-environment|unset-environment)\b/;
    for (const { l, i } of code().filter(({ l }) => acting.test(l))) assert.ok(printsOnly(l), `line ${i + 1} only prints an acting systemctl command, never runs it: ${l.trim()}`);
    for (const { l, i } of code()) assert.ok(!/\bsystemd-run\b/.test(l), `no systemd-run (line ${i + 1}: ${l.trim()})`);
    for (const { l, i } of code()) assert.ok(!/cgroup\.kill|cgroup\.procs"?\s*>|\b(sudo|loginctl|docker)\b/.test(l), `no cgroup write, sudo, loginctl or docker (line ${i + 1}: ${l.trim()})`);
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

  test('(g) its temporary directory is removed at the end unless KEEP=1, and kept, each leftover printed by its exact name, while anything of its prefix is loaded; an existing directory is never reused; its home at most 56 bytes', () => {
    const cl = body('cleanup');
    const rms = code().filter(({ l }) => /\brm\b/.test(l) && !printsOnly(l));
    assert.deepEqual(rms.map(({ l }) => l.trim()), ['rm -rf -- "$WORK" && echo "removed: $WORK (KEEP=1 keeps it)"'], 'the one removal is of the work directory');
    assert.ok(rms[0].i > cl.start && rms[0].i < cl.end, 'in cleanup()');
    assert.match(cl.text, /left=\$\(units_of_prefix\)\n\s*if \[ -n "\$left" \]; then[\s\S]*KEPT[\s\S]*systemctl --user stop -- \$i[\s\S]*elif \[ "\$\{KEEP:-0\}" = 1 \][\s\S]*else\n\s*rm -rf/, 'kept while anything of the prefix is loaded, each printed with the exact-name command for Sean; kept with KEEP=1; removed otherwise');
    assert.match(text(), /trap cleanup EXIT/, 'cleanup runs at every exit');
    assert.match(text(), /\[ ! -e "\$WORK" \] && \[ ! -L "\$WORK" \] \|\| die "\$WORK exists already/, 'a named directory that exists is refused');
    assert.match(text(), /mktemp -d "\$\{TMPDIR:-\/tmp\}\/surety-m5-ho-XXXXXX"/, 'by default a new temporary directory');
    assert.match(text(), /\[ "\$\(printf '%s' "\$SURETY_HOME" \| wc -c\)" -le 56 \] \|\| die/, 'its engine home at most 56 bytes (E134)');
  });
});
