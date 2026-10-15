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
  // A renumbered requirement's criteria are its own: no criterion renumbering across requirements (the review's M1).
  assert.deepEqual(c.renumbered.map((r) => [r.kind, r.from, r.key]).sort(), [['requirement', 'R2', 'R3']]);
  assert.deepEqual(c.withdrawn, ['R2']);
});

test('reordering, a changed statement under the same key and an added requirement renumber nothing', () => {
  const a = rep(spec({ reqs: [R('R1', 'Sum.', [['R1.1', 'x'], ['R1.2', 'y']]), R('R2', 'Count.', [['R2.1', 'z']])] }));
  const b = rep(spec({ reqs: [R('R2', 'Count.', [['R2.1', 'z']]), R('R1', 'Sum exactly.', [['R1.2', 'y'], ['R1.1', 'x']]), R('R3', 'New.', [['R3.1', 'w']])] }));
  assert.deepEqual(compareKeys(a, b), { renumbered: [], withdrawn: [], reused: [] });
  assert.deepEqual(compareKeys(null, b), { renumbered: [], withdrawn: [], reused: [] });
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
  const moved = specBlockers(row(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R3', 'B.', [['R3.1', 'b']])] })), { rep: approved, withdrawn: [] });
  assert.ok(moved.includes('spec_keys_renumbered:R2->R3'), moved.join(' '));
  assert.deepEqual(specBlockers(row(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']])] })), { rep: null, withdrawn: [] }), []);
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
  assert.deepEqual(files.map((f) => f.path), ['generation.json', 'spec.md', 'index.json', 'roadmap.json', 'module_map.json', 'plan.json', 'evaluation.json', 'findings.json', 'deferrals.json', 'objections.json', 'refusal.json']);
  assert.ok(replanPromptText(facts).join('\n').includes('PLAN_CYCLE (stages:1->2->1)'));
  assert.ok(!files.some((f) => /transcript/.test(f.path)));
  const unread = replanFiles({ ...facts, spec_text: null, refusal: null });
  assert.ok(unread.some((f) => f.path === 'spec.json' && f.kind === 'spec'));
  assert.ok(!unread.some((f) => f.path === 'refusal.json'));
});

test("an early replacement's package names the kept stages and states the kept-stage rule the plan check applies (the real M443 run's replan)", async () => {
  const { KEPT_STAGE_RULE } = await import(join(dist, 'plan', 'check.js'));
  const facts = {
    repo: '/r',
    trigger: { source: 'spec_change', id: 'scr_1', generation: 1 },
    trigger_subject: { replaces: { phase_plan: 'pp_1', generation: 1 }, evidence: null, stale: null, rejected: null },
    generation: { spec_revision: null, architecture_revision: null, roadmap_revision: null, plan: { id: 'pp_1', phase_number: 1, generation: 1 }, spec_evidence_generation: 2 },
    spec_text: null,
    index: [],
    roadmap: null,
    module_map: {},
    completed_plan: null,
    open_plan: { id: 'pp_1', phase_number: 1, generation: 1, status: 'published', published_at: 'a', completed_at: null, completion_binding: null, stages: [] },
    phase_evaluation: null,
    findings: [],
    deferrals: { findings: [], obligations: [] },
    objections: [],
    refusal: null,
    kept: [
      { number: 2, implements: ['R3', 'R8'] },
      { number: 3, implements: ['R10'] },
    ],
  };
  const text = replanPromptText(facts).join('\n');
  assert.ok(text.includes('Kept stages: stage 2 (implements R3, R8); stage 3 (implements R10).'), text);
  assert.ok(text.includes(KEPT_STAGE_RULE));
  assert.ok(text.includes('/surety/context/open-plan.json'));
  assert.ok(!replanPromptText({ ...facts, kept: [] }).join('\n').includes('Kept stages:'), 'none kept: not stated');
});

// ---- the slice-34 review's fixes --------------------------------------------------------

test('M1: a criterion moved to another requirement is withdrawn there and added here, never renumbered', () => {
  const a = rep(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a'], ['R1.2', 'moved text']]), R('R4', 'D.', [['R4.1', 'd']])] }));
  const b = rep(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R4', 'D.', [['R4.1', 'd'], ['R4.2', 'moved text']])] }));
  const c = compareKeys(a, b);
  assert.deepEqual(c.renumbered, []);
  assert.deepEqual(c.withdrawn, ['R1.2']);
  const within = compareKeys(a, rep(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a'], ['R1.3', 'moved text']]), R('R4', 'D.', [['R4.1', 'd']])] })));
  assert.deepEqual(within.renumbered.map((r) => [r.from, r.key]), [['R1.2', 'R1.3']]);
});

test('N4: a key carried as withdrawn and written again is spec_key_reused at the save and blocks approve', () => {
  const prev = rep(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']])] }));
  prev.requirements.push({ ...prev.requirements[0], key: 'R2', statement: 'Old.', withdrawn: true });
  const r = specFindings(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R2', 'New.', [['R2.1', 'n']])] }), '.surety/spec/spec.md', prev);
  assert.ok(r.findings.some((f) => f.code === 'spec_key_reused' && f.subject.key === 'R2'));
  const p = parseSpecification(spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']]), R('R2', 'New.', [['R2.1', 'n']])] }));
  const row = { id: 's', project: 'p', run: 'r', git_blob: 'b', semantic_digest: p.digest, representation: JSON.stringify(p.representation), findings: JSON.stringify(p.findings), readable: 1, created_at: '' };
  assert.ok(specBlockers(row, { rep: null, withdrawn: ['R2'] }).includes('spec_key_reused:R2'));
  assert.deepEqual(specBlockers(row, { rep: 'unreadable', withdrawn: [] }), ['SPEC_REPRESENTATION_UNREADABLE:previous'], 'N3 (b): an unreadable approved representation blocks, never skips the comparison');
});

test('N3 (d): a question naming a key the specification lacks is spec_question_unknown_key, which blocks approve', () => {
  const text = spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']], 2)], questions: ['- Q1 Which unit for R9? (phase 2)'] });
  const f = specFindings(text).findings.find((x) => x.code === 'spec_question_unknown_key');
  assert.deepEqual(f?.subject, { question: 'Q1', key: 'R9' });
  const p = parseSpecification(text);
  const row = { id: 's', project: 'p', run: 'r', git_blob: 'b', semantic_digest: p.digest, representation: JSON.stringify(p.representation), findings: JSON.stringify(p.findings), readable: 1, created_at: '' };
  const b = specBlockers(row);
  assert.equal(b[0], 'spec_semantics_invalid');
  assert.ok(b.includes('spec_question_unknown_key:R9'), b.join(' '));
});

test('N1: a cell holding an escaped pipe is read back; the engine\'s own row is found and replaced', () => {
  const log = ['| Version | Date | Change | Approved by |', '|---|---|---|---|', '| 1 | 2026-10-13 | a \\| b | human |'];
  const text = spec({ reqs: [R('R1', 'A.', [['R1.1', 'a']])], changeLog: log });
  const once = appendChangeLog(text, { version: 1, date: '2026-10-14', change: 'c | d', approved_by: 'human' });
  assert.ok(once.includes('| 1 | 2026-10-14 | c \\| d | human |'));
  assert.ok(!once.includes('a \\| b'), 'the row of version 1 is replaced, not a second one appended');
  assert.equal(appendChangeLog(once, { version: 1, date: '2026-10-14', change: 'c | d', approved_by: 'human' }), once);
});

test('N7: the change log keeps every byte outside its row (latin1 in, latin1 out) and the line ending', () => {
  const bytes = Buffer.concat([Buffer.from('# P é\r\n\r\n## 11. Change log\r\n\r\n| Version | Date | Change | Approved by |\r\n|---|---|---|---|\r\n', 'utf8'), Buffer.from([0xff, 0x0a])]);
  const out = Buffer.from(appendChangeLog(bytes.toString('latin1'), { version: 1, date: '2026-10-13', change: 'First approved version', approved_by: 'human' }), 'latin1');
  assert.ok(out.includes(Buffer.from('| 1 | 2026-10-13 | First approved version | human |\r\n')));
  assert.ok(out.subarray(0, 10).equals(bytes.subarray(0, 10)), 'the bytes before the row are unchanged');
  assert.ok(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0x0a])), 'an invalid UTF-8 byte after the table survives');
});

test('M3: an answer arriving while a publication pass runs is answered after a pass that began after it', async () => {
  const { publishAuthorized } = await import(join(dist, 'plan', 'publish.js'));
  const log = [];
  let authorized = ['b1'];
  let release;
  const first = new Promise((r) => (release = r));
  let passes = 0;
  const rt = {
    read: async (name) => {
      if (name !== 'plan.authorized') throw new Error(name);
      passes++;
      log.push(`read:${authorized.join(',')}`);
      return [...authorized];
    },
    engine: async (_name, a) => {
      if (passes === 1) await first;
      log.push(`publish:${a.bundle}`);
      authorized = authorized.filter((x) => x !== a.bundle);
      return { published: true, plan: `plan_${a.bundle}`, stale: null };
    },
  };
  const p1 = publishAuthorized(rt, 'proj');
  await new Promise((r) => setImmediate(r));
  // The second answer's authority commits while the first pass is held.
  authorized = [...authorized, 'b2'];
  const p2 = publishAuthorized(rt, 'proj');
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(log, ['read:b1', 'publish:b1', 'read:b2', 'publish:b2'], 'the second caller waited for a pass that read its authority');
  const p3 = await publishAuthorized(rt, 'proj');
  assert.equal(p3, 0, 'nothing left: a later call runs a pass of its own');
});

test('the gap: a head move touching a bound input stales the bundle; any other re-raises it', async () => {
  const { touchesBundle } = await import(join(dist, 'plan', 'bundle.js'));
  assert.deepEqual(touchesBundle(['.surety/policy.json', 'src/a.mjs'], ['.surety/phases/phase-1.json']), []);
  assert.deepEqual(touchesBundle(['.surety/spec/spec.md', '.surety/policy.json'], []), ['.surety/spec/spec.md']);
  assert.deepEqual(touchesBundle(['.surety/adrs/ADR-002.md'], []), ['.surety/adrs/ADR-002.md']);
});

test('N6: a link is judged by where it resolves: to a permitted directory itself or file, allowed; to the checks, refused', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { configureGit } = await import(join(dist, 'git', 'exec.js'));
  const { validateDiff } = await import(join(dist, 'git', 'snapshot.js'));
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-n6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  g('init', '-q');
  mkdirSync(join(dir, '.surety/spec'), { recursive: true });
  mkdirSync(join(dir, '.surety/checks'), { recursive: true });
  writeFileSync(join(dir, '.surety/spec/spec.md'), 'x\n');
  writeFileSync(join(dir, '.surety/checks/a.mjs'), 'c\n');
  g('add', '-A');
  g('-c', 'user.email=u@u', '-c', 'user.name=u', 'commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  const caps = { files: 100, bytes: 1e6, fileBytes: 1e6 };
  const treeWithLink = (path, target) => {
    symlinkSync(target, join(dir, path));
    g('add', path);
    const tree = g('write-tree');
    g('rm', '-q', '--cached', path);
    rmSync(join(dir, path));
    return tree;
  };
  const judge = async (path, target) => (await validateDiff(dir, base, treeWithLink(path, target), 'spec_writer', caps, ['.surety/checks/'])).violation;
  assert.equal(await judge('.surety/spec/self', '.'), null, 'a link to .surety/spec itself');
  assert.equal(await judge('.surety/spec/f', 'spec.md'), null, 'a link to a file of .surety/spec');
  const v = await judge('.surety/spec/checks', '../checks');
  assert.equal(v?.klass, 'diff_violation');
  assert.equal(v?.path, '.surety/spec/checks');
  assert.equal((await judge('.surety/spec/up', '..'))?.klass, 'diff_violation', 'a link to .surety itself, which holds the checks');
});
