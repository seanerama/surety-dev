// Slice 34's specifications and the shared steps of its files (SEAM.md
// §§396 to 403): variants of the reference project's specification in TPL's
// shape (`reference.mjs`'s `specText`), each changing one thing the engine's
// parse at save, the semantic representation (D6 §3.2, B.2; B04) or
// `spec_approval`'s option blockers (D6 §3.4; reading 1) must see; a Spec
// Writer session that saves each text in turn; the readers of
// `spec_semantics` and of an option's blockers. Kernel lane only: nothing
// here starts a process but the test's own engine and its scripted roles.

import assert from 'node:assert/strict';

import { decision, decisionsOfKind } from '../decisions.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from '../sessions.mjs';
import { withStore } from '../store.mjs';
import { REQUIREMENTS, specText } from './reference.mjs';

export const SPEC_PATH = '.surety/spec/spec.md';
const req = (key) => REQUIREMENTS.find((r) => r.key === key);

// ---- text transforms ------------------------------------------------------------------------------

// TPL §10 with these list items in place of "None.".
export function withQuestions(spec, items) {
  const at = spec.indexOf('## 10. Open questions\n\nNone.\n');
  assert.ok(at > 0, 'the fixture is live: §10 reads "None."');
  return `${spec.slice(0, at)}## 10. Open questions\n\n${items.map((q) => `- ${q}`).join('\n')}\n${spec.slice(at + '## 10. Open questions\n\nNone.\n'.length)}`;
}

// The header without its Tier line, or with another value.
export const withoutTier = (spec) => spec.replace(/\*\*Tier:\*\* [^\n]*\n/, '');

// §7 in B.2's form: each environment a subsection with D4's fields (TPL §7).
export function withEnvironmentSubsection(spec) {
  const start = spec.indexOf('## 7. Environments\n');
  const end = spec.indexOf('## 8. Constraints\n');
  assert.ok(start > 0 && end > start, 'the fixture is live: §7 and §8');
  const section = [
    '## 7. Environments',
    '',
    '### alpha',
    '',
    '- **Purpose:** the owner\'s test target',
    '- **Verified means:** the post-deploy behaviour check passes against it',
    '- **Target:** `local_service`, target `app`.',
    '- **Runtime and start command:** `node server.mjs`.',
    '- **Port:** `PORT`.',
    '- **Excluded from the artifact:** none.',
    '- **Required post-deploy behaviour check:** GET /sum?a=2&b=3 answers 200 {"sum": 5}.',
    '- **Stable arguments:** the service does not change its process title or arguments.',
    '',
    '',
  ].join('\n');
  return `${spec.slice(0, start)}${section}${spec.slice(end)}`;
}

// A requirement R5 of phase 2 in `lib`, with no criterion; with the
// `**Human test.**` mark when `mark` (TPL §4's form), else unmarked.
export const R5 = Object.freeze({ key: 'R5', title: 'A readable count', phase: 2, module: 'lib', statement: 'The workshop organizer can read the count on the dashboard at a glance.', criteria: [] });
export function withR5({ mark }) {
  const spec = specText({ requirements: [...REQUIREMENTS, R5] });
  const heading = '### R5. A readable count';
  const at = spec.indexOf(heading);
  const criteria = spec.indexOf('**Acceptance criteria**\n\n', at);
  assert.ok(at > 0 && criteria > at, 'the fixture is live: R5 has its subsection');
  const replacement = mark ? '**Human test.**\n\nA person opens the dashboard and sees the count in large type.\n' : '';
  return `${spec.slice(0, criteria)}${replacement}${spec.slice(criteria + '**Acceptance criteria**\n\n'.length)}`;
}

// The reference requirements with `changes` applied by key ({key: {...}}).
export const requirementsWith = (changes) => REQUIREMENTS.map((r) => (changes[r.key] ? { ...r, ...changes[r.key] } : r));

// ---- the variants (each one change against `SPEC`) ------------------------------------------------

