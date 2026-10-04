// Developer tests for the engine side of the real lane (D2 §§2.5, 4.2, 7.2,
// 7.3; M2 plan M136 to M139, M142) that need no backend: the static checks'
// own environment, the installation resolved to its real (versioned) path,
// the provider key held from the engine's environment and removed from it,
// the `surety qualify` command line, the canary prompt an agent reads, and
// the engine's fixture repository. No real backend binary runs here: the
// "binary" is a shell script these tests write.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { runStatic, helpHash } = await import(join(dist, 'invoke', 'static.js'));
const { resolveInstallation, ensureFixtureRepo, fixtureRepoPath } = await import(join(dist, 'trust', 'fixture.js'));
const { holdEnvironmentKeys, keyEnvironmentName, capEnvironmentName } = await import(join(dist, 'invoke', 'keys.js'));
const { heldSecret, heldProviderCaps, redactText } = await import(join(dist, 'records', 'redact.js'));
const { parseQualify, DEFAULT_EGRESS } = await import(join(dist, 'trust', 'qualify-command.js'));
const { canaryInstructions, canaryPromptText } = await import(join(dist, 'trust', 'canaries.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a static check runs in a home of its own, removed after, with the update and traffic switches set', async (t) => {
  const dir = scratch(t);
  const bin = join(dir, 'fake-backend');
  const out = join(dir, 'env.txt');
  writeFileSync(bin, `#!/bin/sh\nenv > ${out}\npwd >> ${out}\necho "usage: fake"\n`);
  chmodSync(bin, 0o755);
  const r = await runStatic(bin, 'claude', '--help');
  assert.equal(r.status, 0);
  const env = Object.fromEntries(
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.DISABLE_UPDATES, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.match(env.HOME, /surety-static-/);
  assert.notEqual(env.HOME, process.env.HOME, "never the operator's home");
  assert.ok(!existsSync(env.HOME), 'the home is removed after the check');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('SURETY_') || k === 'ANTHROPIC_API_KEY'));
  assert.equal(typeof (await helpHash(bin, 'claude')), 'string');
});

test('the installation resolves through its launcher link to the versioned file it names', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'versions'));
  mkdirSync(join(dir, 'bin'));
  const real = join(dir, 'versions', '2.1.288');
  writeFileSync(real, '#!/bin/sh\n');
  chmodSync(real, 0o755);
  symlinkSync(real, join(dir, 'bin', 'claude'));
  assert.equal(resolveInstallation('claude', `relative/dir:${join(dir, 'empty')}:${join(dir, 'bin')}`), real);
  assert.equal(resolveInstallation('codex', join(dir, 'bin')), null);
  assert.equal(resolveInstallation('../claude', join(dir, 'bin')), null);
});

test('the provider key is held from the environment and removed from it; its cap recorded as configured; nothing else', () => {
  const ref = 'backend/claude/api_key';
  assert.equal(keyEnvironmentName(ref), 'SURETY_SECRET_BACKEND_CLAUDE_API_KEY');
  assert.equal(capEnvironmentName(ref), 'SURETY_SECRET_BACKEND_CLAUDE_API_KEY_PROVIDER_CAP_USD');
  const key = 'sk-ant-api03-UNITTESTKEYVALUE00000000000000000000000000';
  const env = { PATH: '/usr/bin', SURETY_SECRET_BACKEND_CLAUDE_API_KEY: key, SURETY_SECRET_BACKEND_CLAUDE_API_KEY_PROVIDER_CAP_USD: '50', SURETY_SECRET_BACKEND_CODEX_API_KEY_PROVIDER_CAP_USD: 'x' };
  const r = holdEnvironmentKeys(env);
  assert.deepEqual(r.held, [ref]);
  assert.equal(r.problems.length, 1, 'a cap without its key is reported');
  assert.deepEqual(Object.keys(env), ['PATH'], 'every key variable removed from the environment');
  assert.equal(heldSecret(ref), key);
  assert.equal(heldProviderCaps()[ref], 50);
  assert.ok(!redactText(`the key ${key} leaked`).includes(key), 'and redacted from now on');
  const bad = holdEnvironmentKeys({ SURETY_SECRET_BACKEND_CLAUDE_API_KEY: key, SURETY_SECRET_BACKEND_CLAUDE_API_KEY_PROVIDER_CAP_USD: '-1' });
  assert.match(bad.problems[0], /not a positive number/);
});

