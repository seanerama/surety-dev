// The maintenance job replayed (row M646, kernel lane; DECISIONS item 57,
// Sean's acceptance ask of 2026-11-26; slice plan §D.2, §D.4). Workshop Cut
// Planner on the scripted backend, its roles writing the production
// products of harness/wcp (README.md), the prototype harness's routes and
// pump (harness/prototype.mjs), and the scripted check boundary (SEAM.md
// §190) recording, for every accept-r5-5 execution, the exit status of the
// real command run by this process outside the engine on exactly the
// candidate's tree and the protected version's checks the execution names
// (both read from the project's own repository with git archive); every
// other execution exit 0, as production recorded them (32/32 on candidates
// 2 and 3: the walkthrough, l.81, l.87).
//
// The owner here answers what the engine asks, as Sean did: approve, and
// `fix` for a finding's disposition (production #10). Every answer, every
// owner act and the step it fell in are recorded, so the counts are read
// from the record and the store, never assumed. The replay never answers a
// `deployment_target_approval` (D4): that question is the exception the row
// asks to see stop. Nothing here asserts a row's clause; it asserts only
// that the step it takes happened.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { configContent, configure, scriptCall } from '../deploy/kernel.mjs';
import { waitFor } from '../engine.mjs';
import {
  answer,
  iterationRead,
  modelBrief,
  newApp,
  ok,
  openDecisionsRead,
  prepScript,
  protoEngine,
  result,
  runsUnderWay,
  usage,
  write,
} from '../prototype.mjs';
import { qualifyByFixture } from '../deploy/kernel.mjs';
import { tick } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { IDEA, PLAN1, PLAN2, REV, SPEC_V1, SPEC_V2, TIGHTENED_R5, R5_SCENARIO, checksOf, codeAt, delta, materialize, runCheckUnits } from './index.mjs';

export const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
export const one = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p));
export const J = (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? null));
export const show = (v) => JSON.stringify(v);

// ---- the production texts the roles write --------------------------------------------------

// The iteration's change (production: the owner's Iterate text, reconstructed
// from 3fa256d's commit message; README.md).
export const CHANGE = 'Add a millimetres/inches selector (decimal inches) for board, piece and blade lengths.';

// The print finding as candidate 2's Verifier reported it (fnd_01M89FZ0TWRJEY7YNQC4VXQ6V8:
// defect, low, R5.5, accept-r5-5; its message reconstructed: README.md).
export const PRINT_FINDING = Object.freeze({
  category: 'defect',
  severity: 'low',
  criterion: 'R5.5',
  check: 'accept-r5-5',
  message:
    "R5.5: the printed cut sheet does not state the selected unit at its top. public/styles.css hides the header's .intro line (\"All lengths are in <unit> (<symbol>).\") in print, so the first printed page shows the board diagrams before the unit is named in the cut sheet section.",
});

const briefOf = (objectives) =>
  modelBrief({
    app: 'Workshop Cut Planner',
    for: 'a woodworker planning cuts from boards they already own',
    experience: 'Enter boards, pieces and the blade width; see the layout; fix what does not fit; save and print.',
    included: ['entry, layout, unplaced explanations, saving and printing'],
    objectives,
    mocked: ['none'],
    left_out: ['accounts', 'sharing a plan'],
    assumptions: ['one browser, one woodworker'],
    limitations: ['the plan lives in this browser only'],
    constraints: ['no dependencies; node server.mjs serves public/'],
  });
const BRIEF1 = briefOf(['R1: enter boards, pieces and blade width in mm', 'R2: a visual cut layout with kerf', 'R3: explain pieces that do not fit; add a board or move a piece', 'R4: save the plan in this browser', 'R5: print a cut sheet']);
const BRIEF2 = briefOf(['R1: entry in millimetres or decimal inches', 'R2: the layout in the selected unit', 'R3: unit-aware explanations', 'R4: the unit remembered; earlier plans reopen in mm', 'R5: the cut sheet states its unit']);

