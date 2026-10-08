// Helpers for the M3 rows of slice 21, repair and findings (M234 to M237;
// SEAM.md §§228 to 234): projects whose checks are discovered, a stage's
// Builder scripted across its runs, the repair a failed repair check sends
// back (D3 §2.10), the X2 blocker of a conflict (D3 §5 X2), and the reads of
// the work events, the findings and the evaluation's missing verifications
// (D3 §2.11).
//
// Kernel lane, as slices 16 to 20: the nomination registers the required
// checks and admits none (SEAM.md §177); a case moves each execution through
// the scripted check boundary (SEAM.md §190), the engine's own transition,
// or records a result with the check-result fixture (SEAM.md §67).

import assert from 'node:assert/strict';

import { openDecision } from '../decisions.mjs';
import { permittedEdit, roleThat, waitForCandidates } from '../gitruns.mjs';
import { runsOf, tickUntil, workItem } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { checkIds, def, scopeProject } from './scope.mjs';

export { checkIds, def };

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);

// The options of the blocker D3 §5 X2 raises, sorted.
export const X2_OPTIONS = Object.freeze(['cancel', 'change_spec', 'correct_check', 'retry']);

// A T1 project whose checks are discovered: `acc` (acceptance, covering
// R1.1) and `smoke`, both at both gates, and the plan's one stage
// implementing R1 (criterion R1.1). `defs`, `index` and `stages` replace them.
export const ACC_SMOKE = Object.freeze({ acc: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke') });

export async function repairProject(fx, { tier = 'T1', defs = ACC_SMOKE, governed, index = [{ key: 'R1', criteria: ['R1.1'] }], stages = [{ number: 1, goal: 'the first stage', implements: ['R1'] }], files } = {}) {
  return scopeProject(fx, { tier, defs, governed, index, stages, files });
}

// The registrations of a candidate by one trigger source, {key: execution row}.
export function registrationsBy(home, candidate, source = 'nomination') {
  const rows = withStore(home, (db) =>
    db
      .prepare(`SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."candidate" = ? ORDER BY x."execution_seq"`)
      .all(candidate),
  );
  const out = {};
  for (const r of rows) if (json(r.trigger)?.source === source) out[r.key] = { ...r, trigger: json(r.trigger) };
  return out;
}

// The stage's Builder runs `scripts` in turn (the first, by default, writes
// the permitted edit and asks for the nomination). Ticks until the first run
// has ended, the first candidate exists and its nomination has registered
// every key of `keys`. Returns {item, run, candidate, reg: {key: execution}}.
export async function buildAndNominate(fx, p, { stage = 0, scripts = [roleThat([permittedEdit()], { nominate: true })], keys = ['acc', 'smoke'] } = {}) {
  const item = p.stages[stage].work_item;
  fx.scripted.script(item, scripts);
  const run = await tickUntil(fx.engine, p.id, () => (runsOf(fx.home, item)[0]?.state === 'ended' ? runsOf(fx.home, item)[0] : undefined), { what: "the stage's first Builder run to end" });
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the fixture is live: the stage's Builder run was accepted (${run.reason_text})`);
  const [candidate] = await waitForCandidates(fx, p.id);
  const reg = await tickUntil(
    fx.engine,
    p.id,
    () => {
      const r = registrationsBy(fx.home, candidate.id);
      return keys.every((k) => r[k]) ? r : undefined;
    },
    { max: 6, what: `the nomination to register ${keys.join(', ')}` },
  );
  return { item, run, candidate, reg };
}

// The next candidate of the project, nominated after `count` candidates exist.
export const nthCandidate = async (fx, project, n) => (await waitForCandidates(fx, project, n))[n - 1];

// ---- work events and the repair ---------------------------------------------------------

// Every work.* event of one item, in order, with subject and payload parsed.
export const workEvents = (home, item) =>
  withStore(home, (db) =>
    db.prepare(`SELECT * FROM "events" WHERE "type" LIKE 'work.%' AND json_extract("subject", '$.work_item') = ? ORDER BY "seq"`).all(item),
  ).map((e) => ({ ...e, subject: json(e.subject), payload: json(e.payload) }));

// The item's steps from `from` to `to` (SEAM.md §15: payload.from, payload.to).
export const stepsOf = (home, item, from, to) => workEvents(home, item).filter((e) => e.payload?.from === from && e.payload?.to === to);

// The repairs D3 §2.10 took: the item's steps verifying → eligible.
export const repairsOf = (home, item) => stepsOf(home, item, 'verifying', 'eligible');

// The work item with its JSON columns parsed.
export function itemRow(home, item) {
  const row = workItem(home, item);
  return row ? { ...row, subject: json(row.subject), blocker: json(row.blocker), check_repair: json(row.check_repair) } : null;
}

// The check.result event of a result, by its check_results id.
export const resultEvent = (home, resultId) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "events" WHERE "type" = 'check.result' ORDER BY "seq"`).all())
    .map((e) => ({ ...e, subject: json(e.subject), payload: json(e.payload) }))
    .find((e) => Object.values(e.subject ?? {}).includes(resultId) || Object.values(e.payload ?? {}).includes(resultId));

// The launches of an item's runs, in order (the scripted log, SEAM.md §13).
export const launchesOf = (fx, item) => fx.scripted.launches({ work_item: item });

// What a launch request carried as `check_outputs` (SEAM.md §229), sorted by key.
export function checkOutputs(launch) {
  assert.ok(launch, 'the repair run was launched');
  const outputs = launch.check_outputs;
  assert.ok(Array.isArray(outputs), `the repair run's launch request carries check_outputs (SEAM.md §229) (got ${JSON.stringify(outputs)})`);
  return [...outputs].sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

// The output record a result names.
export const outputOf = (home, resultId) => withStore(home, (db) => db.prepare('SELECT "output" FROM "check_results" WHERE "id" = ?').get(resultId))?.output ?? null;

// ---- decisions --------------------------------------------------------------------------

export const openBlockers = (home, item) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open' ORDER BY "id"`).all(item)).map((row) => ({
    ...row,
    options: json(row.options),
  }));