test('surety qualify: the request it sends, and its refusals', () => {
  assert.deepEqual(parseQualify(['claude', '--mode', 'one_shot_headless', '--model', 'claude-sonnet-5-5']), {
    body: { backend: 'claude', mode: 'one_shot_headless', model: 'claude-sonnet-5-5', candidate_egress: DEFAULT_EGRESS.claude },
  });
  assert.deepEqual(DEFAULT_EGRESS.claude, ['api.anthropic.com']);
  assert.deepEqual(parseQualify(['claude', '--mode', 'one_shot_headless', '--model', 'm', '--egress', 'a.example', '--egress', 'b.example', '--deadline', 'positive=300']).body, {
    backend: 'claude',
    mode: 'one_shot_headless',
    model: 'm',
    candidate_egress: ['a.example', 'b.example'],
    canary_deadlines: { positive: 300 },
  });
  for (const bad of [[], ['--model', 'm'], ['claude', '--model', 'm'], ['claude', '--mode', 'one_shot_headless'], ['claude', '--mode'], ['claude', '--mode', 'x', '--model', 'm', '--prompt', 'p'], ['claude', '--mode', 'x', '--model', 'm', '--deadline', 'other=3']]) {
    assert.equal(typeof parseQualify(bad), 'string', JSON.stringify(bad));
  }
});

test("a real backend's canary prompt says what canary.json says; the containment canary carries the capability test", () => {
  const args = { attempt: 'qa_1', domain: 'dom_1', deadlineSeconds: 600, node: '/usr/bin/node', tokenPath: '/home/x/.surety/api.token', apiPort: 7777 };
  const positive = canaryInstructions({ ...args, kind: 'positive', backend: 'claude' });
  const p = canaryPromptText(positive).join('\n');
  assert.ok(p.includes(positive.edit.path) && p.includes(JSON.stringify(positive.edit.content)) && p.includes(JSON.stringify(positive.result)));
  const cancel = canaryInstructions({ ...args, kind: 'cancellation', backend: 'claude' });
  const c = canaryPromptText(cancel).join('\n');
  assert.ok(c.includes('touch /surety/out/canary-barrier') && c.includes(`sleep ${cancel.wait_seconds}`));
  assert.ok(cancel.wait_seconds > 600, 'the wait outlasts the deadline');
  const contain = canaryInstructions({ ...args, kind: 'containment', backend: 'claude' });
  assert.deepEqual(contain.capability_test.tools, ['Agent', 'Task', 'Workflow', 'SendMessage', 'ScheduleWakeup', 'CronCreate', 'RemoteTrigger', 'Monitor']);
  const k = canaryPromptText(contain).join('\n');
  for (const a of contain.actions) {
    // Each command, as the shell will split it, is the action's argv exactly.
    const line = k.split('\n').find((l) => l.includes(`--canary ${a.name} `));
    assert.ok(line, a.name);
    const words = JSON.parse(execFileSync('/bin/sh', ['-c', `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${line.replace(/^\s*- /, '')}`]).toString());
    assert.deepEqual(words, a.argv);
  }
  assert.ok(k.includes('Agent, Task, Workflow'));
  assert.equal(canaryInstructions({ ...args, kind: 'containment', backend: 'scripted' }).capability_test, undefined, 'the scripted canary is unchanged');
});

test("the engine's fixture repository: one commit on main, HEAD detached, made once", async (t) => {
  const home = scratch(t);
  configureGit({ deadlineSeconds: 10, outputCap: 1 << 20, home, incarnation: 'inc_unit' });
  const repo = await ensureFixtureRepo(home);
  assert.equal(repo, fixtureRepoPath(home));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a]).toString().trim();
  assert.equal(git('rev-list', '--count', 'main'), '1');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
  const head = git('rev-parse', 'main');
  await ensureFixtureRepo(home);
  assert.equal(git('rev-parse', 'main'), head, 'left as it was');
});
