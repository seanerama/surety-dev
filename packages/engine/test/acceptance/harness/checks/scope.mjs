// Helpers for the M3 rows of slice 20, validation scope (M229 to M233;
// SEAM.md §§221 to 227): projects whose checks are discovered from their
// governed file and definitions, whose approved spec registers a requirement
// index through the plan fixture, and whose plan's modules carry sensitive
// areas and tier overrides; the scope an evaluation was computed over, with
// its sensitivity categories and required sign-offs; the subjects of
// ACCEPTANCE_SCOPE_INCOMPLETE.
//
// Kernel lane. No check runs: the nomination registers the required checks
// and admits none (SEAM.md §177), and a case records each result with the
// check-result fixture, which takes the one sequence and decides over the
// queued registration (SEAM.md §189).

import assert from 'node:assert/strict';

import { postResult, reasonSubjects, scopeOf } from '../gates.mjs';
import { permittedEdit, roleThat } from '../gitruns.mjs';
import { runsOf, tickUntil } from '../runs.mjs';
import { step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { GOVERNED_FILE, KERNEL_COMMANDS, checkProject, defPath, definitionText, governedText, installIndexedPlan } from './fixtures.mjs';

export { GOVERNED_FILE, KERNEL_COMMANDS, defPath };

// ---- definitions ----------------------------------------------------------------------

// The fields of one definition (D3 §1.3, A.4): `criteria` as covers.criteria,
// `areas` as covers.sensitive_areas (kind sensitivity_floor only).
export function def(kind, { criteria, areas, gates = ['stage', 'alpha_authorize'], tier_floor, origin, ...rest } = {}) {
  const fields = { kind, command: ['probe'], timeout_s: 60, gate_kinds: gates };
  if (criteria !== undefined || areas !== undefined) fields.covers = { ...(criteria !== undefined ? { criteria } : {}), ...(areas !== undefined ? { sensitive_areas: areas } : {}) };
  if (tier_floor !== undefined) fields.tier_floor = tier_floor;
  if (origin !== undefined) fields.origin = origin;
  return { ...fields, ...rest };
}

// One required acceptance-origin check of each kind of the tier's inventory
// (D3 §4.3), covering `criteria` where its kind names criteria (D3 §1.3).
export const inventoryDefs = (tier, criteria) => {
  const all = {
    acc: def('acceptance', { criteria }),
    smoke: def('smoke'),
    integ: def('integration', { criteria }),
    lint: def('security_lint'),
    prop: def('property', { criteria }),
    fr: def('failure_recovery', { criteria }),
  };
  const keys = { T1: ['acc', 'smoke'], T2: ['acc', 'smoke', 'integ', 'lint'], T3: ['acc', 'smoke', 'integ', 'lint', 'prop', 'fr'] }[tier];
  return Object.fromEntries(keys.map((k) => [k, all[k]]));
};

// The files of a protected set: the governed file (KERNEL_COMMANDS and
// `governed`), and one definition per key of `defs`.
export function protectedSet(defs, governed = {}) {
  const out = { [GOVERNED_FILE]: governedText({ check_commands: KERNEL_COMMANDS, ...governed }) };
  for (const [key, fields] of Object.entries(defs)) out[defPath(key)] = definitionText(key, fields);
  return out;
}

// ---- projects -----------------------------------------------------------------------------

// A project at `tier` whose first commit holds the protected set and
// `files`, and whose approved spec registers `index` (rows {key, criteria,
// areas?}) with the plan's `stages` (each may list `modules`) and `modules`
// ({name, paths, sensitive_areas?, tier_override?}). Returns {id, repo,
// base, plan, stages}.
export async function scopeProject(fx, { tier = 'T1', defs, governed, files = {}, index, stages, modules }) {
  const p = await checkProject(fx, { files: { ...protectedSet(defs, governed), ...files }, tier });
  const plan = await installIndexedPlan(fx.engine, p.id, { index, stages, modules });
  return { ...p, plan, stages: plan.stages };
}

// Every stage of the plan built: stage n's Builder runs `steps[n]` (by
// default it writes src/stage-<n>.js) and, when `nominate[n]`, asks for the
// nomination. Ticks until every stage's run has ended. Returns the runs.
export async function buildStages(fx, p, { steps = [], nominate = [] } = {}) {
  const items = p.stages.map((s) => s.work_item);
  items.forEach((item, n) => fx.scripted.script(item, [roleThat(steps[n] ?? [n === 0 ? permittedEdit() : step.write(`src/stage-${n + 1}.js`, `export const stage = ${n + 1};\n`)], nominate[n] ? { nominate: true } : {})]));
  return tickUntil(
    fx.engine,
    p.id,
    () => {
      const runs = items.map((item) => runsOf(fx.home, item)[0]);
      return runs.every((r) => r?.state === 'ended') ? runs : undefined;
    },
    { max: 12 * items.length, what: 'every stage of the plan to be built' },
  );
}

export const candidatesOfProject = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));

// The checks of the project's effective version: {key: id}.
export const checkIds = (home, project) =>
  withStore(home, (db) =>
    Object.fromEntries(
      db
        .prepare(
          `SELECT c."key", c."id" FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version"
           WHERE v."project" = ? AND v."authorized" = 1 AND v."effective_from" IS NOT NULL AND v."superseded_by" IS NULL`,
        )
        .all(project)
        .map((r) => [r.key, r.id]),
    ),
  );

export const moduleIds = (home, project) => withStore(home, (db) => Object.fromEntries(db.prepare('SELECT "name", "id" FROM "modules" WHERE "project" = ?').all(project).map((r) => [r.name, r.id])));

// A passing result of each check `keys` names, for the candidate (the
// check-result fixture; it decides over the nomination's queued registration).
export async function passKeys(fx, project, candidate, keys) {
  const ids = checkIds(fx.home, project);
  for (const key of keys) {
    assert.ok(ids[key], `the effective version has the check ${key} (it has ${Object.keys(ids).join(', ')})`);
    await postResult(fx.engine, project, { candidate, check: ids[key], exit_status: 0 });
  }
}

// ---- what an evaluation says about its scope --------------------------------------------

const json = (text) => (typeof text === 'string' ? JSON.parse(text) : text);

// The scope row of an evaluation, its lists parsed: required (check ids),
// categories (sensitivity_categories), signoffs (required_signoffs).
export function scopeRead(home, evaluation) {
  const s = scopeOf(home, evaluation);
  return { ...s, categories: json(s.sensitivity_categories), signoffs: json(s.required_signoffs) };
}

export const incomplete = (evaluation) => reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE');
export const kindSubjects = (evaluation) => incomplete(evaluation).filter((s) => typeof s === 'string' && s.startsWith('kind:')).sort();
export const areaSubjects = (evaluation) => incomplete(evaluation).filter((s) => typeof s === 'string' && s.startsWith('area:')).sort();

// The keys of the checks an evaluation's scope requires.
export function requiredKeys(home, project, evaluation) {
  const byId = Object.fromEntries(Object.entries(checkIds(home, project)).map(([k, id]) => [id, k]));
  return scopeOf(home, evaluation)
    .required.map((id) => byId[id] ?? id)
    .sort();
}

// Whether a required sign-off of `scope` (and `module`, a name or an id) is listed.
export const signoffListed = (scope, kind, module) =>
  (scope.signoffs ?? []).some((s) => s.scope === kind && (module === undefined || s.module === module.name || s.module === module.id || s.module === module));
