// M233, the requirement index (M3 slice 20, validation scope; kernel lane).
// M3 plan §3.6 M233 and question 4 (decided (a), E92 item 2: the parser is
// built, and the plan fixture registers through it); D3 §4.5; D3-S05;
// SEAM.md §§179, 223.
//
// The index of the spec template's section 5 registers exactly the
// requirements' criteria and sensitive areas it lists: a row with two
// criteria, a row with two areas, a row with no criterion (which registers
// none: the requirement is uncertain, row M229). Each malformed case refuses
// the whole index, names the row, and installs nothing: a row that does not
// parse (four cells; a key that is not R<n>), an area outside the closed
// list, a criterion that is not of its requirement's key, a repeated
// criterion. The bad row is the second of three, so naming it is not
// naming the first or the last.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const HEADER = ['| Key | Title | Phase | Sensitive areas | Criteria |', '|---|---|---|---|---|'];
const index = (...rows) => `${[...HEADER, ...rows].join('\n')}\n`;
const plan = (engine, project, text) => engine.post('/v1/harness/fixtures/plan', { project, requirement_index: text, stages: [{ number: 1, goal: 'the first stage', implements: [] }] });

const requirementsOf = (home, project) =>
  withStore(home, (db) =>
    db
      .prepare('SELECT "key", "criteria", "sensitive_areas" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
      .all(project)
      .map((r) => ({ key: r.key, criteria: JSON.parse(r.criteria ?? 'null'), sensitive_areas: JSON.parse(r.sensitive_areas) })),
  );
const countOf = (home, table, project) => withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "project" = ?`).get(project).n);

describe('M233 the requirement index registers exactly its criteria and areas', () => {
  test('well-formed rows: each requirement takes the criteria and areas its row lists, in the row\'s order, and nothing else', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { tier: 'T1' });
    const res = await plan(
      fx.engine,
      project.id,
      index('| R1 | Sign in | 1 | none | R1.1, R1.2 |', '| R2 | Pay | 1 | payments_financial_data, personal_data | R2.1 |', '| R3 | Help pages | 2 | none |  |'),
    );
    assert.equal(res.status, 201, `the index is registered (body: ${res.text})`);
    const expected = [
      { key: 'R1', criteria: ['R1.1', 'R1.2'], sensitive_areas: [] },
      { key: 'R2', criteria: ['R2.1'], sensitive_areas: ['payments_financial_data', 'personal_data'] },
      { key: 'R3', criteria: [], sensitive_areas: [] },
    ];
    assert.deepEqual(
      res.body.requirements.map((r) => ({ key: r.key, criteria: r.criteria, sensitive_areas: r.sensitive_areas })),
      expected,
      'the answer names each requirement with exactly its row\'s criteria and areas (SEAM.md §179)',
    );
    assert.deepEqual(requirementsOf(fx.home, project.id), expected, 'and so does the store: requirements.criteria and requirements.sensitive_areas (D3 A.3)');
  });
});

describe('M233 each malformed index is refused, naming its row, and installs nothing', () => {
  const GOOD_FIRST = '| R1 | Sign in | 1 | none | R1.1 |';
  const GOOD_LAST = '| R3 | Help pages | 2 | none | R3.1 |';
  const CASES = [
    ['a row that does not parse: four cells', '| R2 | Pay | 1 | none |'],
    ['a row that does not parse: a key that is not R<n>', '| Q2 | Pay | 1 | none | Q2.1 |'],
    ['an unknown area', '| R2 | Pay | 1 | biometrics | R2.1 |'],
    ["a criterion that is not of its requirement's key", '| R2 | Pay | 1 | none | R3.1 |'],
    ['a repeated criterion', '| R2 | Pay | 1 | none | R2.1, R2.1 |'],
  ];
  test('four cells, a key that is not R<n>, an unknown area, a foreign criterion, a repeated criterion: 400 invalid_value naming requirement_index and row 2, and nothing installed', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { tier: 'T1' });
    const before = { requirements: countOf(fx.home, 'requirements', project.id), stages: countOf(fx.home, 'stages', project.id), work: countOf(fx.home, 'work_items', project.id) };
    for (const [what, bad] of CASES) {
      const res = await plan(fx.engine, project.id, index(GOOD_FIRST, bad, GOOD_LAST));
      assert.equal(res.status, 400, `${what}: refused (body: ${res.text})`);
      assert.equal(res.body?.code, 'invalid_value', `${what}: invalid_value`);
      assert.deepEqual(
        [res.body?.subject?.field, res.body?.subject?.row, res.body?.subject?.text],
        ['requirement_index', 2, bad],
        `${what}: the refusal names the index and its second requirement row, with that row's text (SEAM.md §223) (subject: ${JSON.stringify(res.body?.subject)})`,
      );
      const after = { requirements: countOf(fx.home, 'requirements', project.id), stages: countOf(fx.home, 'stages', project.id), work: countOf(fx.home, 'work_items', project.id) };
      assert.deepEqual(after, before, `${what}: nothing was installed: no requirement, stage or work item`);
    }
    // The control: the same index with the second row well formed is registered.
    const good = await plan(fx.engine, project.id, index(GOOD_FIRST, '| R2 | Pay | 1 | none | R2.1 |', GOOD_LAST));
    assert.equal(good.status, 201, `the control: with row 2 well formed the index is registered (body: ${good.text})`);
    assert.deepEqual(requirementsOf(fx.home, project.id).map((r) => [r.key, r.criteria]), [['R1', ['R1.1']], ['R2', ['R2.1']], ['R3', ['R3.1']]]);
  });
});
