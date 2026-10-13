// M410, the index's `Origin` and the claims table; syntax apart from
// authority (slice 32; kernel lane). M5 plan §3.2 M410; D6-R02; D6 §8.2, B.2;
// K10; D3 §4.5; B10; TPL §§5, 12; SEAM.md §§380, 379.
//   (a) a five-column index: every requirement `intended`, parsed as before;
//   (b) a six-column index with `intended` and `observed`: `origin` per
//       requirement;
//   (c) a sixth value outside the two: the save's finding `spec_index_invalid`
//       naming the row, and the approval blocked;
//   (d) TPL §12's table parsed into `spec_claims`; a claim naming an unknown
//       requirement: the save's finding `spec_claims_invalid` † naming the
//       row, and the approval blocked;
//   (e) M233's existing parser cases stay as they are and pass
//       (`M233-the-requirement-index.test.mjs`, unchanged; plan §4.3);
//   (f) in retrofit mode, a five-column index, and a six-column index with
//       every row `intended`: every produced requirement still
//       `reverse_engineered` and in the confirmation decision (M411).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decision } from './harness/decisions.mjs';
import { createWithIdea, requirementsOf, specSession, visionSession } from './harness/journey/drive.mjs';
import { SPEC } from './harness/journey/reference.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { FULL_ANSWERS, adoptProject, chooseMode, confirmAndApprove, retrofitSpecSession, specClaimsOf } from './harness/retrofit/drive.mjs';
import { CLAIMS, KEYS, REQUIREMENTS, retrofitSpecText } from './harness/retrofit/products.mjs';

// Tally's five-column index (slice 31) given the sixth column, row by row.
function sixColumns(spec, origins) {
  return spec
    .replace('| Key | Title | Phase | Sensitive areas | Criteria |\n|---|---|---|---|---|', '| Key | Title | Phase | Sensitive areas | Criteria | Origin |\n|---|---|---|---|---|---|')
    .replace(/^(\| (R\d+) \|[^\n]*\|)$/gm, (line, row, key) => (key in origins ? `${row} ${origins[key]} |` : line));
}
const findingsOf = (save) => save.findings ?? [];
const approveBlocked = (row) => (row.options.find((o) => o.key === 'approve')?.blockers ?? []).length > 0;

describe('M410 Origin and the claims table: syntax apart from authority', () => {
  test('(a) a five-column index: every requirement intended; (b) a six-column index: origin per requirement', async (t) => {
    const fx = await scriptedEngine(t);
    const five = await createWithIdea(fx);
    await visionSession(fx, five.id);
    await specSession(fx, five.id);
    assert.deepEqual(requirementsOf(fx.home, five.id).map((r) => [r.key, r.origin]), [['R1', 'intended'], ['R2', 'intended'], ['R3', 'intended'], ['R4', 'intended']], 'five columns: every row intended');
    const six = await createWithIdea(fx, { name: 'tally-six' });
    await visionSession(fx, six.id);
    const text = sixColumns(SPEC, { R1: 'observed', R2: 'intended', R3: 'observed', R4: 'intended' });
    assert.match(text, /\| Origin \|/, 'the fixture is live: six columns');
    await specSession(fx, six.id, { second: text });
    assert.deepEqual(requirementsOf(fx.home, six.id).map((r) => [r.key, r.origin]), [['R1', 'observed'], ['R2', 'intended'], ['R3', 'observed'], ['R4', 'intended']], 'origin per requirement');
    assert.ok(requirementsOf(fx.home, six.id).every((r) => !r.reverse_engineered), 'not adopted: no requirement is reverse-engineered, whatever its origin');
  });

  test('(c) a sixth value outside intended and observed: spec_index_invalid naming the row, approval blocked', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    await visionSession(fx, p.id);
    const bad = sixColumns(SPEC, { R1: 'intended', R2: 'guessed', R3: 'intended', R4: 'intended' });
    const s = await specSession(fx, p.id, { first: bad, second: bad, answer: false });
    const found = findingsOf(s.saves[1]).filter((f) => f.code === 'spec_index_invalid');
    assert.ok(found.some((f) => JSON.stringify(f).includes('R2')), `the save names the row R2 (${JSON.stringify(findingsOf(s.saves[1]))})`);
    const [approval] = s.decisions;
    assert.ok(approval && approveBlocked(decision(fx.home, approval.id)), `approve is blocked (${JSON.stringify(approval && decision(fx.home, approval.id).options)})`);
  });

  test('(d) TPL §12 parsed into spec_claims; a claim naming an unknown requirement refused naming the row', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    const bad = retrofitSpecText({ claims: [...CLAIMS, { source: 'README.md', claim: 'It is fast.', observed: 'not measured', requirement: 'R9' }] });
    const refused = await retrofitSpecSession(fx, p.id, { spec: bad });
    const found = findingsOf(refused.saved).filter((f) => f.code === 'spec_claims_invalid');
    assert.ok(found.some((f) => JSON.stringify(f).includes('R9')), `the save names the claim's row, R9 (${JSON.stringify(findingsOf(refused.saved))})`);
    assert.ok(refused.approval && approveBlocked(refused.approval), 'approve is blocked while a claim names an unknown requirement');

    const fx2 = await scriptedEngine(t);
    const q = await adoptProject(fx2);
    await chooseMode(fx2, q.id, 'full');
    const ok = await retrofitSpecSession(fx2, q.id);
    assert.deepEqual(findingsOf(ok.saved), [], 'the whole specification has no finding');
    await confirmAndApprove(fx2, q.id, FULL_ANSWERS);
    const claims = specClaimsOf(fx2.home, q.id);
    const byId = Object.fromEntries(requirementsOf(fx2.home, q.id).map((r) => [r.id, r.key]));
    assert.deepEqual(
      claims.map((c) => [c.claim_source, c.claim, c.observed, byId[c.requirement] ?? c.requirement]),
      CLAIMS.map((c) => [c.source, c.claim, c.observed, c.requirement]),
      'one spec_claims row per row of §12, each naming its requirement',
    );
  });

  test('(f) in retrofit mode a five-column index, and six columns all intended: every requirement reverse-engineered and in the confirmation decision', async (t) => {
    for (const [label, spec] of [
      ['five columns', retrofitSpecText({ sixth: false })],
      ['six columns, every row intended', retrofitSpecText({ origins: Object.fromEntries(KEYS.map((k) => [k, 'intended'])) })],
    ]) {
      const fx = await scriptedEngine(t);
      const p = await adoptProject(fx);
      await chooseMode(fx, p.id, 'full');
      const s = await retrofitSpecSession(fx, p.id, { spec });
      assert.deepEqual(Object.keys(s.confirms).sort(), [...KEYS], `${label}: one requirement_confirm per produced requirement (${JSON.stringify(Object.keys(s.confirms))})`);
      await confirmAndApprove(fx, p.id, FULL_ANSWERS);
      const reqs = requirementsOf(fx.home, p.id);
      assert.deepEqual(reqs.map((r) => [r.key, Boolean(r.reverse_engineered)]), REQUIREMENTS.map((r) => [r.key, true]), `${label}: each reverse_engineered`);
    }
  });
});
