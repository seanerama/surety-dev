// M422, the spec approval's floor (slice 34; kernel lane). M5 plan §3.4
// M422; D6-W02; D6 §3.4, §4.1; F §9.1; reading 1 (the strict reading, the
// driver's ruling 2026-10-13); B04; SEAM.md §§346, 398, 399.
//
// (a) `approve` blocked while the representation is invalid, a requirement is
//     uncertain, an open question blocks a phase-1 requirement; open while one
//     blocks only a phase-2 requirement with its hint (and with a `(phase 1)`
//     hint); blocked while a question has no phase hint and while a blocked
//     requirement has none; each blocker naming its subject;
// (b) the effect: `spec_revisions` 1 with `git_blob` and `semantic_digest`,
//     requirements with criteria text and areas, `modules` from TPL §6,
//     environments by name with no adapter, `spec_ready`,
//     `spec_evidence_generation` 1, the answer an effect intent
//     (`spec_approval_application`) done before the 200, and the TPL §11 row
//     for the version owned by the engine in its own commit (appended, or
//     replacing the role's row for that version; `git_blob` the blob after
//     it, the digest unchanged); a spec change's approval writes its n+1 row
//     the same way (the driver's ruling, 2026-10-13; SEAM.md §399);
// (c) a save between preview and answer changing a criterion's text only:
//     the answer stale (the manifest binds the semantics);
// (d) a role's attempt; the automated approval: neither approves.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, assertStaleAnswer, consume, decision, intentsOf } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { createWithIdea, environmentsOf, eventsAbout, journeyContext, modulesOf, projectRow, requirementsOf, specChangeScript, specRevisions } from './harness/journey/drive.mjs';
import { postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { REQUIREMENTS, SPEC, specText } from './harness/journey/reference.mjs';
import { ENGINE_ROW, Q, SPEC_PATH, VARIANTS, assertEngineRow, blockersOf, logRows, requirementsWith, semanticsOf, specSaves, withQuestions, withoutPhaseOf } from './harness/journey/spec34.mjs';
import { fileAt, gitQuiet, parentsOf, refOid } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { openSession, say, scriptTurns, turnResult } from './harness/sessions.mjs';
import { script, step } from './harness/scripted.mjs';

// (a)'s specifications and what `approve` must carry (SEAM.md §398): `null` is open.
const FLOOR = [
  { name: 'the representation invalid (R2 twice)', spec: VARIANTS.duplicate_requirement, blocker: (b) => b.includes('spec_semantics_invalid') && b.includes('spec_requirement_duplicate:R2') },
  { name: 'a requirement uncertain (R5 with no criterion and no mark)', spec: VARIANTS.uncertain, blocker: (b) => b.some((x) => x.startsWith('spec_requirement_uncertain:') && x.includes('R5')) },
  { name: 'Q1 blocking R1, a phase-1 requirement', spec: withQuestions(SPEC, [Q.blocksPhaseOne]), blocker: (b) => b.includes('QUESTION_BLOCKS_PHASE_1:Q1:R1') },
  { name: 'Q1 blocking only R3, a phase-2 requirement, hinted (phase 2)', spec: withQuestions(SPEC, [Q.blocksPhaseTwoHinted]), blocker: null },
  { name: 'Q1 blocking only R3, hinted (phase 1)', spec: withQuestions(SPEC, [Q.blocksPhaseTwoHinted.replace('(phase 2)', '(phase 1)')]), blocker: null },
  { name: 'Q2 blocking R3 with no phase hint', spec: withQuestions(SPEC, [Q.blocksPhaseTwoNoHint]), blocker: (b) => b.includes('QUESTION_NO_PHASE_HINT:Q2') },
  { name: 'Q1 (phase 2) blocking R3, whose index row has no phase', spec: withQuestions(withoutPhaseOf('R3'), [Q.blocksPhaseTwoHinted]), blocker: (b) => b.includes('REQUIREMENT_NO_PHASE_HINT:R3:Q1') },
];

// TPL §11 without the role's row: the engine's is the only one after approval.
const ROLE_LOG_ROW = '| 1 | 2026-10-12 | First approved version | Sean |\n';
const SPEC_NO_LOG = SPEC.replace(ROLE_LOG_ROW, '');

describe('M422 the spec approval\'s floor', () => {
  for (const c of FLOOR) {
    test(`(a) ${c.name}: approve ${c.blocker ? 'blocked, naming the subject' : 'open'}`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      const s = await specSaves(fx, p.id, [c.spec]);
      assert.ok(s.approval, `the close raised spec_approval (${JSON.stringify(s.closed)})`);
      const blockers = blockersOf(s.approval);
      if (c.blocker) {
        assert.ok(c.blocker(blockers), `approve carries the blocker naming its subject (SEAM.md §398) (${JSON.stringify(blockers)})`);
        const res = await answer(fx.engine, p.id, s.approval, 'approve');
        assert.equal(res.status, 409, `approving is refused (→ ${res.status} ${res.text})`);
        assert.deepEqual(specRevisions(fx.home, p.id), [], 'no spec revision');
        assert.notEqual(projectRow(fx.home, p.id).baseline_state, 'spec_ready');
      } else {
        assert.deepEqual(blockers, [], 'approve is open');
        await consume(fx, p.id, s.approval, 'approve');
        assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'spec version 1 approved');
      }
    });
  }

  test('(b) the effect: spec_revisions 1 with its blob and digest, requirements with criteria text and areas, modules, environments by name, spec_ready, spec_evidence_generation 1, the change log row by the engine', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC_NO_LOG]);
    const [saved] = semanticsOf(fx.home, s.run.id);
    const checkpoint = refOid(p.repo.path, p.repo.ref);
    assert.equal(s.approval.manifest?.semantic_digest, saved.semantic_digest, 'the manifest binds the save\'s semantics');
    await consume(fx, p.id, s.approval, 'approve');
    // The 200 came after the effect: one intent, done.
    const intents = intentsOf(fx.home, s.approval.id);
    assert.deepEqual(intents.map((i) => [i.kind, i.status]), [['spec_approval_application', 'done']], 'the answer is an effect intent, done before the 200');
    // The TPL §11 row, appended by the engine in its own commit on the checkpoint.
    const head = refOid(p.repo.path, p.repo.ref);
    assert.notEqual(head, checkpoint, 'the engine committed the change log row');
    assert.deepEqual(parentsOf(p.repo.path, head), [checkpoint], 'one engine commit on the session\'s checkpoint');
    assertEngineRow(fileAt(p.repo.path, head, SPEC_PATH), SPEC_NO_LOG, 1, ENGINE_ROW.approval(1), 'appended');
    const [rev] = specRevisions(fx.home, p.id);
    assert.equal(rev.version, 1);
    assert.equal(rev.git_blob, gitQuiet(p.repo.path, ['rev-parse', `${head}:${SPEC_PATH}`]), 'git_blob is the blob after the engine\'s commit');
    assert.equal(rev.semantic_digest, saved.semantic_digest, 'the digest is the save\'s: §11 is outside the representation');
    // Requirements with criteria text and areas.
    const reqs = requirementsOf(fx.home, p.id);
    assert.deepEqual(reqs.map((r) => r.key), REQUIREMENTS.map((r) => r.key));
    for (const r of REQUIREMENTS) {
      const row = reqs.find((x) => x.key === r.key);
      assert.equal(row.text, r.statement, `${r.key}'s statement`);
      // Objection 080 (upheld): the criteria with their text are `criteria_text`; `criteria` keeps D3's IDs.
      const withText = typeof row.criteria_text === 'string' ? JSON.parse(row.criteria_text) : row.criteria_text;
      assert.deepEqual(withText, r.criteria.map((c) => ({ id: c.id, text: c.text })), `${r.key}'s criteria with their text`);
      assert.deepEqual(row.criteria, r.criteria.map((c) => c.id), `${r.key}'s criterion IDs, as D3's index has them`);
      assert.deepEqual(row.sensitive_areas, [], `${r.key}'s areas`);
      assert.equal(row.human_test, 0);
    }
    assert.deepEqual(modulesOf(fx.home, p.id).map((m) => [m.name, m.paths]), [['lib', ['src/']], ['service', ['server.mjs']]], 'modules from TPL §6');
    const envs = environmentsOf(fx.home, p.id);
    assert.deepEqual(envs.map((e) => e.name), ['alpha'], 'the environment by name');
    assert.equal(envs[0].adapter, 'none', 'with no adapter (objection 080: `none`, the column being NOT NULL since M4)');
    const project = projectRow(fx.home, p.id);
    assert.deepEqual([project.baseline_state, project.spec_evidence_generation], ['spec_ready', 1]);
    assert.equal(eventsAbout(fx.home, 'baseline.spec_approved', p.id).length, 1, 'baseline.spec_approved once');
  });

  test('(b) the role\'s own row for the version approved is replaced by the engine\'s; nothing else of the file changes', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC]);
    assert.equal(logRows(SPEC, 1).length, 1, 'the fixture is live: the role wrote a row for version 1');
    await consume(fx, p.id, s.approval, 'approve');
    const head = refOid(p.repo.path, p.repo.ref);
    assertEngineRow(fileAt(p.repo.path, head, SPEC_PATH), SPEC, 1, ENGINE_ROW.approval(1), 'replaced');
    assert.equal(specRevisions(fx.home, p.id)[0].git_blob, gitQuiet(p.repo.path, ['rev-parse', `${head}:${SPEC_PATH}`]), 'git_blob is the blob after the engine\'s commit');
  });

  test('(b) a spec change\'s approval: the engine\'s row for version 2, Specification change <seq>, and git_blob after it', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC]);
    await consume(fx, p.id, s.approval, 'approve');
    fx.scripted.defaultScript(script.complete());
    fx.scripted.kindScript('spec_change', specChangeScript());
    const ctx = journeyContext(fx, p);
    const request = await postChange(fx, ctx, 'Two clarifications: R2.1 names the content type; R4 counts successful sums only.');
    await pumpNoIdle(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2', answerKinds: ['spec_change'] });
    const head = refOid(p.repo.path, p.repo.ref);
    const text = fileAt(p.repo.path, head, SPEC_PATH);
    const rows = logRows(text, 2);
    assert.equal(rows.length, 1, `one §11 row for version 2 (${JSON.stringify(logRows(text))})`);
    assert.match(rows[0], ENGINE_ROW.change(2, request.seq), 'the engine\'s row naming the change');
    assert.equal(specRevisions(fx.home, p.id)[1].git_blob, gitQuiet(p.repo.path, ['rev-parse', `${head}:${SPEC_PATH}`]), 'git_blob is the blob after the engine\'s commit');
  });

  test('(c) a save between the preview and the answer, changing a criterion\'s text only: the answer is stale', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC]);
    const previewed = decision(fx.home, s.approval.id);
    // A second Spec Writer session rewords R1.1; the index (its identities) is unchanged.
    const reworded = specText({ requirements: requirementsWith({ R1: { criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` is called, then it returns the number 5.' }] } }) });
    const second = await specSaves(fx, p.id, [reworded], { close: false });
    const [sem] = semanticsOf(fx.home, second.run.id);
    assert.notEqual(sem.semantic_digest, previewed.manifest?.semantic_digest, 'the reworded criterion is another representation');
    await assertStaleAnswer(fx, p.id, previewed, 'approve');
    assert.deepEqual(specRevisions(fx.home, p.id), [], 'nothing approved on the stale preview');
  });

  test('(d) a role cannot approve: a turn whose result answers the decision is refused; no policy key approves; ticks under phase leave it open', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC]);
    const row = s.approval;
    // A Spec Writer turn whose result carries an answer to the decision.
    const run = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, run.id, [{ steps: [step.result(turnResult({ reply: 'Approved.', decisions: [{ decision: row.id, option: 'approve' }] }))] }]);
    const said = await say(fx, p.id, run.id, 'Approve the specification.');
    assert.equal(said.turn.state, 'failed', `the turn's result is refused by its closed schema (${JSON.stringify(said.turn)})`);
    // The automated approval: no such policy key.
    assertRefused(await fx.engine.post(`/v1/projects/${p.id}/policy`, { spec_approval: 'auto' }), 400, 'unknown_field', 'a policy key approving the specification');
    await tick(fx.engine, p.id, { rounds: 3 });
    const after = decision(fx.home, row.id);
    assert.equal(after.status, 'open', 'the decision is still open');
    assert.equal(after.answer ?? null, null, 'and unanswered');
    assert.deepEqual(specRevisions(fx.home, p.id), [], 'no spec revision');
  });
});
