// M403, a specification whose save found a defect cannot be approved (slice
// 31, the 31a review's S3; kernel lane). D6 §3.2, §3.4 (`spec_approval`'s
// `approve` carries option blockers, D1 §9.7), A.6 `spec_semantics_invalid`;
// the driver's ruling Q4 (slice 31's parse depth: B.2's forms, index and
// subsection consistency, criterion or mark, the closed areas, the tier);
// SEAM.md §§346, 365.
//
// Three specifications, each saved once by a Spec Writer session and closed:
//   - R1's subsection naming a mistyped sensitive area (`secret_credentials`);
//   - R1's subsection with an empty sensitive-areas line (neither an area nor
//     `none`);
//   - an index row (R5) with no subsection in §4.
// Each save answers the finding; the close raises `spec_approval` whose
// `approve` carries a blocker naming it; answering `approve` is refused and
// nothing is approved. The mistyped area is never silently dropped: a
// readable representation of the save keeps it on R1.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decisionsOfKind } from './harness/decisions.mjs';
import { createWithIdea, projectRow, specRevisions, specSession } from './harness/journey/drive.mjs';
import { REQUIREMENTS, SPEC, specText } from './harness/journey/reference.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

// R1's subsection is the first `**Sensitive areas:** none` of §4.
const r1Areas = (value) => {
  const at = SPEC.indexOf('**Sensitive areas:** none');
  assert.ok(at > 0, 'the fixture is live: R1 has a sensitive-areas line');
  return `${SPEC.slice(0, at)}**Sensitive areas:**${value === '' ? '' : ` ${value}`}${SPEC.slice(at + '**Sensitive areas:** none'.length)}`;
};
const MISTYPED = 'secret_credentials';
const CASES = [
  { name: 'a mistyped sensitive area', spec: r1Areas(MISTYPED), codes: ['spec_area_unknown'], names: MISTYPED },
  { name: 'an empty sensitive-areas line', spec: r1Areas(''), codes: ['spec_area_unknown', 'spec_areas_missing'], names: 'R1' },
  {
    name: 'an index row with no subsection',
    spec: specText({ index: [...REQUIREMENTS, { key: 'R5', title: 'An extra row', phase: 2, criteria: [{ id: 'R5.1', text: 'x' }] }] }),
    codes: ['spec_row_unmatched', 'spec_requirement_unindexed'],
    names: 'R5',
  },
];

const latestSemantics = (home, run) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "spec_semantics" WHERE "run" = ? ORDER BY rowid DESC LIMIT 1').get(run));
  return row ? { ...row, representation: row.representation ? JSON.parse(row.representation) : null } : null;
};

describe('M403 spec_approval is blocked by the findings of slice 31\'s parse depth', () => {
  for (const c of CASES) {
    test(`(S3) ${c.name}: the save names it, approve carries a blocker naming it and is refused, nothing is approved`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      const s = await specSession(fx, p.id, { first: c.spec, second: c.spec, answer: false });
      const findings = s.saves[0].findings ?? [];
      assert.ok(findings.some((f) => c.codes.includes(f.code) && JSON.stringify(f).includes(c.names)), `the save answers ${c.codes.join(' or ')} naming ${c.names} (${JSON.stringify(findings)})`);
      assert.equal(s.decisions.length, 1, `the close raised spec_approval (${JSON.stringify(s.closed)})`);
      const [row] = decisionsOfKind(fx.home, p.id, 'spec_approval');
      const approve = row.options.find((o) => o.key === 'approve');
      const blockers = approve?.blockers ?? [];
      assert.ok(blockers.some((b) => b === 'spec_semantics_invalid' || c.codes.includes(b) || JSON.stringify(b).includes(c.names)), `approve carries a blocker naming the finding (options ${JSON.stringify(row.options)})`);
      const res = await answer(fx.engine, p.id, row, 'approve');
      assert.equal(res.status, 409, `approving is refused (→ ${res.status} ${res.text})`);
      assert.deepEqual(specRevisions(fx.home, p.id), [], 'no spec revision');
      assert.notEqual(projectRow(fx.home, p.id).baseline_state, 'spec_ready', 'the baseline is not spec_ready');
      if (c.names === MISTYPED) {
        const sem = latestSemantics(fx.home, s.run.id);
        assert.ok(sem, 'the save recorded its semantics');
        if (sem.readable === 1 && sem.representation) {
          const r1 = (sem.representation.requirements ?? []).find((r) => r.key === 'R1');
          assert.ok((r1?.sensitive_areas ?? []).includes(MISTYPED), `the readable representation keeps the unknown area on R1, never silently dropping it (${JSON.stringify(r1)})`);
        }
      }
    });
  }
});
