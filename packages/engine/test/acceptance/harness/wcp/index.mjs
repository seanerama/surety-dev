// The Workshop Cut Planner fixture (row M646; DECISIONS item 57, Sean's
// acceptance ask of 2026-11-26; the analyst's slice plan §D.1). Vendored
// from the owner's repository by `git archive` (README.md in this directory
// names every file's source revision); nothing here reads ~/projects at test
// time (mini-hp01 has no clone).
//
// What it gives a test:
//   - the code trees of the four revisions the replay emits (17f0a3d,
//     iteration 1's Alpha; eed79f1 and a88fa57, iteration 2's two stages;
//     1d32e51, the print fix), as {path: text} maps: a88fa57 whole under
//     tree/, the others as the production diffs from a88fa57 (rev/*.patch),
//     applied with git apply in a directory of the caller's;
//   - the protected check trees: iteration 1's (8b965c6) and iteration 2's
//     (a88fa57, 3f631ef's), with protected-policy.json rewritten to the
//     engine's own node (as M223's fixture names it), and the Verifier's
//     check correction in this replay (tightened/: an added definition,
//     accept-r5-5-print, and its scenario; not production files);
//   - the plan products (spec v1 and v2, both architectures, roadmaps,
//     phase plans and ADRs) and the saved two-board plan (two-board-plan.json,
//     derived by derive-two-board-plan.mjs with iteration 1's own store.mjs);
//   - the real checks run outside the engine: a definition's own `node`
//     command in a materialized tree
//     (WCP's own DOM and CSS, no browser), and the page process
//     (lib/page.mjs) driving direct-scenario.mjs for the print-visible text.
//
// Nothing here asserts a row's clause.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeReadPaths } from '../checks/fixtures.mjs';

export const WCP = dirname(fileURLToPath(import.meta.url));
const TREE = join(WCP, 'tree');

// The revisions (WCP repository, read-only; README.md).
export const REV = Object.freeze({
  iteration1: '17f0a3d', // w-4 stage_build: iteration 1's last integration (its Alpha's code)
  stage1: 'eed79f1', // w-12 stage_build: iteration 2, stage 1 (the unit selector)
  stage2: 'a88fa57', // w-13 stage_build: iteration 2, stage 2 = candidate 2, the print defect
  fix: '1d32e51', // w-16 fix: R5.5, the print label = candidate 3
});

const walk = (root, dir = root, out = {}) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
  }
  return out;
};
const pick = (files, prefix) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(prefix)));
const BASE = walk(TREE);

// ---- the code trees -----------------------------------------------------------------------------

const CODE_OF_BASE = { ...pick(BASE, 'public/'), 'server.mjs': BASE['server.mjs'] };

