// M519's finding F1 on the scripted backend (SEAM.md §549; the driver's
// ruling of 2026-10-17 under Sean's delegation, erratum to follow): a design
// whose criteria.json holds checkable kinds and kind `human`, the Spec
// Writer writing the human ones as plain criteria, the Verifier's
// correction covering only the checkable ones. Shared by M505 and M507.
//
// Store and route reads only; nothing here starts, stops or signals anything.

import { withStore } from '../store.mjs';
import { CORRECTION_FILES, CRITERIA, DESIGN_CRITERIA_IDS, specV2For } from './reference.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const parse = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);

// Two design criteria of kind `human` (D7 §7.2: "nothing; judged by a
// person"), one per target, under the UI requirements, written by the Spec
// Writer one-shot as ordinary criteria (R2.4 and R3.3), exactly as M519's
// R6.1, R7.1 and R8.20 were: nothing in the specification's wording marks
// them; only the design's criterion map and criteria.json carry the kind.
export const HUMAN_KIND = Object.freeze([
  { requirement: 'R2', text: 'Given the web page, when a person reads the list, then it looks calm and uncluttered in both themes.', kind: 'human', targets: ['web'] },
  { requirement: 'R3', text: 'Given the Android app, when a person adds an item, then the flow feels like a native Android app.', kind: 'human', targets: ['android'] },
]);
export const CRITERIA_WITH_HUMAN = Object.freeze({ ...CRITERIA, criteria: [...CRITERIA.criteria, ...HUMAN_KIND] });
export const V2_WITH_HUMAN = specV2For({ criteria: CRITERIA_WITH_HUMAN });
// The specification's ids: the checkable criteria the correction covers
// (R2.2, R2.3, R3.2, as the reference's CORRECTION_FILES), and the human ones.
export const CHECKABLE_IDS = Object.freeze([DESIGN_CRITERIA_IDS.tokens, DESIGN_CRITERIA_IDS.parityWeb, DESIGN_CRITERIA_IDS.parityAndroid].sort());
export const HUMAN_KIND_IDS = Object.freeze({ web: 'R2.4', android: 'R3.3' });
export const HUMAN_IDS = Object.freeze(Object.values(HUMAN_KIND_IDS).sort());

// The fixture is live: version 2's text holds the human-kind criteria as
// ordinary criteria of R2 and R3 (no human-test mark on them).
export function assertV2Shape(assert) {
  const r2 = V2_WITH_HUMAN.requirements.find((r) => r.key === 'R2');
  const r3 = V2_WITH_HUMAN.requirements.find((r) => r.key === 'R3');
  assert.deepEqual(r2.criteria.map((c) => c.id), ['R2.1', 'R2.2', 'R2.3', 'R2.4'], 'the fixture: R2.4 the web human-kind criterion');
  assert.deepEqual(r3.criteria.map((c) => c.id), ['R3.1', 'R3.2', 'R3.3'], 'the fixture: R3.3 the android human-kind criterion');
  assert.ok(!r2.human_test && !r3.human_test, 'the fixture: R2 and R3 are not human-test requirements');
}