const writes = (files) => Object.entries(files).filter(([, c]) => c !== null).map(([p, c]) => write(p, c));
const deletes = (files) => Object.entries(files).filter(([, c]) => c === null).map(([p]) => ({ delete: p }));
const builder = (files, summary) => ({ steps: [usage(1500, 500, 700), ...writes(files), ...deletes(files), result({ summary })] });
const planScript = (files, plan, conformance) => ({
  steps: [
    usage(2000, 0, 900),
    ...Object.entries(files).map(([p, c]) => (p.startsWith('.surety/phases/') ? { write: { path: p, content: c, substitute_head: true } } : write(p, c))),
    result({ summary: `the plan: ${plan}`, plan, conformance }),
  ],
});
const authoring = (files, kind, rationale) => ({ steps: [usage(900, 100, 300), ...writes(files), result({ proposal: { rationale, requested_change_kind: kind } })] });
const PASS = { steps: [usage(300, 0, 100), result()] };

// The products of every role, by work kind and launch ordinal, both
// iterations. `scratch`: a directory of the test's own for the code trees.
export function wcpScripts(fx, scratch) {
  const code = Object.fromEntries(Object.values(REV).map((r) => [r, codeAt(r, scratch)]));
  const it1 = code[REV.iteration1];
  const store = 'public/js/store.mjs';
  const stage1of1 = Object.fromEntries(Object.entries(it1).filter(([p]) => p !== store));
  const checks1 = checksOf(1);
  const checks2 = checksOf(2);
  const added2 = delta(checks1, checks2);
  const S = {
    brief_preparation: [prepScript({ spec: SPEC_V1, brief: BRIEF1 }), prepScript({ spec: SPEC_V2, brief: BRIEF2 })],
    replan: [planScript(PLAN1, 'phase-1', 'within_baseline'), planScript(PLAN2, 'phase-2', 'uncertain')],
    check_authoring: [
      authoring(checks1, 'unclassifiable', "Iteration 1's checks: one acceptance check per criterion, the server smoke and the post-deploy user operation."),
      authoring(added2, 'tightening', "Phase 2's checks: the millimetres/inches criteria of spec version 2, the same node command."),
    ],
    stage_build: [
      builder(stage1of1, 'Serve the planner page; enter blade, boards and pieces; the layout (17f0a3d, without the store)'),
      builder({ [store]: it1[store] }, 'Save the plan in this browser (17f0a3d)'),
      builder(delta(it1, code[REV.stage1]), 'Add the millimetres/inches selector (eed79f1)'),
      builder(delta(code[REV.stage1], code[REV.stage2]), 'Unplaced explanations and move refusals in the selected unit (a88fa57)'),
    ],
    fix: [builder(delta(code[REV.stage2], code[REV.fix]), "Fixed R5.5: public/styles.css no longer hides the header's .intro line in print (1d32e51)")],
    check_correction: [authoring({ [R5_SCENARIO]: TIGHTENED_R5 }, 'tightening', 'R5.5: with the saved two-board plan the printed page must name the unit before the first board diagram; accept-r5-5 passed on candidate 2, which prints the diagrams first.')],
  };
  for (const [kind, list] of Object.entries(S)) fx.scripted.kindScript(kind, [...list, ...Array(50).fill(PASS)]);
  fx.scripted.kindScript('verification', [PASS]); // iteration 1's; iteration 2's set by verifications()
  fx.scripted.kindScript('phase_verification', [...Array(50).fill({ steps: [usage(300, 0, 100), result({ signoffs: [{ scope: 'phase' }] })] })]);
  fx.scripted.defaultScript({ steps: [usage(100, 0, 50), result()] });
  return { code, checks1, checks2, added2 };
}

// Iteration 2's verifications from the next launch on: the first (candidate
// 2's) reports the print finding, every later one passes.
export function verifications(fx) {
  const before = fx.scripted.launches({ work_kind: 'verification' }).length;
  fx.scripted.kindScript('verification', [...Array(before).fill(PASS), { steps: [usage(300, 0, 100), result({ findings: [PRINT_FINDING] })] }, ...Array(50).fill(PASS)]);
}

// ---- the check boundary with the real R5.5 exits --------------------------------------------

const queued = (home, p) =>
  rows(home, `SELECT x."id", x."key", x."candidate", x."source_revision", x."protected_version" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" = 'queued' ORDER BY x."execution_seq"`, p);