// The code of `rev` ({path: text | null}; null: absent at that revision),
// the production diff from a88fa57 applied with git apply in `scratch` (a
// directory of the caller's, under its TMPDIR; never inside a repository:
// git looks no higher than it).
export function codeAt(rev, scratch) {
  if (rev === REV.stage2) return { ...CODE_OF_BASE };
  const dir = join(scratch, `wcp-code-${rev}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  for (const [p, text] of Object.entries(CODE_OF_BASE)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const patch = join(WCP, 'rev', `a88fa57-to-${rev}.patch`);
  const r = spawnSync('git', ['apply', '--whitespace=nowarn', patch], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
  if (r.status !== 0) throw new Error(`wcp: git apply ${patch} failed (${r.status}): ${r.stderr}`);
  const got = walk(dir);
  const out = {};
  for (const p of new Set([...Object.keys(CODE_OF_BASE), ...Object.keys(got)])) out[p] = got[p] ?? null;
  return out;
}

// What a Builder writes to move the tree from `from` to `to` ({path: text},
// null for a removal): only the files that differ.
export function delta(from, to) {
  const out = {};
  for (const p of new Set([...Object.keys(from), ...Object.keys(to)])) if ((from[p] ?? null) !== (to[p] ?? null)) out[p] = to[p] ?? null;
  return out;
}

// ---- the protected check trees ------------------------------------------------------------------

export const GOVERNED = '.surety/checks/protected-policy.json';

// protected-policy.json rewritten to this host's node (the engine's own, as
// M223's fixture names it): check_commands.node.path, and runner_config's
// read_paths and path. Every other field as WCP wrote it.
export function governedForHost(text = BASE[GOVERNED]) {
  const g = JSON.parse(text);
  g.check_commands.node.path = process.execPath;
  g.runner_config.direct.read_paths = nodeReadPaths();
  g.runner_config.direct.path = [dirname(process.execPath), '/usr/bin', '/bin'];
  return `${JSON.stringify(g, null, 2)}\n`;
}

// The files phase 2's authoring added (226f7c0 and 3f631ef; README.md).
export const ITERATION2_CHECK_FILES = Object.freeze([
  '.surety/checks/defs/accept-r1-1-unit.json',
  '.surety/checks/defs/accept-r1-5.json',
  '.surety/checks/defs/accept-r1-6.json',
  '.surety/checks/defs/accept-r1-7.json',
  '.surety/checks/defs/accept-r2-5.json',
  '.surety/checks/defs/accept-r3-6.json',
  '.surety/checks/defs/accept-r4-4-unit.json',
  '.surety/checks/defs/accept-r4-5.json',
  '.surety/checks/defs/accept-r4-6.json',
  '.surety/checks/defs/accept-r5-5.json',
  '.surety/checks/run/check-scenario.mjs',
  '.surety/checks/run/check-units.mjs',
  '.surety/checks/run/lib/units.mjs',
  '.surety/checks/run/scenarios/units-defaults.mjs',
  '.surety/checks/run/scenarios/units-r1.mjs',
  '.surety/checks/run/scenarios/units-r2.mjs',
  '.surety/checks/run/scenarios/units-r3.mjs',
  '.surety/checks/run/scenarios/units-r4.mjs',
  '.surety/checks/run/scenarios/units-r5.mjs',
]);

// The Verifier's check correction of the print finding (not a production
// file; README.md): one added definition, accept-r5-5-print (the approved
// node command, check-scenario.mjs as 3f631ef's checks use it, covers R5.5),
// and its scenario file. accept-r5-5 and every existing file unchanged.
export const PRINT_CHECK = 'accept-r5-5-print';
export const CORRECTION = Object.freeze({
  '.surety/checks/defs/accept-r5-5-print.json': readFileSync(join(WCP, 'tightened', 'accept-r5-5-print.json'), 'utf8'),
  '.surety/checks/run/scenarios/units-r5-print.mjs': readFileSync(join(WCP, 'tightened', 'units-r5-print.mjs'), 'utf8'),
});

// The protected check tree of `iteration` (1: 8b965c6's; 2: a88fa57's),
// `tightened`: with the Verifier's correction added. The governed file for this host.
export function checksOf(iteration, { tightened = false } = {}) {
  const all = pick(BASE, '.surety/checks/');
  const out = {};
  for (const [p, text] of Object.entries(all)) {
    if (iteration === 1 && ITERATION2_CHECK_FILES.includes(p)) continue;
    out[p] = text;
  }
  out[GOVERNED] = governedForHost();
  if (tightened) Object.assign(out, CORRECTION);
  return out;
}
export const checkKeysOf = (files) => Object.keys(files).filter((p) => p.startsWith('.surety/checks/defs/') && p.endsWith('.json')).map((p) => JSON.parse(files[p]).key).sort();

// ---- the plan products ------------------------------------------------------------------------

const read = (...p) => readFileSync(join(WCP, ...p), 'utf8');
export const IDEA = read('spec', 'idea.md');
export const SPEC_V1 = read('spec', 'spec-v1.md');
export const SPEC_V2 = read('spec', 'spec-v2.md');

// Iteration 1's architecture (c9faeaa) and iteration 2's (2578102 = the
// a88fa57 tree's). Phase plans name the revision they were prepared
// against: written as `__HEAD__` for the scripted role to substitute.
const headed = (text) => {
  const plan = JSON.parse(text);
  plan.prepared_against.revision = '__HEAD__';
  return `${JSON.stringify(plan, null, 2)}\n`;
};
export const PLAN1 = Object.freeze({
  '.surety/adrs/ADR-001.md': BASE['.surety/adrs/ADR-001.md'],
  '.surety/adrs/ADR-002.md': BASE['.surety/adrs/ADR-002.md'],
  '.surety/architecture/architecture.md': read('rev', 'c9faeaa', '.surety', 'architecture', 'architecture.md'),
  '.surety/architecture/modules.json': read('rev', 'c9faeaa', '.surety', 'architecture', 'modules.json'),
  '.surety/roadmap/roadmap.json': read('rev', 'c9faeaa', '.surety', 'roadmap', 'roadmap.json'),
  '.surety/phases/phase-1.json': headed(BASE['.surety/phases/phase-1.json']),
});
export const PLAN2 = Object.freeze({
  '.surety/adrs/ADR-003.md': BASE['.surety/adrs/ADR-003.md'],
  '.surety/architecture/architecture.md': BASE['.surety/architecture/architecture.md'],
  '.surety/architecture/modules.json': BASE['.surety/architecture/modules.json'],
  '.surety/roadmap/roadmap.json': BASE['.surety/roadmap/roadmap.json'],
  '.surety/phases/phase-2.json': headed(BASE['.surety/phases/phase-2.json']),
});
export const PHASE_FILES = Object.freeze(['.surety/phases/phase-1.json', '.surety/phases/phase-2.json']);

// ---- the saved two-board plan -------------------------------------------------------------------

// CP_STORAGE (lib/page.mjs): localStorage at page open. Keys from
// public/js/store.mjs at a88fa57 (KEY, UNIT_KEY); the plan as iteration 1's
// own store.mjs saved it (derive-two-board-plan.mjs).
export const TWO_BOARD = Object.freeze(JSON.parse(read('two-board-plan.json')));

// ---- a tree on disk, and the real checks outside the engine -----------------------------------

// Write `files` ({path: text | null}) under `dir`.
export function writeTree(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

// A candidate's tree as the check sees it: the code of `rev` and the check
// tree given. Returns the directory.
export function materialize(dir, code, checks) {
  mkdirSync(dir, { recursive: true });
  return writeTree(dir, { ...code, ...checks });
}

// A check's own command, as its definition in `dir` names it (`node` the
// governed command: this process's node), run in `dir` with nothing of the
// engine. accept-r5-5: `node .surety/checks/run/check-units.mjs R5.5`;
// accept-r5-5-print: `node .surety/checks/run/check-scenario.mjs
// units-r5-print R5.5`. Returns {status, signal, out}.
export function runCheck(dir, key) {
  const def = JSON.parse(readFileSync(join(dir, '.surety/checks/defs', `${key}.json`), 'utf8'));
  if (def.command[0] !== 'node') throw new Error(`wcp: ${key} does not run the governed node command: ${JSON.stringify(def.command)}`);
  const r = spawnSync(process.execPath, def.command.slice(1), { cwd: join(dir, def.cwd ?? '.'), encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const DIRECT = join(WCP, 'direct-scenario.mjs');

// One session of direct-scenario.mjs's `name` in the tree at `dir`, through
// the tree's own page process (lib/page.mjs), localStorage = `storage`.
// Returns the page's report ({assertions, carry, storage, pageErrors, done}).
export function pageSession(dir, name, index, storage, carry = null) {
  const nonce = `WCPREPORT${randomBytes(8).toString('hex')}:`;
  const r = spawnSync(process.execPath, ['.surety/checks/run/lib/page.mjs', DIRECT, name, String(index)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CP_NONCE: nonce, CP_STORAGE: JSON.stringify(storage), CP_CARRY: JSON.stringify(carry) },
  });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith(nonce));
  if (!line) throw new Error(`wcp: the page process in ${dir} gave no report (exit ${r.status}, signal ${r.signal}): ${`${r.stderr ?? ''}${r.stdout ?? ''}`.slice(-1500)}`);
  return JSON.parse(line.slice(nonce.length));
}

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
const UNIT_NAME = { mm: /\bmillimet(re|er)s?\b/i, in: /\binch(es)?\b/i };

// The print-visible text of the saved two-board plan in `unit`, and where in
// it the unit is first named and the first board diagram begins (-1: not found).
export function printOrder(dir) {
  const rep = pageSession(dir, 'print', 0, TWO_BOARD);
  if (!rep.done) throw new Error(`wcp: the print session did not complete: ${JSON.stringify(rep.assertions)} ${JSON.stringify(rep.pageErrors)}`);
  const out = {};
  for (const unit of ['mm', 'in']) {
    const { text, firstDiagram, diagrams } = rep.carry[unit];
    const T = flat(text);
    const m = UNIT_NAME[unit].exec(T);
    out[unit] = { text: T, firstDiagram: flat(firstDiagram), diagrams, unitAt: m ? m.index : -1, diagramAt: firstDiagram ? T.indexOf(flat(firstDiagram)) : -1 };
  }
  return out;
}

// The walkthrough's facts (~/surety-evidence/workshop-cut-planner-walkthrough.md
// l.53, l.93): the saved plan opened, switched to inches, refreshed in
// inches, switched back. Returns the two sessions' carries.
export function walkthrough(dir) {
  const first = pageSession(dir, 'walk', 0, TWO_BOARD);
  if (!first.done) throw new Error(`wcp: the walkthrough's first session did not complete: ${JSON.stringify(first.assertions)}`);
  const second = pageSession(dir, 'walk', 1, first.storage, first.carry);
  if (!second.done) throw new Error(`wcp: the walkthrough's second session did not complete: ${JSON.stringify(second.assertions)}`);
  return { opened: first.carry, reloaded: second.carry, storageAfterInches: first.storage };
}
