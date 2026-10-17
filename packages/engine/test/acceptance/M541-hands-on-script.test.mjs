// M541, the hands-on run Sean makes (M6 slice 46, manifest slice 46; no
// engine, no model, nothing paid). M6 plan §3.8 M541; BS6 §13; E156 Q7
// (short: seeing the preview, understanding a refusal, approving the design,
// replacing a held asset, observing teardown); BS6 §4.1 rules 21 to 24;
// SEAM.md §544. M5's form: M446.
//
// The row itself is Sean's: he runs `docs/acceptance/reports/M6-hands-on.sh`
// and sees (a) to (e) for himself. What a test can hold without running it
// (it starts the engine, a qualification and previews on units) is the
// script's form and its guards:
//   (a) it parses;
//   (b) it prints the five checks (a) to (e), in that order, each with what
//       to look for and a command he can run;
//   (c) it needs no model: the scripted roles in the engine's test mode, the
//       Designer the package-driven fake; no backend binary, no token, no
//       paid step; the runner by its self-test and the adapter by
//       `qualify-adapter`; the refusal made by omitting `designer.conventions`
//       and the set cleared after; the logo replaced by a file the script
//       writes (no real image), the batch answered with `assets_held`;
//   (d) it refuses before starting anything without a login session or a
//       terminal, with fakes that record any start;
//   (e) it never acts on a unit itself, launches no browser, and signals only
//       its own engine;
//   (f) every step that makes the engine act on a unit reads the prefix first;
//       the relay is opened in its own home on 127.0.0.1 and closed by it;
//   (g) its temporary directory is removed unless KEEP=1 and kept while
//       anything of its prefix is loaded; its home is at most 56 bytes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const SCRIPT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M6-hands-on.sh');
const text = () => readFileSync(SCRIPT, 'utf8');
const lines = () => text().split('\n');
// The script's code: no comment line.
const code = () => lines().map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*#/.test(l));