const repoOf = (home, p) => one(home, 'SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?', p).dev_repo_path;
const versionRevision = (home, v) => one(home, 'SELECT "authorized_revision", "seq" FROM "protected_versions" WHERE "id" = ?', v);

function archive(repo, rev, paths, dir) {
  mkdirSync(dir, { recursive: true });
  const a = spawnSync('git', ['-C', repo, 'archive', rev, ...paths], { maxBuffer: 256 * 1024 * 1024 });
  if (a.status !== 0) throw new Error(`git archive ${rev} ${paths.join(' ')} in ${repo}: ${a.stderr}`);
  const x = spawnSync('tar', ['-x', '-C', dir], { input: a.stdout });
  if (x.status !== 0) throw new Error(`tar -x into ${dir}: ${x.stderr}`);
}

// The tree an execution names, on disk: the candidate's revision, its
// .surety/checks replaced by the protected version's (its authorized
// revision's). Cached per (revision, version).
const trees = new Map();
export function executionTree(fx, p, x, scratch) {
  const key = `${x.source_revision}:${x.protected_version}`;
  if (trees.has(key)) return trees.get(key);
  const repo = repoOf(fx.home, p);
  const v = versionRevision(fx.home, x.protected_version);
  const dir = join(scratch, `exec-${x.source_revision.slice(0, 10)}-v${v.seq}`);
  archive(repo, x.source_revision, ['public', 'server.mjs'], dir);
  archive(repo, v.authorized_revision, ['.surety/checks'], dir);
  trees.set(key, dir);
  return dir;
}

// Every queued execution recorded: accept-r5-5 with the real command's exit
// (logged in `real`), every other one 0. Returns nothing; a superseded or
// cancelled execution is left as the engine moved it.
export async function recordChecks(fx, p, real, scratch) {
  for (const x of queued(fx.home, p)) {
    let exit = 0;
    if (x.key === 'accept-r5-5') {
      const dir = executionTree(fx, p, x, scratch);
      const run = runCheckUnits(dir);
      exit = run.status;
      real.push({ execution: x.id, candidate: x.candidate, revision: x.source_revision, protected_version: x.protected_version, version_seq: versionRevision(fx.home, x.protected_version).seq, exit, tightened: run.out.includes('first board diagram'), out: run.out });
      assert.ok(exit === 0 || exit === 1, `the real accept-r5-5 ran to a judgment on ${x.source_revision} (exit ${exit}, signal ${run.signal}): ${run.out.slice(-800)}`);
    }
    for (const to of ['materializing', 'running', 'collecting', 'recorded']) {
      const res = await fx.engine.post('/v1/harness/fixtures/check-execution', { execution: x.id, to, ...(to === 'recorded' ? { exit_status: exit } : {}) });
      if (res.status !== 200) break;
    }
  }
}

// ---- the owner ------------------------------------------------------------------------------

// What the owner answers to each kind the engine may ask in this job (the
// production answers, DECISION-SEQUENCE.md). A kind not listed stops the
// replay with what was asked.
export const OWNER_ANSWER = Object.freeze({
  prototype_preparation_approval: 'approve',
  spec_approval: 'approve',
  architecture_approval: 'approve',
  plan_approval: 'approve',
  check_correction_tightening: 'approve',
  check_correction_unclassifiable: 'approve',
  check_correction_loosening: 'approve',
  finding_disposition: 'fix',
  policy_widening: 'approve',
});

export function owner() {
  const o = { step: 'setup', answers: [], acts: [] };
  o.at = (step) => {
    o.step = step;
  };
  return o;
}

async function answerAll(fx, p, o, { stopAt = [] } = {}) {
  for (const d of await openDecisionsRead(fx, p)) {
    if (stopAt.includes(d.kind)) continue;
    const option = OWNER_ANSWER[d.kind];
    if (!option) throw new Error(`the engine asked the owner a ${d.kind} (${d.id}) in step ${o.step}, which this job's owner has no answer for: ${show(d).slice(0, 1500)}`);
    const offered = (d.options ?? []).map((x) => x.key ?? x);
    const chosen = offered.length === 0 || offered.includes(option) ? option : null;
    if (!chosen) throw new Error(`the owner's ${option} is not offered on ${d.kind} ${d.id} (offered ${show(offered)}) in step ${o.step}`);
    const res = await answer(fx, p, d, chosen);
    o.answers.push({ step: o.step, kind: d.kind, decision: d.id, subject_type: d.subject_type, subject: d.subject_id, option: chosen, status: res.status });
    assert.equal(res.status, 200, `the owner's ${chosen} on ${d.kind} ${d.id} (→ ${res.status} ${res.text?.slice(0, 600)})`);
  }
}

