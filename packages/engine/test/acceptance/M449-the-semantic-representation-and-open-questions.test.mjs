// M449, the semantic representation and open questions (slice 34; kernel
// lane). M5 plan §3.4 M449; D6-W05, D6-P07; D6 §3.2, §5.3 clause 1, Appendix
// B.2; B04; the driver's rulings (2026-10-13: `spec_change` carries no
// phase-hint guard; reading 1 strict); SEAM.md §§346, 396, 397, 402.
//
// (a) a specification in B.2's forms (statements, criteria text, the
//     human-test mark, §10 questions with and without a phase hint, §6
//     modules, §7 environments): `spec_semantics` holds each with its text,
//     each question's `blocks` and `phase_hint`;
// (b) prose outside the forms: absent from the representation, claimed by
//     no finding;
// (c) one representation row per save; the approved revision's
//     `semantic_digest` the approved save's;
// (d) a first plan implementing R3 while Q1 (phase 2) blocks it:
//     `PLAN_QUESTION_OPEN` naming `R3:Q1`; passing after a spec change
//     resolves Q1 and not before; a plan implementing R4 while a hint-less Q2,
//     added by an approved spec change, blocks it: `PLAN_QUESTION_OPEN`
//     naming `R4:Q2`;
// (e) a representation unreadable at approval: `approve` blocked naming the
//     cause, the answer refused, no default approved.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, consume } from './harness/decisions.mjs';
import { architectSession, createWithIdea, journeyContext, nothingPublished, planChecks, specRevisions, NOTHING } from './harness/journey/drive.mjs';
import { REQUIREMENTS, ROADMAP_JSON, SPEC, SPEC_DEFECTIVE, STAGES, phasePlan, specText } from './harness/journey/reference.mjs';
import { postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { Q, SPEC_PATH, blockersOf, findingNaming, requirementsWith, semanticsOf, specSaves, withEnvironmentSubsection, withQuestions, withR5 } from './harness/journey/spec34.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { closeSession } from './harness/sessions.mjs';

// (a) and (b): B.2's forms, with prose that only looks like them in §1 and §3.
const PROSE_Q = 'Q7 Blocks R9 entirely. (phase 1)';
const PROSE_CRITERION = '- R9.1 The dashboard is blue.';
const B2_SPEC = (() => {
  const forms = withEnvironmentSubsection(withQuestions(withR5({ mark: true }), [Q.blocksPhaseTwoHinted, Q.blocksR4NoHint]));
  return forms
    .replace('## 2. Non-goals', `- ${PROSE_Q}\n\n## 2. Non-goals`)
    .replace('## 4. Requirements', `${PROSE_CRITERION}\n\n## 4. Requirements`);
})();

// A spec saved and approved through a Spec Writer session.
async function approvedFrom(fx, text) {
  const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
  const s = await specSaves(fx, p.id, [text]);
  assert.deepEqual(blockersOf(s.approval), [], `the specification is approvable (${JSON.stringify(s.approval?.options)})`);
  await consume(fx, p.id, s.approval, 'approve');
  return p;
}

// The roadmap and first plan with `key` moved into phase 1, implemented by stage `stage`.
function movedIntoPhaseOne(key, stageNumber, revision, specVersion) {
  const roadmap = {
    ...ROADMAP_JSON,
    phases: [
      { ...ROADMAP_JSON.phases[0], requirement_ids: [...ROADMAP_JSON.phases[0].requirement_ids, key] },
      { ...ROADMAP_JSON.phases[1], requirement_ids: ROADMAP_JSON.phases[1].requirement_ids.filter((k) => k !== key) },
    ],
  };
  const criteria = REQUIREMENTS.find((r) => r.key === key).criteria.map((c) => c.id);
  const stages = STAGES[1].map((s) => (s.number === stageNumber ? { ...s, implements: [...s.implements, key], validation: { ...s.validation, criteria: [...s.validation.criteria, ...criteria] } } : s));
  return { over: { '.surety/roadmap/roadmap.json': roadmap }, plan: phasePlan(1, { revision, spec_version: specVersion, stages }) };
}

// The owner's change request carried to its approval: the Spec Writer's run writes `text`.
async function specChangeTo(fx, p, text, version, changes) {
  fx.scripted.defaultScript(script.complete());
  fx.scripted.kindScript('spec_change', { steps: [step.write(SPEC_PATH, text), step.result({ status: 'completed', summary: 'the change', changes })] });
  const ctx = journeyContext(fx, p);
  await postChange(fx, ctx, 'Resolve the open question.');
  const approved = await pumpNoIdle(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === version), { what: `spec version ${version}`, answerKinds: ['spec_change'] });
  // Whatever the approval registered (a check correction, a replan) ends at
  // once, so the Architect's session that follows is not held session_busy.
  await tick(fx.engine, p.id, { rounds: 2 });
  await waitForIdle(fx.home, p.id);
  return approved;
}