// M541's five steps, by what each check says and what its command reads.
const CHECKS = [
  ['a', /index lists the web mockup \(native\)[\s\S]*android mockup \(simulated\)[\s\S]*labelled simulation frame/i, /curl -sS \$URL[\s\S]*data-capability/],
  ['b', /refused: DESIGN_CONVENTION_UNDECLARED[\s\S]*target[\s\S]*engine's entry/i, /session show \$DES[\s\S]*speaker == \\"engine\\"/],
  ['c', /logo held[\s\S]*effective set is the engine's placeholder/i, /\/design /],
  ['d', /asset-only approval[\s\S]*asset_updated fix/i, /\/design\/bindings/],
  ['e', /torn down[\s\S]*no unit of this home's prefix/i, /list-units[\s\S]*cgroup/],
];

function fakes(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-m541-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'started.log');
  mkdirSync(bin);
  for (const name of ['node', 'curl', 'git', 'jq', 'systemctl', 'journalctl', 'claude', 'sha256sum', 'mktemp', 'xdg-open', 'firefox', 'chromium', 'google-chrome', 'wslview']) {
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

// A line that only prints: echo, printf, note, die, say, or a string argument of check() on its own line.
const printsOnly = (l) => /^\s*(echo|printf|note|die|say) /.test(l) || /^\s*"[^"]*"\s*\\?$/.test(l) || /^\s*check [a-e] "/.test(l);

describe('M541 the M6 hands-on script: its form and its guards (nothing is run)', () => {
  test('(a) the script parses (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n: ${res.stderr}`);
  });

  test("(b) the five checks (a) to (e) are printed in M541's order, each with what to look for and a command Sean can run himself", () => {
    const all = lines();
    const def = all.findIndex((l) => /^check\(\) \{/.test(l));
    assert.ok(def >= 0, 'a check() that prints a check');
    assert.ok(all.slice(def, def + 4).join('\n').includes('You can run it yourself'), 'and says how to run it');
    let last = -1;
    for (const [letter, what, command] of CHECKS) {
      const at = all.findIndex((l) => new RegExp(`^\\s*check ${letter} "`).test(l));
      assert.ok(at >= 0, `CHECK (${letter}) is printed`);
      assert.ok(at > last, `CHECK (${letter}) comes after the one before it`);
      last = at;
      const call = all.slice(at, at + 2).join('\n');
      assert.match(call, /"\s*\\\s*\n\s*"[^"]+"/, `CHECK (${letter}) carries a command (${call})`);
      assert.match(all[at], what, `CHECK (${letter}) says what M541 asks Sean to see (${all[at]})`);
      assert.match(all[at + 1].trim(), command, `CHECK (${letter})'s command reads what it shows (${all[at + 1]})`);
    }
    assert.equal(all.filter((l) => /^\s*check [a-z] "/.test(l)).length, 5, 'five checks, no more (E156 Q7: short)');
  });

  test('(c) it needs no model: scripted roles in the test mode, the Designer the package-driven fake; no backend binary, no token, no paid step; the runner by its self-test, the adapter by qualify-adapter; the refusal by an omitted element; the held logo and the owner\'s generated file', () => {
    const src = code().map(({ l }) => l).join('\n');
    assert.ok(!/\bclaude\b/.test(src), 'no claude binary is named outside comments');
    assert.ok(!/SURETY_REAL_|setup-token|subscription_token|api_key|paid\(\)/.test(src), 'no credential, no real-lane switch, no paid step');
    assert.match(src, /serve --harness --harness-scripted "\$SCRIPTED" --harness-host-checks run --harness-runner-self-test run --harness-deploy-adapter real/, 'scripted roles in the test mode, with the host checks, the runner self-test and the real adapter');
    assert.match(src, /s\.packageFakes\(designerContent\(/, 'the package-driven fakes beside the role program, with the Designer\'s content');
    assert.match(src, /put\(`run-\$\{rest\[0\]\}`, \[FAKE, FAKE, FAKE/, 'the Designer\'s turns play the package-driven fake');
    assert.match(src, /const FAKE = \{ steps: \[\{ package_fake: \{\} \}\] \}/, 'the fake step');
    assert.match(src, /omit '\["designer\.conventions"\]'[\s\S]*omit '\[\]'/, 'the refusal by an omitted element, cleared after');
    assert.match(src, /"\$CLI" qualify-adapter local_service/, 'the adapter is qualified by the command in the script\'s own home');
    assert.ok(!/fixtures\/(adapter-qualification|runner-qualification|check-result|authorization|plan|trust-entry|design|effective)/.test(src), 'no fixture of a qualification, a check result, an authorization, a plan, an entry, a design or an effective set');
    assert.match(src, /act_answer "\$P" "\$APPROVAL" approve '\{"assets_held": \["logo"\]\}'/, 'the batch\'s design_approval answered with the logo held');
    assert.match(src, /surety design asset add --project "\$P" logo full "\$LOGO"[\s\S]*surety design assets submit --project "\$P"/, 'his own file by asset add, then the asset-only approval by assets submit');
    assert.match(src, /LOGO=\$WORK\/my-logo\.svg\nprintf '%s\\n' '<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^']*' > "\$LOGO"/, 'the owner\'s file a generated SVG text (rule 22: no real image)');
    assert.ok(!/<script|onload=|href=/.test(/printf '%s\\n' '(<svg[^']*)'/.exec(src)?.[1] ?? '<script'), 'with no script, event attribute or external reference');
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
      assert.equal(res.started, '', `${what}: nothing was started (${res.started})`);
    }
  });

  test('(e) it never acts on a unit itself, launches no browser, and signals only its own engine, after /proc names it', () => {
    const acting = /systemctl\s+--user\s+(stop|restart|start|kill|reset-failed|reload|daemon-reload|daemon-reexec|try-restart|reload-or-restart|try-reload-or-restart|isolate|enable|disable|mask|unmask|set-property|revert|edit|link|preset|exit|poweroff|reboot|halt|clean|freeze|thaw|import-environment|set-environment|unset-environment)\b/;
    for (const { l, i } of code().filter(({ l }) => acting.test(l))) assert.ok(printsOnly(l), `line ${i + 1} only prints an acting systemctl command, never runs it: ${l.trim()}`);
    for (const { l, i } of code()) assert.ok(!/\bsystemd-run\b/.test(l), `no systemd-run (line ${i + 1}: ${l.trim()})`);
    for (const { l, i } of code()) assert.ok(!/cgroup\.kill|cgroup\.procs"?\s*>|\b(sudo|loginctl|docker)\b/.test(l), `no cgroup write, sudo, loginctl or docker (line ${i + 1}: ${l.trim()})`);
    // BS6 §4.1 rule 22: no browser, emulator or device started; the URL is printed for Sean.
    for (const { l, i } of code()) assert.ok(!/\b(xdg-open|sensible-browser|x-www-browser|firefox|chromium|chrome|google-chrome|wslview|explorer\.exe|cmd\.exe|open -a|playwright|puppeteer|emulator|adb|simctl)\b/.test(l), `no browser, emulator or device is started (line ${i + 1}: ${l.trim()})`);
    const kills = code().filter(({ l }) => /\bkill\b/.test(l) && !/kill -0 "\$ENGINE_PID"/.test(l) && !printsOnly(l));
    assert.deepEqual(kills.map(({ l }) => l.trim()), ['if own_engine; then kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" 2>/dev/null; fi'], 'the only signal is TERM to its own engine, after own_engine');
    const own = body('own_engine');
    assert.match(own.text, /\/proc\/\$ENGINE_PID\/cmdline"[\s\S]*grep -qx serve/, 'own_engine reads the pid\'s command line: serve');
    assert.match(own.text, /\/proc\/\$ENGINE_PID\/environ"[\s\S]*SURETY_HOME=\$SURETY_HOME/, 'and its environment: this home');
  });

  test('(f) every step that makes the engine act on a unit (the qualification, a preview, its stop, a decision\'s answer) is made by a function that reads the prefix first; the relay is opened in its own home on 127.0.0.1 and closed', () => {
    const actingCall = /\/answer\b|qualify-adapter local_service|design preview\b/;
    const fns = ['act_qualify', 'act_preview', 'act_preview_stop', 'act_answer'].map((name) => ({ name, ...body(name) }));
    for (const fn of fns) {
      const read = fn.lines.findIndex((l) => /^\s*read_prefix$/.test(l));
      const act = fn.lines.findIndex((l) => actingCall.test(l));
      assert.ok(read > 0 && act > read, `${fn.name} reads the prefix before it asks the engine to act`);
    }
    assert.match(body('act_preview_stop').text, /design preview --project "\$1" --stop/, 'the preview stopped by the engine\'s own command');
    for (const { l, i } of code()) {
      if (!actingCall.test(l) || printsOnly(l)) continue;
      assert.ok(fns.some((fn) => i > fn.start && i < fn.end), `line ${i + 1} asks the engine to act outside the act_* functions: ${l.trim()}`);
    }
    const rp = body('read_prefix');
    assert.match(rp.text, /is-system-running[\s\S]*die/, 'read_prefix requires the manager running');
    assert.match(rp.text, /grep -qxF -- "\$u" \|\| die "\$u carries this home's prefix but this home's store names it in no attempt intent/, 'and stops on a unit of the prefix no intent names');
    assert.match(text(), /PREFIX="surety-\$\(printf '%s' "\$SURETY_HOME" \| sha256sum \| cut -c1-12\)-"/, 'the prefix is derived from the script\'s own home as the engine derives it (D4 §9.3)');
    // Rule 24: the relay by the command in this home, closed by the step that opened it.
    const src = code().map(({ l }) => l).join('\n');
    const opened = code().filter(({ l }) => /surety env open design-preview --project "\$P"/.test(l));
    const closed = code().filter(({ l }) => /surety env close design-preview --project "\$P"/.test(l) && !/RELAY_OPEN/.test(l));
    assert.equal(opened.length, 1, 'the relay is opened once, by surety env open in this home');
    assert.ok(closed.length === 1 && closed[0].i > opened[0].i, 'and closed by surety env close before the next step');
    assert.match(src, /if \[ -n "\$RELAY_OPEN" \] && own_engine; then surety env close design-preview/, 'and at any exit while open');
    assert.match(text(), /127\.0\.0\.1 only/, 'the relay is said to be on 127.0.0.1 only');
    assert.match(src, /env -i SURETY_HOME="\$SURETY_HOME"/, 'every command in the script\'s own home');
  });

  test('(g) its temporary directory is removed at the end unless KEEP=1, and kept, each leftover printed by its exact name, while anything of its prefix is loaded; an existing directory is never reused; its home at most 56 bytes', () => {
    const cl = body('cleanup');
    const rms = code().filter(({ l }) => /\brm\b/.test(l) && !printsOnly(l));
    assert.deepEqual(rms.map(({ l }) => l.trim()), ['rm -rf -- "$WORK" && echo "removed: $WORK (KEEP=1 keeps it)"'], 'the one removal is of the work directory');
    assert.ok(rms[0].i > cl.start && rms[0].i < cl.end, 'in cleanup()');
    assert.match(cl.text, /left=\$\(units_of_prefix\)\n\s*if \[ -n "\$left" \]; then[\s\S]*KEPT[\s\S]*systemctl --user stop -- \$i[\s\S]*elif \[ "\$\{KEEP:-0\}" = 1 \][\s\S]*else\n\s*rm -rf/, 'kept while anything of the prefix is loaded, each printed with the exact-name command for Sean; kept with KEEP=1; removed otherwise');
    assert.match(text(), /trap cleanup EXIT/, 'cleanup runs at every exit');
    assert.match(text(), /\[ ! -e "\$WORK" \] && \[ ! -L "\$WORK" \] \|\| die "\$WORK exists already/, 'a named directory that exists is refused');
    assert.match(text(), /mktemp -d "\$\{TMPDIR:-\/tmp\}\/surety-m6-ho-XXXXXX"/, 'by default a new temporary directory');
    assert.match(text(), /\[ "\$\(printf '%s' "\$SURETY_HOME" \| wc -c\)" -le 56 \] \|\| die/, 'its engine home at most 56 bytes (E134)');
  });
});
