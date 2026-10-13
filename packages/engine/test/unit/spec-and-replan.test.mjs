// Developer tests for M5 slice 34's pure parts (D6 §3.2, §3.4, §5.3; B04;
// reading 1; the coordinator's rulings on the slice-34 design note): keys
// renumbered and gone between two representations; the open questions that
// block `approve`; the change log row in TPL §11; the save's findings and
// the approval's named blockers; `PLAN_QUESTION_OPEN` naming requirement and
// question; the one-shot replan's package files.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { parseSpecification } = await import(join(dist, 'spec', 'semantics.js'));
const { compareKeys, questionBlockers } = await import(join(dist, 'spec', 'keys.js'));
const { appendChangeLog } = await import(join(dist, 'spec', 'changelog.js'));
const { specFindings } = await import(join(dist, 'plan', 'findings.js'));
const { specBlockers } = await import(join(dist, 'spec', 'approval.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));
const { replanFiles, replanPromptText } = await import(join(dist, 'plan', 'replan-package.js'));

// A specification in B.2's forms: requirements as [key, statement, criteria
// [[id, text]], phase]; questions as §10 lines.
function spec({ reqs, questions = [], tier = 'T2', changeLog = null }) {
  const body = reqs
    .map(([k, s, cs]) => [`### ${k}. Title ${k}`, '', s, '', '**Sensitive areas:** none', '', ...cs.map(([id, t]) => `- ${id} ${t}`), ''].join('\n'))
    .join('\n');
  const index = reqs.map(([k, , cs, ph]) => `| ${k} | Title ${k} | ${ph ?? ''} | none | ${cs.map(([id]) => id).join(', ')} |`).join('\n');
  return [
    '# P',
    '',
    '**Spec version:** 1',
    '**Status:** draft',
    ...(tier === null ? [] : [`**Tier:** ${tier}`]),
    '**Owner:** Sean',
    '',
    '## 4. Requirements',
    '',
    body,
    '## 5. Requirement index',
    '',
    '| Key | Title | Phase | Sensitive areas | Criteria |',
    '|---|---|---|---|---|',
    index,
    '',
    '## 10. Open questions',
    '',
    ...(questions.length ? questions : ['None.']),
    '',
    ...(changeLog === null ? [] : ['## 11. Change log', '', ...changeLog, '']),
  ].join('\n');
}
const rep = (text) => parseSpecification(text).representation;
const R = (k, s, cs, ph = 1) => [k, s, cs, ph];

test('a requirement whose statement moved to another key is renumbered; a criterion likewise; a vanished key is withdrawn', () => {
  const a = rep(spec({ reqs: [R('R1', 'Sum two numbers.', [['R1.1', 'returns 5']]), R('R2', 'Count the sums.', [['R2.1', 'counts 3']])] }));
  const b = rep(spec({ reqs: [R('R3', 'Count the sums.', [['R3.1', 'counts 3']]), R('R1', 'Sum two numbers.', [['R1.1', 'returns 5']])] }));
  const c = compareKeys(a, b);
  assert.deepEqual(c.renumbered.map((r) => [r.kind, r.from, r.key]).sort(), [['criterion', 'R2.1', 'R3.1'], ['requirement', 'R2', 'R3']]);
  assert.deepEqual(c.withdrawn, ['R2']);
});

test('reordering, a changed statement under the same key and an added requirement renumber nothing', () => {
  const a = rep(spec({ reqs: [R('R1', 'Sum.', [['R1.1', 'x'], ['R1.2', 'y']]), R('R2', 'Count.', [['R2.1', 'z']])] }));
  const b = rep(spec({ reqs: [R('R2', 'Count.', [['R2.1', 'z']]), R('R1', 'Sum exactly.', [['R1.2', 'y'], ['R1.1', 'x']]), R('R3', 'New.', [['R3.1', 'w']])] }));
  assert.deepEqual(compareKeys(a, b), { renumbered: [], withdrawn: [] });
  assert.deepEqual(compareKeys(null, b), { renumbered: [], withdrawn: [] });
});

test('the save names a renumbered key and a vanished one, beside the representation; a missing tier is spec_tier_invalid', () => {
  const prev = rep(spec({ reqs: [R('R1', 'Sum.', [['R1.1', 'x']]), R('R2', 'Count.', [['R2.1', 'z']])] }));
  const r = specFindings(spec({ tier: null, reqs: [R('R1', 'Sum.', [['R1.1', 'x']]), R('R5', 'Count.', [['R5.1', 'z']])] }), '.surety/spec/spec.md', prev);
  const codes = r.findings.map((f) => `${f.code}:${f.subject.key ?? f.subject.tier ?? ''}`);
  assert.ok(codes.includes('spec_keys_renumbered:R5'), codes.join(' '));
  assert.ok(codes.includes('spec_key_withdrawn:R2'), codes.join(' '));
  assert.ok(r.findings.some((f) => f.code === 'spec_tier_invalid' && f.subject.tier === null), codes.join(' '));
});

test('the question guard, strict reading: phase 1, no hint, an unphased requirement block; a hinted question on phase 2 does not', () => {
  const reqs = [R('R1', 'A.', [['R1.1', 'a']], 1), R('R2', 'B.', [['R2.1', 'b']], 2), R('R3', 'C.', [['R3.1', 'c']], null)];
  const on = (q) => questionBlockers(rep(spec({ reqs, questions: [q] })));
  assert.deepEqual(on('- Q1 Which unit for R1? (phase 1)'), ['QUESTION_BLOCKS_PHASE_1:Q1:R1']);
  assert.deepEqual(on('- Q1 Which unit for R2? (phase 2)'), []);
  assert.deepEqual(on('- Q1 Which unit for R2? (phase 1)'), [], 'the requirement\'s phase decides, not the question\'s hint');
  assert.deepEqual(on('- Q1 Which unit for R2?'), ['QUESTION_NO_PHASE_HINT:Q1']);
  assert.deepEqual(on('- Q1 Which unit for R3? (phase 2)'), ['REQUIREMENT_NO_PHASE_HINT:R3:Q1']);
});

test('approve names each blocker: the representation\'s defects after spec_semantics_invalid, the questions, a key renumbered against the approved revision', () => {
  const row = (text) => {
    const p = parseSpecification(text);
    return { id: 's', project: 'p', run: 'r', git_blob: 'b', semantic_digest: p.digest, representation: JSON.stringify(p.representation), findings: JSON.stringify(p.findings), readable: p.readable ? 1 : 0, created_at: '' };
  };
  const dup = spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R1', 'B.', [['R1.2', 'b']])] });
  const b = specBlockers(row(dup));
  assert.equal(b[0], 'spec_semantics_invalid');
  assert.ok(b.some((x) => x.startsWith('spec_requirement_duplicate:R1')), b.join(' '));
  const approved = rep(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R2', 'B.', [['R2.1', 'b']])] }));
  const moved = specBlockers(row(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R3', 'B.', [['R3.1', 'b']])] })), approved);
  assert.ok(moved.includes('spec_keys_renumbered:R2->R3'), moved.join(' '));
  assert.deepEqual(specBlockers(row(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']])] })), null), []);
  const unreadable = specBlockers({ ...row(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']])] })), representation: '{not json' });
  assert.deepEqual(unreadable, ['spec_semantics_invalid', 'SPEC_REPRESENTATION_UNREADABLE:the saved representation does not parse']);
  assert.deepEqual(specBlockers(undefined), ['spec_not_saved']);
});

test('the change log row: replaces a row of its version, else appended after the last row; a missing or broken §11 gets a new table at the end', () => {
  const row = { version: 1, date: '2026-10-13', change: 'First approved version', approved_by: 'human' };
  const placeholder = spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']])], changeLog: ['| Version | Date | Change | Approved by |', '|---|---|---|---|', '| 1 | [date] | First approved version | [name] |'] });
  const one = appendChangeLog(placeholder, row);
  assert.ok(one.includes('| 1 | 2026-10-13 | First approved version | human |'));
  assert.ok(!one.includes('[date]'), 'the placeholder of version 1 is replaced');
  assert.equal(parseSpecification(one).digest, parseSpecification(placeholder).digest, '§11 is outside the representation');
  const two = appendChangeLog(one, { ...row, version: 2, change: 'Specification change 1' });
  const lines = two.split('\n');
  assert.equal(lines.indexOf('| 2 | 2026-10-13 | Specification change 1 | human |'), lines.indexOf('| 1 | 2026-10-13 | First approved version | human |') + 1);
  assert.equal(appendChangeLog(two, { ...row, version: 2, change: 'Specification change 1' }), two, 'writing the same row again changes nothing');
  const none = appendChangeLog('# P\n\n## 12. Claims and reality\n', row);
  assert.ok(none.endsWith('## 11. Change log\n\n| Version | Date | Change | Approved by |\n|---|---|---|---|\n| 1 | 2026-10-13 | First approved version | human |\n'));
  const broken = appendChangeLog('# P\n\n## 11. Change log\n\n| V | D |\n|---|---|\n', row);
  assert.ok(broken.trimEnd().endsWith('| 1 | 2026-10-13 | First approved version | human |'));
  assert.equal(appendChangeLog(broken, row), broken, 'the appended table is the one written next time');
});

// A bundle baseline and artifacts in which phase 2's plan implements R2.
function bundle(questions, assigned = true) {
  const baseline = {
    spec_version: 1,
    requirements: [
      { key: 'R1', criteria: ['R1.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
      { key: 'R2', criteria: ['R2.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: questions.filter((q) => q.blocks.includes('R2')).map((q) => q.id) },
      { key: 'R3', criteria: ['R3.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: questions.filter((q) => q.blocks.includes('R3')).map((q) => q.id) },
    ],
    questions,
    architecture_version: 1,
    roadmap_version: 1,
    head: 'h',
    project_tier: 'T1',
    completed_phases: [1],
    approved: null,
  };
  const modules = { version: 1, modules: [{ name: 'lib', paths: ['src/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] };
  const roadmap = {
    version: 1,
    architecture_version: 1,
    phases: [
      { number: 1, goal: 'one', modules: ['lib'], requirement_ids: ['R1'], depends_on: [] },
      { number: 2, goal: 'two', modules: ['lib'], requirement_ids: assigned ? ['R2', 'R3'] : ['R2'], depends_on: [1] },
    ],
  };
  const plan = {
    phase: 2,
    prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'h' },
    stages: [{ number: 1, goal: 'g', tasks: ['t'], modules: ['lib'], implements: ['R2'], adrs: [], depends_on: [], validation: { criteria: ['R2.1'], kinds: ['acceptance'], sensitive_areas: [] }, integration_obligations: [] }],
    conformance: 'within_baseline',
  };
  return [baseline, { modules, roadmap, adrs: {}, adr_front_matter: {}, architecture_text: null, plan }];
}

test('PLAN_QUESTION_OPEN names the requirement and the question; a hint-less question on an unassigned requirement refuses every plan', () => {
  const reasons = (qs, assigned) => checkPlan(...bundle(qs, assigned)).reasons.find((r) => r.code === 'PLAN_QUESTION_OPEN')?.subjects ?? [];
  assert.deepEqual(reasons([{ id: 'Q1', blocks: ['R2'], phase_hint: 2 }]), ['R2:Q1']);
  assert.deepEqual(reasons([{ id: 'Q1', blocks: ['R2'], phase_hint: null }]), ['R2:Q1']);
  assert.deepEqual(reasons([{ id: 'Q2', blocks: ['R3'], phase_hint: null }], false), ['R3:Q2'], 'the plan implements only R2, and is refused');
  assert.deepEqual(reasons([{ id: 'Q2', blocks: ['R3'], phase_hint: null }], true), [], 'R3 assigned to a phase: only a plan implementing it is refused');
  assert.deepEqual(reasons([]), []);
});

test('the replan package: every file of one generation, the spec by its blob or named unreadable, the refusal on a repair; no transcript', () => {
  const facts = {
    repo: '/r',
    trigger: { source: 'phase_complete', id: 'pp_1', generation: 1 },
    generation: { spec_revision: { id: 'spec_1', version: 1, git_blob: 'b1', semantic_digest: 'd' }, architecture_revision: { id: 'arch_1', version: 1 }, roadmap_revision: { id: 'road_1', version: 1 }, plan: { id: 'pp_1', phase_number: 1, generation: 1 }, spec_evidence_generation: 1 },
    spec_text: '# Tally\n',
    index: [],
    roadmap: { version: 1, phases: [] },
    module_map: {},
    completed_plan: { id: 'pp_1', phase_number: 1, generation: 1, status: 'completed', published_at: 'a', completed_at: 'b', completion_binding: null, stages: [] },
    open_plan: null,
    phase_evaluation: null,
    findings: [],
    deferrals: { findings: [], obligations: [] },
    objections: [],
    refusal: { run: 'run_1', reason_class: 'invalid_result', reason_text: 'x', plan_check: { id: 'pchk_1', phase: 2, reasons: [{ code: 'PLAN_CYCLE', subjects: ['stages:1->2->1'] }] } },
  };
  const files = replanFiles(facts);
  assert.deepEqual(files.map((f) => f.path), ['generation.json', 'spec.md', 'index.json', 'roadmap.json', 'modules.json', 'completed-plan.json', 'phase-evaluation.json', 'phase-findings.json', 'deferrals.json', 'objections.json', 'refusal.json']);
  assert.ok(replanPromptText(facts).join('\n').includes('PLAN_CYCLE (stages:1->2->1)'));
  assert.ok(!files.some((f) => /transcript/.test(f.path)));
  const unread = replanFiles({ ...facts, spec_text: null, refusal: null });
  assert.ok(unread.some((f) => f.path === 'spec-unreadable.json' && f.kind === 'spec'));
  assert.ok(!unread.some((f) => f.path === 'refusal.json'));
});
