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
const { holdSecretFiles, readSecretFile, parseRefValue, SecretFileRefused } = await import(join(dist, 'invoke', 'keys.js'));
const { normalizeFor, attemptSpendEstimate, CLAUDE_PRICE_TABLE } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
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

test('--secret-file: the key held from a mode-600 file of the user, outside the engine home; its cap recorded as configured; every unusable file refused', (t) => {
  const dir = scratch(t);
  const home = join(dir, 'home');
  mkdirSync(home);
  const ref = 'backend/claude/api_key';
  const key = 'sk-ant-api03-UNITTESTKEYVALUE00000000000000000000000000';
  const file = join(dir, 'key');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  assert.deepEqual(parseRefValue('--secret-file', `${ref}=${file}`), { ref, value: file });
  assert.equal(typeof parseRefValue('--secret-file', `backend/other/api_key=${file}`), 'string');
  assert.equal(typeof parseRefValue('--secret-file', ref), 'string');
  assert.deepEqual(holdSecretFiles([{ ref, path: file }], [{ ref, usd: 50 }], home), [ref]);
  assert.equal(heldSecret(ref), key, 'without its line end');
  assert.equal(heldProviderCaps()[ref], 50);
  assert.ok(!redactText(`the key ${key} leaked`).includes(key), 'and redacted from now on');
  const refused = (path, why) => {
    assert.throws(() => readSecretFile(ref, path, home), (e) => e instanceof SecretFileRefused && why.test(e.why), String(why));
  };
  refused('relative/key', /not absolute/);
  refused(join(dir, 'absent'), /cannot be examined/);
  const link = join(dir, 'link');
  symlinkSync(file, link);
  refused(link, /symbolic link/);
  refused(dir, /not a regular file/);
  const open = join(dir, 'open');
  writeFileSync(open, key, { mode: 0o640 });
  chmodSync(open, 0o640);
  refused(open, /group or others/);
  const empty = join(dir, 'empty');
  writeFileSync(empty, '\n', { mode: 0o600 });
  refused(empty, /empty/);
  const two = join(dir, 'two');
  writeFileSync(two, `${key}\nsecond\n`, { mode: 0o600 });
  refused(two, /more than one line/);
  const inside = join(home, 'key');
  writeFileSync(inside, key, { mode: 0o600 });
  refused(inside, /under the engine home/);
  assert.equal(readSecretFile(ref, (() => { const f = join(dir, 'ro'); writeFileSync(f, key, { mode: 0o400 }); return f; })(), home), key, 'mode 400 is accepted');
});

test("Claude's price table and the attempt's estimate: labelled, under the run limit, null without a price", () => {
  assert.deepEqual(CLAUDE_PRICE_TABLE.models['claude-sonnet-5-5'], { billable_in: 2, cached_in: 0.2, out: 10 });
  assert.deepEqual(attemptSpendEstimate('claude', 'claude-sonnet-5-5', 300_000), { usd: 9, price_version: CLAUDE_PRICE_TABLE.version });
  assert.equal(attemptSpendEstimate('claude', 'some-other-model', 300_000), null);
  assert.equal(attemptSpendEstimate('scripted', 'claude-sonnet-5-5', 300_000), null);
  const n = normalizeFor('claude', { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 500, model: 'claude-sonnet-5-5', usage_final: true });
  assert.equal(n.cost_status, 'estimated', 'no reported cost: estimated from the table');
  assert.equal(n.cost_usd, (1000 * 2 + 10_000 * 0.2 + 500 * 10) / 1e6);
  assert.match(n.normalization_version, /anthropic-list-2026-09-25/);
  assert.equal(normalizeFor('claude', { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-sonnet-5-5' }).cost_status, 'unknown', 'an unknown amount: unknown, never estimated from a part');
});

test('surety qualify: the request it sends, and its refusals', () => {
  assert.deepEqual(parseQualify(['claude', '--mode', 'one_shot_headless', '--model', 'claude-sonnet-5-5']), {
    body: { backend: 'claude', mode: 'one_shot_headless', model: 'claude-sonnet-5-5', candidate_egress: DEFAULT_EGRESS.claude },
  });
  assert.deepEqual(DEFAULT_EGRESS.claude, ['api.anthropic.com']);
  assert.deepEqual(parseQualify(['claude', '--mode', 'one_shot_headless', '--model', 'm', '--egress', 'a.example', '--egress', 'b.example', '--canary-deadline', 'positive=300']).body, {
    backend: 'claude',
    mode: 'one_shot_headless',
    model: 'm',
    candidate_egress: ['a.example', 'b.example'],
    canary_deadlines: { positive: 300 },
  });
  for (const bad of [[], ['--model', 'm'], ['claude', '--model', 'm'], ['claude', '--mode', 'one_shot_headless'], ['claude', '--mode'], ['claude', '--mode', 'x', '--model', 'm', '--prompt', 'p'], ['claude', '--mode', 'x', '--model', 'm', '--canary-deadline', 'other=3'], ['claude', '--mode', 'x', '--model', 'm', '--deadline', 'positive=3']]) {
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