const reasonsOf = (res) => JSON.stringify(res.body?.subject ?? {});

describe('M449 the semantic representation and open questions', () => {
  test('(a) B.2\'s forms held with their text, each question\'s blocks and phase hint; (b) prose outside the forms absent and claimed by nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [B2_SPEC], { close: false });
    const [row] = semanticsOf(fx.home, s.run.id);
    assert.equal(row.readable, 1, `the representation is readable (${JSON.stringify(row.findings)})`);
    const r = row.representation;
    const req = (key) => (r.requirements ?? []).find((x) => x.key === key);
    for (const want of REQUIREMENTS) {
      const got = req(want.key);
      assert.ok(got, `${want.key} is in the representation`);
      assert.equal(got.statement, want.statement, `${want.key}'s statement`);
      assert.deepEqual(got.criteria, want.criteria.map((c) => ({ id: c.id, text: c.text })), `${want.key}'s criteria with their text`);
      assert.deepEqual(got.sensitive_areas, [], `${want.key}'s areas`);
    }
    assert.equal(req('R5')?.human_test, true, 'R5 carries the human-test mark');
    assert.deepEqual(req('R5')?.criteria, [], 'and no criterion');
    assert.deepEqual(req('R3')?.blocked_by_questions, ['Q1'], 'R3 blocked by Q1');
    assert.deepEqual(req('R4')?.blocked_by_questions, ['Q2'], 'R4 blocked by Q2');
    const questions = Object.fromEntries((r.questions ?? []).map((q) => [q.id, q]));
    assert.deepEqual(Object.keys(questions).sort(), ['Q1', 'Q2'], `the two §10 questions and no other (${JSON.stringify(r.questions)})`);
    assert.deepEqual([questions.Q1.blocks, questions.Q1.phase_hint], [['R3'], 2], 'Q1 blocks R3 with the hint (phase 2)');
    assert.deepEqual([questions.Q2.blocks, questions.Q2.phase_hint ?? null], [['R4'], null], 'Q2 blocks R4 with no hint');
    assert.ok(questions.Q1.text.includes('Does R3 count a refused sum?'), 'with its text');
    assert.deepEqual((r.modules ?? []).map((m) => [m.name, m.paths]), [['lib', ['src/']], ['service', ['server.mjs']]], 'the §6 modules');
    assert.deepEqual((r.environments ?? []).map((e) => e.name), ['alpha'], 'the §7 environment');
    // (b) Prose outside the forms.
    assert.equal(req('R9'), undefined, 'a criterion-like line outside §4 is not a requirement');
    assert.equal(questions.Q7, undefined, 'a question-like line outside §10 is not a question');
    assert.equal(JSON.stringify(r).includes('R9'), false, 'nothing of the prose is in the representation');
    assert.equal(findingNaming(row.findings, (row.findings ?? []).map((f) => f.code), 'R9'), undefined, `no finding claims the prose (${JSON.stringify(row.findings)})`);
    assert.equal(findingNaming(row.findings, (row.findings ?? []).map((f) => f.code), 'Q7'), undefined);
  });

  test('(c) one representation row per save; the approved revision carries the approved save\'s semantic_digest', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC_DEFECTIVE, SPEC]);
    const rows = semanticsOf(fx.home, s.run.id);
    assert.equal(rows.length, 2, 'one row per save');
    assert.notEqual(rows[0].git_blob, rows[1].git_blob, 'each the blob of its save');
    await consume(fx, p.id, s.approval, 'approve');
    const [rev] = specRevisions(fx.home, p.id);
    assert.equal(rev.semantic_digest, rows[1].semantic_digest, 'spec_revisions carries the approved save\'s digest');
  });

  test('(d) a plan implementing R3 while Q1 blocks it: PLAN_QUESTION_OPEN naming R3:Q1; after a spec change resolves Q1, the same plan passes', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await approvedFrom(fx, withQuestions(SPEC, [Q.blocksPhaseTwoHinted]));
    const before = movedIntoPhaseOne('R3', 1, refOid(p.repo.path, p.repo.ref), 1);
    const refused = await architectSession(fx, p.id, p.repo, { answer: 'none', over: before.over, plan: before.plan });
    assert.equal(refused.closeRes.status, 422, `the close is refused (→ ${refused.closeRes.status} ${refused.closeRes.text})`);
    assert.equal(refused.closeRes.body?.code, 'plan_refused');
    assert.match(reasonsOf(refused.closeRes), /PLAN_QUESTION_OPEN/, 'PLAN_QUESTION_OPEN');
    assert.match(reasonsOf(refused.closeRes), /R3:Q1/, 'naming R3:Q1 (SEAM.md §402)');
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'nothing published');
    await closeSession(fx, p.id, refused.run.id, { refuse: true });
    // Q1 resolved by a spec change: answered into R3's statement, §10 empty again.
    const resolved = specText({ version: 2, requirements: requirementsWith({ R3: { statement: 'The library counts the successful sums served since the process started; a refused sum is not counted.' } }) });
    await specChangeTo(fx, p, resolved, 2, [{ key: 'R3', kind: 'text_changed', reason: 'Q1 answered: refused sums are not counted' }]);
    const after = movedIntoPhaseOne('R3', 1, refOid(p.repo.path, p.repo.ref), 2);
    const passing = await architectSession(fx, p.id, p.repo, { answer: 'none', over: after.over, plan: after.plan });
    assert.equal(passing.closeRes.status, 200, `after the resolution the same plan is accepted (→ ${passing.closeRes.status} ${passing.closeRes.text})`);
    const check = planChecks(fx.home, p.id).at(-1);
    assert.equal(check?.outcome, 'passed', `and its check passes (${JSON.stringify(check?.reasons)})`);
  });

  test('(d) a plan implementing R4 while a hint-less Q2, added by an approved spec change, blocks it: PLAN_QUESTION_OPEN naming R4:Q2', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await approvedFrom(fx, SPEC);
    const withQ2 = withQuestions(specText({ version: 2, requirements: requirementsWith({ R4: { statement: 'A user reads how many sums the service has served.' } }) }), [Q.blocksR4NoHint]);
    await specChangeTo(fx, p, withQ2, 2, [{ key: 'R4', kind: 'text_changed', reason: 'the period of the count is open (Q2)' }]);
    const moved = movedIntoPhaseOne('R4', 2, refOid(p.repo.path, p.repo.ref), 2);
    const refused = await architectSession(fx, p.id, p.repo, { answer: 'none', over: moved.over, plan: moved.plan });
    assert.equal(refused.closeRes.status, 422, `the close is refused (→ ${refused.closeRes.status} ${refused.closeRes.text})`);
    assert.match(reasonsOf(refused.closeRes), /PLAN_QUESTION_OPEN/, 'PLAN_QUESTION_OPEN');
    assert.match(reasonsOf(refused.closeRes), /R4:Q2/, 'naming R4:Q2');
    assert.deepEqual(nothingPublished(fx.home, p.id, { allowKinds: ['spec_change', 'check_correction', 'replan'] }), NOTHING, 'nothing published');
  });

  test('(e) a representation unreadable at approval: approve blocked naming the cause, the answer refused, nothing approved', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, ['# Tally\n\nA service that sums numbers. Requirements to follow.\n']);
    const [row] = semanticsOf(fx.home, s.run.id);
    assert.equal(row.readable, 0, 'the representation is unreadable');
    assert.ok(s.approval, `the close raised spec_approval (${JSON.stringify(s.closed)})`);
    const blockers = blockersOf(s.approval);
    const cause = blockers.find((b) => b.startsWith('SPEC_REPRESENTATION_UNREADABLE:'));
    assert.ok(cause && cause.length > 'SPEC_REPRESENTATION_UNREADABLE:'.length, `approve is blocked naming the cause (SEAM.md §398) (${JSON.stringify(blockers)})`);
    const res = await answer(fx.engine, p.id, s.approval, 'approve');
    assert.equal(res.status, 409, `approving is refused (→ ${res.status} ${res.text})`);
    assert.deepEqual(specRevisions(fx.home, p.id), [], 'no spec revision, never a default');
  });
});
