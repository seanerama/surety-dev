// M421, the specification parsed at save; the semantic representation
// (slice 34; kernel lane). M5 plan §3.4 M421; D6-W01, D6-W05 in part; D6
// §3.2, Appendix B.2; D3 §4.5; B04; SEAM.md §§344, 346, 396 to 398.
//
// A Spec Writer session saves the reference specification, then one variant:
// (a) an index row that does not parse; (b) a §4 requirement without a row, a
//     row without a subsection; (c) a key renumbered against the previous
//     save, a key that disappeared; (d) an unknown area, a missing or a fourth
//     tier: each committed as a checkpoint, its defect returned on the save
//     and as the engine's transcript entry, naming the row or key; (c) the
//     vanished key `withdrawn` in the representation, never dropped;
// (e) a requirement with no criterion and no `**Human test.**` mark: reported
//     uncertain and blocking approval; with the mark: accepted, and the
//     approved requirement `human_test`;
// (f) a duplicate requirement heading, a duplicate criterion ID, a criterion
//     in the index absent from the subsection: each named, `approve` carrying
//     `spec_semantics_invalid` and the defect, the answer refused;
// (g) criteria reordered with no text change: the `semantic_digest`
//     unchanged; a statement changed with every ID unchanged: changed.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, consume } from './harness/decisions.mjs';
import { createWithIdea, projectRow, requirementsOf, specRevisions } from './harness/journey/drive.mjs';
import { SPEC } from './harness/journey/reference.mjs';
import { VARIANTS, blockersOf, findingNaming, semanticsOf, specSaves } from './harness/journey/spec34.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { transcriptEntries } from './harness/sessions.mjs';

// The defect each variant must be named by (SEAM.md §§346, 397).
const SAVE_DEFECTS = [
  { clause: '(a)', variant: 'index_row_unparsable', code: 'spec_index_invalid', names: 'R2' },
  { clause: '(b)', variant: 'requirement_without_row', code: 'spec_requirement_unindexed', names: 'R4' },
  { clause: '(b)', variant: 'row_without_subsection', code: 'spec_row_unmatched', names: 'R6' },
  { clause: '(c)', variant: 'renumbered', code: 'spec_keys_renumbered', names: 'R4' },
  { clause: '(c)', variant: 'vanished', code: 'spec_key_withdrawn', names: 'R3' },
  { clause: '(d)', variant: 'unknown_area', code: 'spec_area_unknown', names: 'astrology' },
  { clause: '(d)', variant: 'missing_tier', code: 'spec_tier_invalid', names: 'spec_tier_invalid' },
  { clause: '(d)', variant: 'fourth_tier', code: 'spec_tier_invalid', names: 'T4' },
];