// The design's change request and its correction (D6 §4.5): the request
// with source `design`, its impact parsed; the `check_correction` the
// change registered (`spec_obligation`, the request), with its trigger
// evidence parsed; that correction's protected proposals.
export function designChange(home, project) {
  const r = rows(home, `SELECT * FROM "spec_change_requests" WHERE "project" = ? AND "source" = 'design' ORDER BY rowid DESC LIMIT 1`, project)[0] ?? null;
  if (!r) return null;
  const item = rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'check_correction' AND "trigger_source" = 'spec_obligation' AND "trigger_id" = ? ORDER BY "seq" DESC LIMIT 1`, project, r.id)[0] ?? null;
  const proposals = item
    ? rows(home, `SELECT p."id", p."status", p."requested_change_kind" FROM "protected_proposals" p JOIN "runs" u ON u."id" = p."run" WHERE u."work_item" = ? ORDER BY p.rowid`, item.id)
    : [];
  return {
    request: r,
    impact: parse(r.impact_value),
    correction: item ? { ...item, trigger_evidence: parse(item.trigger_evidence) } : null,
    proposals,
  };
}

// Every check of the project (any protected version) covering `id`.
export const checksCovering = (home, project, id) =>
  rows(home, 'SELECT "key", "criteria" FROM "checks" WHERE "project" = ?', project).filter((c) => (parse(c.criteria) ?? []).includes(id)).map((c) => c.key);

// The approved revision's criterion map (`design_revisions.criterion_map`).
export const criterionMapOf = (home, project) => parse(rows(home, `SELECT "criterion_map" FROM "design_revisions" WHERE "project" = ? AND "status" = 'approved' ORDER BY rowid DESC LIMIT 1`, project)[0]?.criterion_map ?? null) ?? [];

// Each gate evaluation's ACCEPTANCE_SCOPE_INCOMPLETE subjects that are among `ids`:
// [{gate_kind, stage, scope, named}], only those naming one.
export function scopeIncompleteNaming(home, project, ids, { afterRowid = 0 } = {}) {
  return rows(home, 'SELECT rowid AS r, "gate_kind", "stage", "scope", "reasons" FROM "gate_evaluations" WHERE "project" = ? AND rowid > ? ORDER BY rowid', project, afterRowid)
    .map((e) => {
      const reasons = parse(e.reasons) ?? [];
      const named = reasons.filter((x) => x?.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((x) => (x.subjects ?? []).filter((s) => ids.includes(s)));
      return { gate_kind: e.gate_kind, stage: e.stage, scope: e.scope, named };
    })
    .filter((e) => e.named.length > 0);
}

// The facts of a readiness that did not come, for a failure's message.
export function readinessFacts(home, project) {
  const c = designChange(home, project);
  return JSON.stringify({
    revisions: rows(home, 'SELECT "id", "version", "status", "ready_at" FROM "design_revisions" WHERE "project" = ? ORDER BY rowid', project),
    impact_uncovered: c?.impact?.checks?.uncovered ?? null,
    correction: c?.correction ? { id: c.correction.id, status: c.correction.status, held: c.correction.held, uncovered: c.correction.trigger_evidence?.criteria?.uncovered ?? null } : null,
    proposals: c?.proposals ?? [],
    held: rows(home, `SELECT "id", "held" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' AND "held" IS NOT NULL`, project),
    open: rows(home, `SELECT "kind", "id" FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY rowid`, project),
  });
}

// ---- the coordinator's three further cases (SEAM.md §549, "further") -------------------------------

// A correction that covers R2.3 and R3.2 and leaves the checkable R2.2
// (tokens_only) uncovered: the reference's correction without the tokens
// check and its definition.
export const CORRECTION_WITHOUT_TOKENS = Object.freeze(
  Object.fromEntries(Object.entries(CORRECTION_FILES).filter(([path]) => !path.includes('tokens'))),
);

// The spoof: under R2 a checkable criterion (tokens_only) and a human one,
// in that order in criteria.json; the Spec Writer rewords both and writes
// them in the swapped order, so that no text matches and the criteria
// pair by position the wrong way round. R3's parity criterion is kept
// verbatim. In version 2, R2.2 is the reworded HUMAN criterion and R2.3
// the reworded CHECKABLE one: R2.3 must stay uncovered and owed.
export const SPOOF_CHECKABLE = Object.freeze({ ...CRITERIA.criteria[0] });
export const SPOOF_HUMAN = Object.freeze({ requirement: 'R2', text: 'Given the web page, when a person reads the list, then it looks calm and uncluttered in both themes.', kind: 'human', targets: ['web'] });
export const SPOOF_CRITERIA = Object.freeze({ ...CRITERIA, criteria: [SPOOF_CHECKABLE, SPOOF_HUMAN, CRITERIA.criteria[2]] });
export const SPOOF_V2 = specV2For({
  criteria: {
    ...CRITERIA,
    criteria: [
      { requirement: 'R2', text: 'Given the web page in either theme, a person judging it finds the list calm and free of clutter.' },
      { requirement: 'R2', text: 'Given the web module, web/app.css uses only custom properties from web/tokens.css for colours, sizes, spacing, radii and durations, with no literal values.' },
      CRITERIA.criteria[2],
    ],
  },
});
export const SPOOF_IDS = Object.freeze({ human: 'R2.2', checkable: 'R2.3' });
