// Developer tests for M5 slice 33's pure parts (D6 §2; E139 Q6): the model
// a role's alias names and what a real launch passes, the canaries an
// attempt runs by its mode, the continuation canary's instructions, and the
// artifact state a turn's package carries.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { sameModel, familyOf, isModelName } = await import(join(dist, 'invoke', 'adapters', 'model.js'));
const { canaryKindsOf, canaryInstructions, continuationToken, CONTINUATION_PATTERN } = await import(join(dist, 'trust', 'canaries.js'));
const { artifactState } = await import(join(dist, 'sessions', 'turn-package.js'));

test("an alias names only the family token of a Claude model id; a full name only itself (the review's M1)", () => {
  assert.equal(sameModel('sonnet', 'claude-sonnet-5-5'), true);
  assert.equal(sameModel('opus', 'claude-sonnet-5-5'), false);
  assert.equal(sameModel('claude', 'claude-sonnet-5-5'), false, "'claude' is not a family");
  assert.equal(sameModel('five', 'claude-sonnet-5-5'), false);
  assert.equal(sameModel('sonnet', 'sonnet-claude-5'), false, 'the family is the token after claude-');
  assert.equal(sameModel('claude-sonnet-5-5', 'claude-sonnet-5-5'), true);
  assert.equal(sameModel('claude-sonnet-5', 'claude-sonnet-5-5'), false);
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('standin-model'), null);
});

test('a model name is never an option', () => {
  assert.equal(isModelName('opus'), true);
  assert.equal(isModelName('--resume'), false);
  assert.equal(isModelName(''), false);
  assert.equal(isModelName('a b'), false);
});

test('the canaries by mode: three; three and the continuation; the continuation alone for an entry', () => {
  assert.deepEqual(canaryKindsOf({ mode: 'one_shot_headless' }), ['positive', 'cancellation', 'containment']);
  assert.deepEqual(canaryKindsOf({ mode: 'session_headless', session_entry: null }), ['positive', 'cancellation', 'containment', 'continuation']);
  assert.deepEqual(canaryKindsOf({ mode: 'session_headless', session_entry: 'te_1' }), ['continuation']);
});

test("the continuation canary: turn 1 writes the token into the artifact; turn 2 is told only the pattern", () => {
  const one = canaryInstructions({ attempt: 'qa_1', kind: 'continuation', deadlineSeconds: 60, turn: 1 });
  const two = canaryInstructions({ attempt: 'qa_1', kind: 'continuation', deadlineSeconds: 60, turn: 2 });
  const token = continuationToken('qa_1');
  assert.match(token, new RegExp(`^${CONTINUATION_PATTERN}$`));
  assert.ok(one.edit.content.includes(token));
  assert.equal(one.result.artifact_changed, true);
  assert.ok(!JSON.stringify(two).includes(token), 'turn 2 is never told the token');
  assert.notEqual(continuationToken('qa_2'), token);
});

test("the artifact state: the files under the role's paths, never through a link, nothing else", (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'surety-unit-ws-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, '.surety', 'spec'), { recursive: true });
  writeFileSync(join(ws, '.surety', 'spec', 'spec.md'), '# Spec\n');
  writeFileSync(join(ws, '.surety', 'idea.md'), '# Idea\n');
  writeFileSync(join(ws, 'outside.md'), 'not the artifact\n');
  symlinkSync(join(ws, 'outside.md'), join(ws, '.surety', 'spec', 'link.md'));
  const s = artifactState(ws, ['.surety/spec/']);
  assert.deepEqual(s.files.map((f) => f.path), ['.surety/spec/spec.md']);
  assert.equal(s.unknown, null);
  assert.equal(artifactState(null, ['.surety/idea.md']).unknown !== null, true, 'no workspace: unknown, never empty');
  assert.equal(artifactState(ws, ['.surety/absent/']).unknown, null, 'a permitted path not written is absent, not unknown');
});