describe('M421 the specification parsed at save; the semantic representation', () => {
  for (const c of SAVE_DEFECTS) {
    test(`${c.clause} ${c.variant.replaceAll('_', ' ')}: committed as a checkpoint, ${c.code} naming ${c.names} on the save and as the engine's entry`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      const s = await specSaves(fx, p.id, [SPEC, VARIANTS[c.variant]], { close: false });
      const [clean, saved] = s.saves;
      assert.deepEqual(clean.findings ?? [], [], `the reference specification saves clean (${JSON.stringify(clean.findings)})`);
      assert.equal(saved.saved, true, `the variant is committed as a checkpoint (${JSON.stringify(saved)})`);
      assert.match(saved.revision ?? '', /^[0-9a-f]{40}$/, 'the checkpoint names its commit');
      const finding = findingNaming(saved.findings, c.code, c.names);
      assert.ok(finding, `the save answers ${c.code} naming ${c.names} (${JSON.stringify(saved.findings)})`);
      if (c.variant === 'renumbered') {
        assert.deepEqual([finding.subject?.key, finding.subject?.from], ['R5', 'R4'], `the renumbering names the new key and the one it replaced (${JSON.stringify(finding)})`);
      }
      const entries = transcriptEntries(fx.home, s.run.id);
      assert.ok(
        entries.some((e) => e.speaker === 'engine' && ((e.text ?? '').includes(c.code) || (e.text ?? '').includes(c.names))),
        `the finding is the engine's transcript entry (${JSON.stringify(entries.filter((e) => e.speaker === 'engine'))})`,
      );
      const rows = semanticsOf(fx.home, s.run.id);
      assert.equal(rows.length, 2, 'one representation row per save');
      if (c.variant === 'vanished') {
        const r3 = (rows[1].representation?.requirements ?? []).find((r) => r.key === 'R3');
        assert.ok(r3, `the vanished key is kept in the representation, never deleted (${JSON.stringify(rows[1].representation?.requirements?.map((r) => r.key))})`);
        assert.equal(r3.withdrawn, true, `and marked withdrawn (SEAM.md §397) (${JSON.stringify(r3)})`);
      }
    });
  }

  test('(e) a requirement with no criterion and no mark is uncertain and blocks approve; with **Human test.** it is accepted and approved human_test', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const bare = await specSaves(fx, p.id, [VARIANTS.uncertain]);
    assert.ok(findingNaming(bare.saves[0].findings, 'spec_requirement_uncertain', 'R5'), `the save reports R5 uncertain (${JSON.stringify(bare.saves[0].findings)})`);
    const blockers = blockersOf(bare.approval);
    assert.ok(blockers.some((b) => b.startsWith('spec_requirement_uncertain:') && b.includes('R5')), `approve carries spec_requirement_uncertain:R5 (${JSON.stringify(blockers)})`);
    const refused = await answer(fx.engine, p.id, bare.approval, 'approve');
    assert.equal(refused.status, 409, `approving an uncertain requirement is refused (→ ${refused.status} ${refused.text})`);
    assert.deepEqual(specRevisions(fx.home, p.id), [], 'no spec revision');
    // The marked variant, in a new session: no finding naming R5, approve open, R5 human_test.
    const marked = await specSaves(fx, p.id, [VARIANTS.human_test]);
    assert.equal(findingNaming(marked.saves[0].findings, ['spec_requirement_uncertain', 'spec_criterion_mismatch', 'spec_index_invalid'], 'R5'), undefined, `the marked requirement is accepted (${JSON.stringify(marked.saves[0].findings)})`);
    assert.deepEqual(blockersOf(marked.approval), [], 'approve is open');
    await consume(fx, p.id, marked.approval, 'approve');
    const r5 = requirementsOf(fx.home, p.id).find((r) => r.key === 'R5');
    assert.ok(r5, 'R5 is registered');
    assert.equal(r5.human_test, 1, 'R5 carries human_test');
    assert.equal(projectRow(fx.home, p.id).baseline_state, 'spec_ready');
  });

  const INVALID = [
    { variant: 'duplicate_requirement', code: 'spec_requirement_duplicate', names: 'R2' },
    { variant: 'duplicate_criterion', code: 'spec_criterion_duplicate', names: 'R2.1' },
    { variant: 'criterion_index_only', code: 'spec_criterion_mismatch', names: 'R2.2' },
  ];
  for (const c of INVALID) {
    test(`(f) ${c.variant.replaceAll('_', ' ')}: ${c.code} naming ${c.names}; approve carries spec_semantics_invalid and ${c.code}:${c.names}; refused`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      const s = await specSaves(fx, p.id, [VARIANTS[c.variant]]);
      assert.ok(findingNaming(s.saves[0].findings, c.code, c.names), `the save names the defect (${JSON.stringify(s.saves[0].findings)})`);
      assert.ok(s.approval, `the close raised spec_approval (${JSON.stringify(s.closed)})`);
      const blockers = blockersOf(s.approval);
      assert.ok(blockers.includes('spec_semantics_invalid'), `approve carries spec_semantics_invalid (${JSON.stringify(blockers)})`);
      assert.ok(blockers.includes(`${c.code}:${c.names}`), `and the defect, ${c.code}:${c.names} (SEAM.md §398) (${JSON.stringify(blockers)})`);
      const res = await answer(fx.engine, p.id, s.approval, 'approve');
      assert.equal(res.status, 409, `approving is refused while the defect stands (→ ${res.status} ${res.text})`);
      assert.deepEqual(specRevisions(fx.home, p.id), [], 'no spec revision');
    });
  }

  test('(g) criteria reordered without a text change leave the semantic_digest unchanged; a changed statement with every ID unchanged changes it', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [SPEC, VARIANTS.criteria_reordered, VARIANTS.statement_changed], { close: false });
    const rows = semanticsOf(fx.home, s.run.id);
    assert.equal(rows.length, 3, 'one representation per save');
    const [base, reordered, changed] = rows.map((r) => r.semantic_digest);
    for (const d of [base, reordered, changed]) assert.match(d ?? '', /^[0-9a-f]{64}$/, 'each save has a digest');
    assert.notEqual(rows[0].git_blob, rows[1].git_blob, 'the reordered text is another blob');
    assert.equal(reordered, base, 'reordering identified criteria without a change of value changes the digest by nothing');
    assert.notEqual(changed, base, 'a changed requirement statement with every ID unchanged changes the digest');
  });
});