export const VARIANTS = Object.freeze({
  // M421 (a): a row whose phase is not a number.
  index_row_unparsable: specText().replace('| R2 | Sum through the service | 1 | none |', '| R2 | Sum through the service | one | none |'),
  // M421 (b): R4 in §4 with no row; a row R6 with no subsection.
  requirement_without_row: specText({ index: REQUIREMENTS.filter((r) => r.key !== 'R4') }),
  row_without_subsection: specText({ index: [...REQUIREMENTS, { key: 'R6', title: 'An extra row', phase: 2, criteria: [{ id: 'R6.1', text: 'x' }] }] }),
  // M421 (c): R4 renumbered R5 (statement and criterion text unchanged); R3 vanished.
  renumbered: specText({ requirements: REQUIREMENTS.map((r) => (r.key === 'R4' ? { ...r, key: 'R5', criteria: r.criteria.map((c) => ({ ...c, id: 'R5.1' })) } : r)) }),
  vanished: specText({ requirements: REQUIREMENTS.filter((r) => r.key !== 'R3') }),
  // M421 (d): an area outside the closed list in R1's subsection; a missing tier; a fourth tier.
  unknown_area: specText().replace('**Sensitive areas:** none', '**Sensitive areas:** astrology'),
  missing_tier: withoutTier(specText()),
  fourth_tier: specText({ tier: 'T4' }),
  // M421 (e): R5 with no criterion, unmarked and marked.
  uncertain: withR5({ mark: false }),
  human_test: withR5({ mark: true }),
  // M421 (f): two `### R2` headings; R2.1 twice in R2; R2.2 in the index, absent from §4.
  duplicate_requirement: specText({ requirements: [...REQUIREMENTS, { ...req('R2'), title: 'Sum through the service, again' }], index: REQUIREMENTS }),
  duplicate_criterion: specText({ requirements: requirementsWith({ R2: { criteria: [...req('R2').criteria, { id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=1&b=1, then it answers 200.' }] } }), index: REQUIREMENTS }),
  criterion_index_only: specText({ requirements: requirementsWith({ R2: { criteria: req('R2').criteria.slice(0, 1) } }), index: REQUIREMENTS }),
  // M421 (g): R2's criteria reordered, text unchanged; R1's statement changed, every ID unchanged.
  criteria_reordered: specText({ requirements: requirementsWith({ R2: { criteria: [...req('R2').criteria].reverse() } }), index: REQUIREMENTS }),
  statement_changed: specText({ requirements: requirementsWith({ R1: { statement: 'The library sums two numbers exactly and returns a number, as a pure function with no state.' } }) }),
});

// M422 (a) and M449 (a): §10's questions. Q1 blocks R1 (phase 1) or R3
// (phase 2); `(phase n)` is the hint (B.2).
export const Q = Object.freeze({
  blocksPhaseOne: 'Q1 Should the sum of R1 be rounded to two places? Owner: Sean. (phase 1)',
  blocksPhaseTwoHinted: 'Q1 Does R3 count a refused sum? Owner: Sean. (phase 2)',
  blocksPhaseTwoNoHint: 'Q2 Does R3 count a refused sum? Owner: Sean.',
  blocksR4NoHint: 'Q2 Does R4 report the count since the process started or since midnight? Owner: Sean.',
});
// R3's index row with its phase cell empty (D3 §4.5 reads an empty phase as none).
export const withoutPhaseOf = (key) => specText({ index: REQUIREMENTS.map((r) => (r.key === key ? { ...r, phase: '' } : r)) });

// ---- a Spec Writer session saving each text in turn ----------------------------------------------

// One Spec Writer session: a turn writing each text and a save after it;
// `close`: close at the end (the decision raised is returned). The parse at
// save is read from each save's answer and from `spec_semantics`.
export async function specSaves(fx, project, texts, { close = true } = {}) {
  const run = await openSession(fx, project, 'spec_writer');
  scriptTurns(fx, run.id, texts.map((text, i) => turnThatWrites({ [SPEC_PATH]: text }, { reply: `Draft ${i + 1}.`, done: i === texts.length - 1 })));
  const saves = [];
  for (let i = 0; i < texts.length; i++) {
    await sayAndSettle(fx, project, run.id, `Write draft ${i + 1}.`);
    saves.push(await saveSession(fx, project, run.id));
  }
  let closed = null;
  let approval = null;
  if (close) {
    closed = await closeSession(fx, project, run.id);
    const raised = (closed.decisions ?? []).find((d) => d.kind === 'spec_approval');
    approval = raised ? decision(fx.home, raised.id) : null;
  }
  return { run, saves, closed, approval };
}

// ---- readers ---------------------------------------------------------------------------------------

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// In insertion order (rowid), never by wall time (the driver's ruling, SEAM §425).
export const semanticsOf = (home, run) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "spec_semantics" WHERE "run" = ? ORDER BY rowid').all(run)).map((r) => ({
    ...r,
    representation: r.representation ? parse(r.representation) : null,
    findings: parse(r.findings ?? '[]'),
  }));

// A finding of `code` that names `name` anywhere in it (SEAM.md §346: {code, path, subject, message}).
export const findingNaming = (findings, code, name) => (findings ?? []).find((f) => [code].flat().includes(f.code) && JSON.stringify(f).includes(name));

// The current `spec_approval` row of the project (the open one, else the latest).
export function specApproval(home, project) {
  const rows = decisionsOfKind(home, project, 'spec_approval');
  return rows.find((r) => r.status === 'open') ?? rows.at(-1) ?? null;
}
// The blockers of an option, as the strings `CODE:subject…` (SEAM.md §398).
export function blockersOf(row, option = 'approve') {
  const o = (row?.options ?? []).find((x) => x.key === option);
  assert.ok(o, `the decision offers ${option} (${JSON.stringify(row?.options)})`);
  return (o.blockers ?? []).map((b) => (typeof b === 'string' ? b : JSON.stringify(b)));
}

// ---- TPL §11, the engine's change log row (SEAM.md §399) --------------------------------------------

// The §11 rows of `text` for `version` (all rows when it is omitted).
export function logRows(text, version) {
  const at = text.indexOf('## 11. Change log');
  assert.ok(at > 0, 'the specification has §11');
  return text
    .slice(at)
    .split('\n')
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .filter((l) => version === undefined || new RegExp(`^\\|\\s*${version}\\s*\\|`).test(l));
}
// `text` with every §11 row for `version` removed.
export const withoutLogRow = (text, version) => {
  const rows = new Set(logRows(text, version));
  return text
    .split('\n')
    .filter((l) => !rows.has(l))
    .join('\n');
};
// The engine's row: `| n | <date> | First approved version | human |` at a
// session's approval, `| n | <date> | Specification change <seq> | human |`
// at a change's.
export const ENGINE_ROW = Object.freeze({
  approval: (version) => new RegExp(`^\\|\\s*${version}\\s*\\|\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\|\\s*First approved version\\s*\\|\\s*human\\s*\\|\\s*$`),
  change: (version, seq) => new RegExp(`^\\|\\s*${version}\\s*\\|\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\|\\s*Specification change ${seq}\\s*\\|\\s*human\\s*\\|\\s*$`),
});
// The specification at `head` is `saved` with its row for `version` the engine's, and nothing else changed.
export function assertEngineRow(actual, saved, version, pattern, what = 'the specification') {
  const rows = logRows(actual, version);
  assert.equal(rows.length, 1, `${what}: one §11 row for version ${version} (${JSON.stringify(logRows(actual))})`);
  assert.match(rows[0], pattern, `${what}: the row is the engine's`);
  assert.equal(withoutLogRow(actual, version), withoutLogRow(saved, version), `${what}: nothing but that row differs from what was saved`);
}

// ---- the slice-34 review's rulings (SEAM.md §405) ---------------------------------------------------

// R1 with a second criterion; R1.2 moved to R4 as R4.2 (same text); R1.2
// renumbered R1.3 within R1 (same text).
export const R1_2 = Object.freeze({ id: 'R1.2', text: 'Given the numbers 0.5 and 0.25, when `sum(0.5, 0.25)` is called, then it returns 0.75.' });
export const SPEC_R1_TWO = specText({ requirements: requirementsWith({ R1: { criteria: [...req('R1').criteria, R1_2] } }) });
export const SPEC_R1_2_MOVED = specText({ requirements: requirementsWith({ R4: { criteria: [...req('R4').criteria, { id: 'R4.2', text: R1_2.text }] } }) });
export const SPEC_R1_2_RENUMBERED = specText({ requirements: requirementsWith({ R1: { criteria: [...req('R1').criteria, { id: 'R1.3', text: R1_2.text }] } }) });
