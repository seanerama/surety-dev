// Developer test for the driver's ruling on the real M443 run's phase 2: a
// human-test requirement (TPL §4, no criteria) imposes no criterion and no
// kind on any scope; a stage implementing only human tests is held to the
// tier's revision-wide kinds; it is never a gap the sweep asks for; and it
// stays owed in the pace read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { computeScope } = await import(join(dist, 'checks', 'scope.js'));

const chk = (id, kind, requirements = [], criteria = []) => ({ id, key: id, kind, origin: 'acceptance', required: true, gate_kinds: ['stage'], tier_floor: null, criteria, requirements, sensitive_areas: [] });
const R = {
  R6: { id: 'R6', key: 'R6', criteria: [], sensitive_areas: [], human_test: true },
  R7: { id: 'R7', key: 'R7', criteria: null, sensitive_areas: [], human_test: true },
  R8: { id: 'R8', key: 'R8', criteria: ['R8.1'], sensitive_areas: [] },
};
const scope = (implementsKeys, checks) =>
  computeScope({ kind: 'stage', projectTier: 'T2', checks, requirements: Object.values(R), delivered: implementsKeys, partial: [], stageImplements: implementsKeys, modules: [] });

test('a stage implementing only human tests: no criterion, no uncertainty, only the revision-wide kinds', () => {
  const none = scope(['R6', 'R7'], []);
  assert.deepEqual(none.missing.uncertain, [], 'R6 and R7 are not uncertain');
  assert.deepEqual(none.missing.criteria, []);
  assert.deepEqual(none.missing.kinds.sort(), ['kind:security_lint', 'kind:smoke'], 'acceptance and integration are not asked of it');
  const met = scope(['R6', 'R7'], [chk('smoke', 'smoke'), chk('lint', 'security_lint')]);
  assert.deepEqual([met.missing.uncertain, met.missing.criteria, met.missing.kinds], [[], [], []], 'complete on the revision-wide checks');
});

test('a stage with a human test and a requirement with criteria: the criteria and the full inventory, the human test still owing nothing', () => {
  const s = scope(['R6', 'R8'], [chk('smoke', 'smoke'), chk('lint', 'security_lint')]);
  assert.deepEqual(s.missing.uncertain, []);
  assert.deepEqual(s.missing.criteria, ['R8.1']);
  assert.deepEqual(s.missing.kinds.sort(), ['kind:acceptance', 'kind:integration']);
});

test('a requirement with no criteria and no human-test mark stays uncertain', () => {
  const s = computeScope({ kind: 'stage', projectTier: 'T2', checks: [], requirements: [{ id: 'R9', key: 'R9', criteria: [], sensitive_areas: [] }], delivered: ['R9'], partial: [], stageImplements: ['R9'], modules: [] });
  assert.deepEqual(s.missing.uncertain, ['R9']);
});