export const optionKeys = (row) => (row.options ?? []).map((o) => o.key).sort();

// The X2 blocker about the item, open (D3 §5 X2; SEAM.md §232).
export async function x2Blocker(fx, project, item) {
  const row = await openDecision(fx, project, 'blocker', item);
  assert.deepEqual(optionKeys(row), [...X2_OPTIONS], `the blocker about ${item} offers exactly correct_check, change_spec, retry and cancel (D3 §5 X2) (it offers ${JSON.stringify(optionKeys(row))})`);
  return row;
}

// Every X2 blocker of the project, open or not.
export const x2Blockers = (home, project) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "project" = ? ORDER BY "id"`).all(project))
    .map((row) => ({ ...row, options: json(row.options) }))
    .filter((row) => optionKeys(row).includes('correct_check'));

// ---- findings and the work they route -------------------------------------------------------

export const findingRow = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "findings" WHERE "id" = ?').get(id));
  return row ? { ...row, resolution_verification: json(row.resolution_verification) } : null;
};

export const findingsBy = (home, project, where) => withStore(home, (db) => db.prepare('SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"').all(project)).filter(where);

// Work items of a kind whose trigger or subject names the finding (D3 §2.11, §5 X2; SEAM.md §§231, 232).
export const workFor = (home, project, kind, finding) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"').all(project, kind))
    .map((w) => ({ ...w, subject: json(w.subject), blocker: json(w.blocker) }))
    .filter((w) => w.trigger_id === finding || w.subject?.finding === finding);

export const ofKind = (home, project, kind) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"').all(project, kind)).map((w) => ({ ...w, subject: json(w.subject) }));

// The requirements of a project as the index registered them: what "the spec" is for these rows.
export const requirementsOf = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT "id", "key", "criteria", "sensitive_areas" FROM "requirements" WHERE "project" = ? ORDER BY "key"').all(project));

// The evaluation's missing verifications (SEAM.md §231), by finding.
export function missingVerifications(evaluation, what) {
  assert.ok(Array.isArray(evaluation.missing_verifications), `${what}: the evaluation carries missing_verifications (SEAM.md §231) (keys: ${Object.keys(evaluation).join(', ')})`);
  return evaluation.missing_verifications;
}

export const missingFor = (evaluation, finding) => (evaluation.missing_verifications ?? []).filter((m) => m.finding === finding);