const idle = (fx, p) => waitFor(() => runsUnderWay(fx.home, p).length === 0, { timeoutMs: 120_000, what: `the runs of ${p} to end` });

// Tick until `done` answers, recording checks and answering as the owner.
export async function drive(fx, p, o, done, { max = 80, what = 'the replay to advance', real, scratch, stopAt = ['deployment_target_approval'] } = {}) {
  for (let i = 0; ; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    if (i >= max) {
      const open = (await openDecisionsRead(fx, p)).map((d) => d.kind);
      const its = rows(fx.home, 'SELECT "seq", "status", "next_step", "outcome_reason" FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq"', p);
      const work = rows(fx.home, `SELECT "kind", "status", "held", "blocker" FROM "work_items" WHERE "project" = ? AND "status" NOT IN ('complete', 'cancelled') ORDER BY "seq"`, p).map((w) => `${w.kind}:${w.status}:${w.held ?? ''}:${String(w.blocker ?? '').slice(0, 200)}`);
      throw new Error(`${what}: not reached in ${max} ticks (step ${o.step}; iterations ${show(its)}; open decisions ${show(open)}; work ${show(work)}; answers ${show(o.answers.map((a) => [a.step, a.kind, a.option]))}; engine stderr: ${fx.engine.proc.out.stderr.slice(-1200)})`);
    }
    await idle(fx, p);
    await recordChecks(fx, p, real, scratch);
    await answerAll(fx, p, o, { stopAt });
    await tick(fx.engine, p);
    await idle(fx, p);
  }
}

export const statusOf = async (fx, p, it) => (await iterationRead(fx, p, it)).iteration.status;
export const reached = (fx, p, it, status) => async () => ((await statusOf(fx, p, it)) === status ? true : undefined);

// ---- iteration 1, to its Alpha on `local` --------------------------------------------------

export const PORT = 17482;

export async function iterationOneAlpha(t, { scratch }) {
  const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
  const products = wcpScripts(fx, scratch);
  const o = owner();
  const real = [];
  const { id: p } = await newApp(fx, { name: 'Workshop Cut Planner', idea: IDEA });
  const it1 = (await ok(fx.engine.get(`/v1/projects/${p}/iterations`), 200, 'GET …/iterations')).iterations.at(-1);
  const prep1 = rows(fx.home, `SELECT "dependency_manifest" FROM "decisions" WHERE "project" = ? AND "kind" = 'prototype_preparation_approval' ORDER BY "seq"`, p).map((d) => J(d.dependency_manifest))[0];
  await drive(fx, p, o, reached(fx, p, it1.id, 'awaiting_brief_approval'), { what: "iteration 1's brief", real, scratch });
  await answerAll(fx, p, o);
  const done = await configure(fx.engine, p, 'local', configContent({ start: [process.execPath, 'server.mjs'], port: PORT }));
  const local = { ...done.environment, name: 'local' };
  await scriptCall(fx.engine, local.id, 'deploy', [{ result: 'issued', apply: true }]);
  await qualifyByFixture(fx.engine);
  await drive(fx, p, o, reached(fx, p, it1.id, 'alpha_ready'), { max: 160, what: "iteration 1's Alpha", real, scratch });
  const adv = await fx.engine.post('/v1/harness/clock/advance', { seconds: 31 });
  assert.equal(adv.status, 200, `the clock advanced (${adv.text})`);
  await drive(fx, p, o, async () => (await iterationRead(fx, p, it1.id)).alpha.current ?? undefined, { what: "an observation of iteration 1's Alpha", real, scratch });
  return { fx, p, it1, local, o, real, products, prep1 };
}
