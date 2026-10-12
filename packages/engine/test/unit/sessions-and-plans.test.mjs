// Developer tests for M5 slice 31a's pure parts (D6 §3, §5.3, B.1 to B.7):
// the identity block, the specification's representation and its digest,
// the plan check's clauses on a small bundle, a session turn's reply, and a
// one-shot result's closed fields.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { parseIdentityBlock } = await import(join(dist, 'spec', 'identity-block.js'));
const { parseSpecification } = await import(join(dist, 'spec', 'semantics.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));
const { parseSessionReply } = await import(join(dist, 'sessions', 'session.js'));
const { fieldAllowed } = await import(join(dist, 'runs', 'report.js'));

const block = (lines) => `# Idea\n\n\`\`\`yaml surety-identity\n${lines.join('\n')}\n\`\`\`\n`;
const GOOD = ['name: Tally', 'one_line: sums', 'users:', '  - organizer', 'non_goals: []', 'success_measures:', '  - fast', 'sensitive_areas: none', 'tier_recommendation: T2', 'environments:', '  - alpha'];

test('the identity block parses its eight keys and keeps `none` as written', () => {
  const r = parseIdentityBlock(block(GOOD));
  assert.equal(r.ok, true);
  assert.equal(r.block.sensitive_areas, 'none');
  assert.deepEqual(r.block.environments, ['alpha']);
});

test('the identity block names an unknown key, a bad tier and an area outside the closed list', () => {
  const bad = parseIdentityBlock(block([...GOOD.filter((l) => !l.startsWith('tier') && !l.startsWith('sensitive')), 'budget: 5', 'tier_recommendation: T4', 'sensitive_areas:', '  - privacy']));
  assert.equal(bad.ok, false);
  const keys = bad.findings.map((f) => f.key);
  assert.ok(keys.includes('budget') && keys.includes('tier_recommendation') && keys.includes('sensitive_areas'));
  assert.equal(parseIdentityBlock('# no block\n').ok, false);
});

const spec = (reqs, index = reqs) => `# T\n\n**Spec version:** 1\n**Status:** draft\n**Tier:** T2\n**Owner:** Sean\n\n## 4. Requirements\n\n${reqs
  .map((r) => `### ${r.key}. ${r.key} title\n\n${r.statement}\n\n**Sensitive areas:** none\n\n${r.criteria.map((c) => `- ${c} text of ${c}`).join('\n')}\n`)
  .join('\n')}\n## 5. Requirement index\n\n| Key | Title | Phase | Sensitive areas | Criteria |\n|---|---|---|---|---|\n${index.map((r) => `| ${r.key} | t | 1 | none | ${r.criteria.join(', ')} |`).join('\n')}\n`;

test('the specification representation reads statements and criteria, and its digest ignores order', () => {
  const a = [
    { key: 'R1', statement: 'One.', criteria: ['R1.1'] },
    { key: 'R2', statement: 'Two.', criteria: ['R2.1', 'R2.2'] },
  ];
  const r = parseSpecification(spec(a));
  assert.equal(r.readable, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.representation.requirements[1].statement, 'Two.');
  assert.deepEqual(r.representation.requirements[1].criteria.map((c) => c.id), ['R2.1', 'R2.2']);
  assert.equal(parseSpecification(spec([...a].reverse())).digest, r.digest);
});

test('a criterion in the index and not in section 4 is a mismatch naming it', () => {
  const r = parseSpecification(spec([{ key: 'R1', statement: 'One.', criteria: ['R1.1'] }], [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }]));
  assert.ok(r.findings.some((f) => f.code === 'criterion_mismatch' && f.why.includes('R1.2')));
});

const KINDS = ['acceptance', 'smoke', 'integration', 'security_lint'];
const baseline = { spec_version: 1, requirements: [{ key: 'R1', criteria: ['R1.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] }], architecture_version: 1, roadmap_version: 1, head: 'a'.repeat(40), project_tier: 'T2', completed_phases: [], approved: null };
const artifacts = (stage = {}) => ({
  modules: { version: 1, modules: [{ name: 'lib', paths: ['src/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] },
  roadmap: { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'g', modules: ['lib'], requirement_ids: ['R1'], depends_on: [] }] },
  adrs: {},
  adr_front_matter: {},
  architecture_text: null,
  plan: {
    phase: 1,
    prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'a'.repeat(40) },
    conformance: 'within_baseline',
    stages: [{ number: 1, goal: 'g', tasks: ['t'], modules: ['lib'], implements: ['R1'], adrs: [], depends_on: [], validation: { criteria: ['R1.1'], kinds: KINDS, sensitive_areas: [] }, integration_obligations: [], ...stage }],
  },
});

test('the plan check passes a complete first bundle and routes it to the human', () => {
  const r = checkPlan(baseline, artifacts());
  assert.deepEqual(r.reasons, []);
  assert.equal(r.outcome, 'passed');
  assert.equal(r.routing, 'human', 'a first bundle changes the architecture');
});

test('the plan check names an unknown requirement, a stale head and an unvalidated criterion', () => {
  const r = checkPlan(baseline, artifacts({ implements: ['R1', 'R9'], validation: { criteria: [], kinds: KINDS, sensitive_areas: [] } }));
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('PLAN_UNKNOWN_REQUIREMENT') && codes.includes('PLAN_CRITERION_UNVALIDATED'));
  const stale = checkPlan({ ...baseline, head: 'b'.repeat(40) }, artifacts());
  assert.ok(stale.reasons.some((x) => x.code === 'PLAN_STALE_BASELINE'));
});

test("a session turn's reply is B.7's form; a speaker field is refused", () => {
  assert.deepEqual(parseSessionReply({ status: 'completed', summary: 's', reply: 'hi', artifact_changed: false, done: true }), { reply: 'hi', artifact_changed: false, done: true });
  assert.equal(parseSessionReply({ status: 'completed', summary: 's', reply: 'hi', artifact_changed: false, speaker: 'owner' }), null);
  assert.equal(parseSessionReply({ status: 'completed', summary: 's' }), null);
});

test("a one-shot result's fields are closed: B.7's fields and a decision answer are refused", () => {
  assert.equal(fieldAllowed({ status: 'completed', summary: 's', nominate: true }, 'builder'), true);
  assert.equal(fieldAllowed({ status: 'completed', summary: 's', reply: 'x' }, 'builder'), false);
  assert.equal(fieldAllowed({ status: 'completed', summary: 's', decisions: [] }, 'reviewer'), false);
});
