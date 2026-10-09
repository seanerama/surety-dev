// The real check journey (M3 slice 22; row M239; M3 plan §3.8 M239 and
// question 5; E89, E91, E92 item 3; SEAM.md §237). PAID, by Sean's command
// only, on his subscription token, through M2's real-lane harness (lane.mjs,
// attempt.mjs): the same run directory, preflight, steps, halts and waits.
//
// One temporary project, T1, with three requirements whose texts the roles
// read: R1 (src/greeting.mjs), R2 (src/session.mjs, already written, with a
// seeded defect: a 30-minute session stays valid a thousand times too long)
// and R3 (src/logout.mjs); one criterion each (R1.1, R2.1, R3.1, the shared
// plan fixture's). The governed file names one program, the engine's own
// node, and no check: the project starts with no definition.
//
//   path one (step `m3_path_one`): a real Verifier writes the project's
//     checks (definitions and their programs under .surety/checks/) in
//     `check_correction` work; the engine classifies the captured proposal;
//     Sean answers the classification's decision; the engine applies it and
//     discovers the checks with no error. Then stage 1 (R1): a real Builder
//     builds it, the engine runs the checks of the candidate's scopes in
//     `check` domains, and both gates are evaluated on those results.
//   path two (step `m3_path_two`): stage 2 (R2, R3), with
//     repair_attempts_max 0 so that a failed check parks the stage instead of
//     sending it back (the row is about the finding, not the repair; objection
//     030): a real Builder builds it; the real Verifier verifies the candidate
//     and is expected to report the seeded defect as a finding naming R2.1 and
//     a check covering it; a real Reviewer dispositions it `fix`; a real
//     Builder fixes it; the engine runs the checks on the fix's candidate; the
//     finding resolves only through the covering required check (F2 (c)).
//
// No check result comes from a fixture: the runner is qualified by the
// engine's own self-test at each start (`--harness-runner-self-test run`),
// never by the runner qualification fixture; the check-result fixture is
// never called. What stays a fixture, labelled: the approved plan with its
// texts and index (spec approval is not built, D3 §4.5), the trigger of the
// first `check_correction` work and of the path-two review (the routes a
// person would use are not built), and the Alpha test target.
//
// A real agent's behaviour cannot be scripted. Every place the journey needs
// an agent to do one thing is checked when it happens; a miss is "not
// established", which fails the step and halts the run directory, never a
// verdict on the engine (E59 item 3).

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { alphaTarget, effectiveVersion, findingsOf, installGatedPlan, proposalsOf, stageGate } from '../gates.mjs';
import { changePolicy, createProject, workItemsOf } from '../journal.mjs';
import { gitQuiet, makeProjectRepo, refOid, trailersOf } from '../repos.mjs';
import { addWork, pauseProject, resumeProject, runsOf, workItem } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { blobBytes, commitEntries, domainOfExecution, executionsOf, governedText, resultRow, resultsOfProject, versionRead } from '../checks/fixtures.mjs';
import { activeQualification, selfTestArgs, SELF_TEST_CASES } from '../checks/execution.mjs';
import { findingRow } from '../checks/repair.mjs';
import { realPolicy } from './attempt.mjs';
import { letThrough, runEnds } from './journey.mjs';
import { existsSync as exists } from 'node:fs';
import { REAL, journeyEngine, ledgerOriginal, observe, realStep, sampleDomains, stepValue, tickWhile, waitForSean } from './lane.mjs';

// ---- the project ----------------------------------------------------------------------

export const SEEDED_DEFECT_M3 = Object.freeze({
  path: 'src/session.mjs',
  content:
    '// R2: a session is valid for 30 minutes after it was issued.\n' +
    'export const SESSION_LIFETIME = 30 * 60; // seconds\n' +
    'export function isSessionValid(session, nowMs) {\n' +
    '  return nowMs - session.issuedAtMs < SESSION_LIFETIME * 1000 * 1000;\n' +
    '}\n',
});

export const M239 = Object.freeze({
  name: 'real-check-journey',
  tier: 'T1',
  requirements: [
    { key: 'R1', text: 'src/greeting.mjs exports a function greeting(name) that returns the string "Hello, " followed by name and "!". For example greeting("Ada") returns "Hello, Ada!".' },
    { key: 'R2', text: 'src/session.mjs exports isSessionValid(session, nowMs), true exactly when nowMs - session.issuedAtMs is less than 30 minutes (1 800 000 milliseconds). A session 30 minutes old or older is expired and must be rejected. This is a security requirement.' },
    { key: 'R3', text: 'src/logout.mjs exports logout(session), which returns a copy of session with the property revoked set to true and does not change the session it was given.' },
  ],
  constraints: [
    { key: 'C1', text: 'Plain JavaScript ES modules (.mjs files) with no dependencies. Do not add a package.json.' },
    // A T1 project's engine nominates a Builder's work only when the Builder asks (the result's
    // `nominate`, honoured at T1): said here, in every role's package, for the stage and the fix alike.
    { key: 'C2', text: 'A Builder, when its change is done, sets "nominate": true in its result, so that the engine nominates the change as a candidate and runs the project\'s checks on it.' },
  ],
  stageOne: { number: 1, goal: 'Implement R1: create src/greeting.mjs as R1 describes.', implements: ['R1'] },
  stageTwo: { number: 2, goal: 'R2 is already implemented in src/session.mjs. Implement R3: create src/logout.mjs as R3 describes.', implements: ['R2', 'R3'] },
  // The criterion the seeded defect breaks.
  defectCriterion: 'R2.1',
});

// The checks' toolchain: a copy of the engine's node binary, alone in a
// directory of its own under `dir` (the run directory), its hash pinned. Only
// that directory is a read path, and the check's PATH is D3's default system
// directories: a check the real Verifier writes runs `node` and reaches no
// other program of Sean's node installation (its npm, its global CLIs) and
// nothing else of his home (the slice-22 review, minor 3; SEAM.md §237).
// Node needs nothing beside its binary to run a script; the system libraries
// it links are in the profile's read-only system directories.
export function m239Toolchain(dir) {
  const toolchain = join(dir, 'toolchain');
  mkdirSync(toolchain, { recursive: true, mode: 0o755 });
  const node = join(toolchain, 'node');
  if (!existsSync(node)) {
    copyFileSync(process.execPath, node);
    chmodSync(node, 0o755);
  }
  return { dir: toolchain, node, sha256: createHash('sha256').update(readFileSync(node)).digest('hex') };
}

// The governed file: one program, `node`, the pinned copy above, and no
// definition yet. A program is a person's decision (D3 §3.1): the Verifier is
// to write definitions that run it.
export const M239_GOVERNED = (toolchain) => ({
  protected_paths: ['.surety/checks/'],
  check_commands: { node: { path: toolchain.node, sha256: toolchain.sha256 } },
  runner_config: { direct: { read_paths: [toolchain.dir], path: ['/usr/bin', '/bin'], timeout_max_s: 600 } },
});

const notEstablished = (path, what, detail) => {
  throw new Error(`${path} not established: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 900)})`}`);
};

const SELF_TEST = selfTestArgs();

// ---- what an earlier attempt left (the slice-22 review, S1) -----------------------------
//
// A path that ends "not established" leaves its project paused (each path's
// `finally`), so a later engine on the same home dispatches nothing of it. A
// rerun checks the store before it starts an engine, and before it resumes a
// project, that no earlier work could be dispatched: an eligible item not
// held, within the project's chain limit (an item past the chain boundary
// waits for a person's `continue`), or a run not ended. It refuses otherwise,
// before anything is started or resumed.

const CONTRACT_CONFIG = JSON.parse(readFileSync(new URL('../../contract/config.json', import.meta.url), 'utf8'));
function contractDefault(key) {
  const walk = (o) => {
    if (!o || typeof o !== 'object') return undefined;
    if (o[key] && typeof o[key] === 'object' && 'default' in o[key]) return o[key].default;
    for (const v of Object.values(o)) {
      const found = walk(v);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(CONTRACT_CONFIG);
}

// For each project of `ids` (default: every project of M239 in the home):
// whether it is paused, its dispatchable items and its live runs.
export function leftovers(home, ids = null) {
  if (!exists(join(home, 'store.db'))) return [];
  return withStore(home, (db) => {
    const projects = ids === null ? db.prepare('SELECT "id" FROM "projects" WHERE "name" LIKE ?').all(`${M239.name}%`).map((r) => r.id) : ids;
    return projects.map((project) => {
      const p = db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project);
      const policy = db.prepare('SELECT r."effective" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?').get(project);
      const recorded = policy ? JSON.parse(policy.effective).max_chained_roles : undefined;
      const maxChained = Number.isInteger(recorded) ? recorded : contractDefault('max_chained_roles');
      const dispatchable = db
        .prepare(`SELECT "id", "kind", "status", "chain", "dispatch_hold" FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`)
        .all(project)
        .filter((w) => w.dispatch_hold !== 1 && !(w.chain + 1 > maxChained));
      const live = db.prepare(`SELECT "id", "role", "state" FROM "runs" WHERE "project" = ? AND "state" <> 'ended'`).all(project);
      return { project, paused: p?.paused === 1, dispatchable, live };
    });
  });
}

function refuseLeftovers(path, found, { evenIfPaused }) {
  const bad = found.filter((f) => f.live.length > 0 || (f.dispatchable.length > 0 && (evenIfPaused || !f.paused)));
  if (bad.length === 0) return;
  throw new Error(
    `${path} refused: work of an earlier attempt could be dispatched (${JSON.stringify(bad).slice(0, 900)}). Nothing was started or resumed. ` +
      'Settle it first (cancel it as its owner, or let it end), or start a new run directory.',
  );
}

// Path one's effective protected files, from the version's authorized revision
// in path one's repository, each with its git mode (commitEntries' form).
function protectedFilesOf(home, one) {
  const v = withStore(home, (db) => db.prepare('SELECT "id", "authorized_revision" FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "superseded_by" IS NULL').get(one.project));
  if (!v?.authorized_revision) throw new Error(`M239 path two refused: path one's effective protected version could not be read (${JSON.stringify(v ?? null)}). Nothing was started.`);
  // Only the protected set: the governed file and its roots (the third try's finding, SEAM.md §242).
  // `.surety/project.json` and `.surety/policy.json` are the engine's own files of path one's project,
  // never the checks: carried, they put path one's id and policy into path two's history.
  const GOVERNED = '.surety/checks/protected-policy.json';
  const governed = JSON.parse(blobBytes(one.repo, v.authorized_revision, GOVERNED).toString('utf8'));
  const roots = Array.isArray(governed.protected_paths) && governed.protected_paths.length > 0 ? governed.protected_paths : ['.surety/checks/'];
  const entries = {};
  const listing = gitQuiet(one.repo, ['ls-tree', '-r', '-z', v.authorized_revision, '--', GOVERNED, ...roots]).split('\0').filter(Boolean);
  for (const line of listing) {
    const [meta, path] = line.split('\t');
    const [mode, type] = meta.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`M239 path two refused: ${path} in path one's checks is not a regular file (${mode} ${type}). Nothing was started.`);
    entries[path] = { content: blobBytes(one.repo, v.authorized_revision, path), mode };
  }
  if (!entries['.surety/checks/protected-policy.json']) throw new Error("M239 path two refused: path one's version holds no governed file. Nothing was started.");
  return { version: v.id, revision: v.authorized_revision, entries };
}

// The commits a Reviewer of the project's first candidate is shown (the
// engine's rule, src/store/reads.ts: from the parent of the project's first
// recorded revision to the candidate), each with its author, its run and
// project trailers and the paths it changes (the third try, SEAM.md §242).
function reviewRangeOf(home, project, repo, revision) {
  const first = withStore(home, (db) => db.prepare('SELECT "parent_sha" FROM "revisions" WHERE "project" = ? AND "parent_sha" IS NOT NULL ORDER BY "recorded_at", "created_at", "id" LIMIT 1').get(project));
  if (!first?.parent_sha) return { base: null, commits: [] };
  const shas = gitQuiet(repo, ['rev-list', '--reverse', `${first.parent_sha}..${revision}`]).split('\n').filter(Boolean);
  const commits = shas.map((sha) => {
    const trailers = trailersOf(repo, sha);
    return {
      sha,
      author: gitQuiet(repo, ['show', '-s', '--format=%an <%ae>', sha]),
      run: trailers['Surety-Run']?.[0] ?? null,
      role: trailers['Surety-Role']?.[0] ?? null,
      setup: trailers['Surety-Project']?.[0] ?? null,
      files: gitQuiet(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha]).split('\0').filter(Boolean),
    };
  });
  // What the harness left at the base under `.surety/`: the carried protected set only.
  const atBase = gitQuiet(repo, ['ls-tree', '-r', '-z', '--name-only', first.parent_sha, '--', '.surety/']).split('\0').filter(Boolean);
  return { base: first.parent_sha, base_surety: atBase, commits };
}

// Pause the project before the engine stops, whatever happened (S1).
async function pauseQuietly(fx, project) {
  if (!project) return;
  await pauseProject(fx.engine, project).catch(() => null);
}

// The host qualification active before an engine starts on the home, which
// this start's self-test is not (every start qualifies the host again).
function priorQualification(ctx) {
  const home = join(ctx.runDir, 'home');
  return exists(join(home, 'store.db')) ? (activeQualification(home)?.id ?? null) : null;
}

// Work that waits at the chain boundary is let through as M01's journey lets
// it (SEAM.md §162); work that is dispatched without one is simply waited for.
async function throughBoundary(fx, project, itemId) {
  const seen = await tickWhile(
    fx,
    project,
    () => {
      if (runsOf(fx.home, itemId).length > 0) return { dispatched: true };
      const d = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`).get(itemId));
      return d ? { decision: d.id } : undefined;
    },
    { timeoutMs: 180_000, everyMs: 3_000, what: `${itemId} to be dispatched or to wait at the chain boundary` },
  );
  if (seen.decision) await letThrough(fx, project, itemId);
}
const TERMINAL = new Set(['recorded', 'cancelled', 'interrupted']);
const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// This start's runner self-test, read from the store: check_runner qualified
// with every mandatory case passed and no fixture label, or not established.
async function selfTested(fx, path) {
  const q = await tickWhile(
    fx,
    null,
    () => {
      const row = activeQualification(fx.home);
      return row?.check_runner && Array.isArray(row.check_runner.self_test) && row.check_runner.self_test.length > 0 && row.id !== fx.priorQualification ? row : undefined;
    },
    { timeoutMs: 600_000, everyMs: 2_000, what: "this start's runner self-test" },
  );
  const runner = q.check_runner;
  const cases = runner.self_test.map((e) => [e.case, e.result]);
  if (runner.qualified !== true || runner.test_fixture === true || SELF_TEST_CASES.some((c) => !cases.some(([n, r]) => n === c && r === 'passed'))) {
    notEstablished(path, 'the runner self-test did not qualify direct at this start', { qualified: runner.qualified, test_fixture: runner.test_fixture ?? null, cases });
  }
  return { id: q.id, profile_fingerprint: runner.profile_fingerprint ?? null, cases };
}

// The candidate's executions settle: for every key, the latest registration ended.
function settledExecutions(home, candidate) {
  const all = executionsOf(home, candidate);
  if (all.length === 0) return undefined;
  const latest = new Map();
  for (const x of all) latest.set(x.key, x);
  return [...latest.values()].every((x) => TERMINAL.has(x.status)) ? [...latest.values()] : undefined;
}
const waitSettled = (fx, project, candidate, what) => tickWhile(fx, project, () => settledExecutions(fx.home, candidate), { timeoutMs: 900_000, everyMs: 5_000, what });

const candidates = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));
const nthCandidate = (fx, project, n) => tickWhile(fx, project, () => candidates(fx.home, project)[n - 1], { timeoutMs: 300_000, everyMs: 5_000, what: `candidate ${n} of ${project}` });

// What the engine recorded of each execution: the result, the domain, the qualification.
function executionFacts(home, x) {
  const r = x.result ? resultRow(home, x.result) : null;
  const d = domainOfExecution(home, x);
  return {
    execution: x.id,
    key: x.key,
    status: x.status,
    trigger: x.trigger,
    execution_seq: x.execution_seq,
    not_run_reason: x.not_run_reason ?? null,
    result: r ? { id: r.id, execution: r.execution, execution_established: r.execution_established, exit_status: r.exit_status, signaled: r.signaled, deadline_hit: r.deadline_hit, orphans: r.orphans ?? null, runner_id: r.runner_id, runner_qualification: r.runner_qualification, output: r.output } : null,
    domain: d ? { id: d.id, profile: d.profile, check_execution: d.check_execution, status: d.status, launch_state: d.launch_state, cgroup_path: d.cgroup_path } : null,
  };
}

// The two gates on a candidate (the stage's, then the Alpha authorization's on a test target).
async function gatesOn(fx, project, candidate, stage) {
  const ctx = { project: { id: project }, candidate, stage };
  const stageEval = await stageGate(fx, ctx);
  const alpha = await alphaTarget(fx, ctx);
  const alphaEval = await alpha.evaluate();
  return { stage: stageEval, alpha: alphaEval, authorization: alpha.authorization.id };
}

// A check of a version read (SEAM.md §178): its definition with A.4's defaults.
const checkFacts = (c) => ({ key: c.key, required: c.required, kind: c.definition?.kind ?? null, origin: c.definition?.origin ?? null, criteria: c.definition?.covers?.criteria ?? [], gate_kinds: c.definition?.gate_kinds ?? [], command: c.definition?.command ?? null });

const summary = (e) => ({ id: e.id, outcome: e.outcome, reasons: e.reasons, check_states: e.check_states, checks: e.checks ?? null, missing_verifications: e.missing_verifications ?? null });

const runSummary = (home, run) => ({ id: run.id, role: run.role, work_item: run.work_item, state: run.state, outcome: run.outcome, reason_class: run.reason_class, reason_text: run.reason_text, ledger: ledgerOriginal(home, run.id) });

// ---- path one: the checks written by a real Verifier; a real Builder; the engine runs them ----

export async function checksPathOne(ctx) {
  return realStep(ctx, 'm3_path_one', async () => {
    const path = 'M239 path one';
    // Every earlier attempt's project is paused, or has nothing to dispatch, before an engine starts on the home.
    refuseLeftovers(path, leftovers(join(ctx.runDir, 'home')), { evenIfPaused: false });
    const prior = priorQualification(ctx);
    const fx = await journeyEngine(ctx, 'home', { extra: SELF_TEST });
    fx.priorQualification = prior;
    let project = null;
    try {
      const qualification = await selfTested(fx, path);

      // The project: a disposable repository with the governed file and the seeded defect.
      let dir = join(ctx.runDir, 'repos', M239.name);
      for (let n = 2; existsSync(dir); n++) dir = join(ctx.runDir, 'repos', `${M239.name}-${n}`);
      mkdirSync(join(ctx.runDir, 'repos'), { recursive: true, mode: 0o700 });
      const toolchain = m239Toolchain(ctx.runDir);
      const repo = makeProjectRepo(dir, { files: { '.surety/checks/protected-policy.json': governedText(M239_GOVERNED(toolchain)), [SEEDED_DEFECT_M3.path]: SEEDED_DEFECT_M3.content } });
      const base = refOid(repo.path, repo.ref);
      ({ id: project } = await createProject(fx.engine, { repoPath: repo.path, name: M239.name, tier: M239.tier }));
      await changePolicy(fx.engine, project, { ...realPolicy(REAL.dayVerifiedUsd.pathOne), backend_builder: REAL.backend, backend_verifier: REAL.backend, backend_reviewer: REAL.backend });
      const journeyBase = refOid(repo.path, repo.ref);
      const initial = await versionRead(fx.engine, project, effectiveVersion(fx.home, project).id);

      // (a) The checks, written first: the stage waits, paused, until they are applied.
      await pauseProject(fx.engine, project);
      const plan = await installGatedPlan(fx.engine, project, { requirements: M239.requirements, constraints: M239.constraints, stages: [M239.stageOne] });
      const stage = plan.stages[0];
      const correction = await addWork(fx.engine, project, 'check_correction');
      await resumeProject(fx.engine, project);
      await tickWhile(fx, project, () => runsOf(fx.home, correction)[0], { timeoutMs: 180_000, everyMs: 3_000, what: "the check_correction work's Verifier run to start" });
      await pauseProject(fx.engine, project);
      const corrRun = await runEnds(fx, project, correction);
      if (corrRun.outcome !== 'completed') notEstablished(path, `the Verifier's check_correction run ended ${corrRun.outcome}/${corrRun.reason_class}`, corrRun.reason_text);
      const captured = proposalsOf(fx.home, project).find((p) => p.run === corrRun.id);
      if (!captured) notEstablished(path, 'the real Verifier changed no protected file, so no proposal was captured', { summary: corrRun.reason_text });
      const classified = await tickWhile(
        fx,
        project,
        () => {
          const row = proposalsOf(fx.home, project).find((p) => p.id === captured.id);
          const c = json(row?.classification);
          return c && typeof c.change_kind === 'string' ? { row, c } : undefined;
        },
        { timeoutMs: 180_000, everyMs: 3_000, what: `the engine's classification of ${captured.id}` },
      );
      const errors = classified.c.discovery?.errors ?? [];
      if (errors.length > 0) notEstablished(path, "the real Verifier's definitions have discovery errors, so no approval could apply them", errors);
      const kind = `check_correction_${classified.c.change_kind}`;
      const answered = await waitForSean(ctx, fx, kind, captured.id, {
        project,
        what: `the classification's decision about the checks the real Verifier wrote (${classified.c.change_kind}). Approving applies them as the project's protected checks; it starts no paid run by itself.`,
        facts: {
          proposal: captured.id,
          class: classified.c.change_kind,
          elements: classified.c.elements,
          'checks discovered': (classified.c.discovery?.checks ?? []).map((c) => c.key ?? c),
          'the proposal tree': captured.tree_id,
        },
      });
      const applied = await tickWhile(fx, project, () => {
        const row = proposalsOf(fx.home, project).find((p) => p.id === captured.id);
        return row?.status === 'applied' ? row : undefined;
      }, { timeoutMs: 300_000, everyMs: 3_000, what: `the application of ${captured.id}` });
      const version = await versionRead(fx.engine, project, effectiveVersion(fx.home, project).id);

      // (b) The stage: a real Builder builds it; the engine runs the checks.
      await resumeProject(fx.engine, project);
      const sampler = sampleDomains(fx.home, project, { intervalMs: 1000 });
      const rounds = [];
      let evaluated = null;
      try {
        for (let round = 0; round < 3; round++) {
          const build = await runEnds(fx, project, stage.work_item, { index: round });
          if (build.outcome !== 'completed') notEstablished(path, `the Builder's run ended ${build.outcome}/${build.reason_class}`, build.reason_text);
          const candidate = await nthCandidate(fx, project, round + 1);
          const settled = await waitSettled(fx, project, candidate.id, `the checks of ${candidate.id}`);
          evaluated = await gatesOn(fx, project, candidate, stage.id);
          rounds.push({ build: runSummary(fx.home, build), candidate: candidate.id, executions: settled.map((x) => executionFacts(fx.home, x)), all_executions: executionsOf(fx.home, candidate.id).map((x) => executionFacts(fx.home, x)), stage_gate: summary(evaluated.stage), alpha_gate: summary(evaluated.alpha), authorization: evaluated.authorization });
          if (evaluated.stage.outcome === 'satisfied' && evaluated.alpha.outcome === 'satisfied') break;
          const item = workItem(fx.home, stage.work_item);
          if (item.status !== 'eligible' && item.status !== 'executing') break; // not sent back for a repair: nothing more to wait for
        }
      } finally {
        observe(ctx, 'M239', 'path_one_domain_samples', sampler.stop());
      }
      const last = rounds.at(-1);
      const out = {
        project,
        repo: repo.path,
        base,
        journey_base: journeyBase,
        qualification,
        initial_version: { id: initial.id, checks: initial.checks.map((c) => c.key), discovery_errors: initial.discovery_errors },
        correction: { work_item: correction, run: runSummary(fx.home, corrRun) },
        proposal: { id: captured.id, class: classified.c.change_kind, elements: classified.c.elements, classifier_version: classified.c.classifier_version, discovery_errors: errors, decision: answered.id, decision_kind: kind, answer: answered.answer?.option ?? null, status: applied.status, resulting_version: applied.resulting_version },
        version: { id: version.id, change_kind: version.change_kind, discovery_errors: version.discovery_errors, checks: version.checks.map(checkFacts) },
        stage: stage.id,
        rounds,
        candidate: last.candidate,
        stage_gate: last.stage_gate.outcome,
        alpha_gate: last.alpha_gate.outcome,
        authorization: last.authorization,
        stage_status: workItem(fx.home, stage.work_item).status,
      };
      observe(ctx, 'M239', 'path_one', out);
      if (out.stage_gate !== 'satisfied' || out.alpha_gate !== 'satisfied') notEstablished(path, 'a gate is not satisfied on the last candidate', { stage: last.stage_gate, alpha: last.alpha_gate });
      return out;
    } finally {
      await pauseQuietly(fx, project);
      await fx.engine.stop();
    }
  });
}

// ---- path two: a seeded defect, the real Verifier's finding, the fix, the resolution ----

export async function checksPathTwo(ctx) {
  return realStep(ctx, 'm3_path_two', async () => {
    const path = 'M239 path two';
    const one = stepValue(ctx, 'm3_path_one');
    const home = join(ctx.runDir, 'home');
    // Every earlier project of the journey (path one's, an earlier try's) is paused, or has nothing to dispatch.
    refuseLeftovers(path, leftovers(home), { evenIfPaused: false });
    // The checks path one's real Verifier wrote and Sean approved: the protected files of path one's
    // effective version, read from its authorized revision before any engine starts (SEAM.md §241).
    const carried = protectedFilesOf(home, one);
    const prior = priorQualification(ctx);
    const fx = await journeyEngine(ctx, 'home', { extra: SELF_TEST });
    fx.priorQualification = prior;
    let project = null;
    try {
      const qualification = await selfTested(fx, path);
      // A project of its own (the second try's finding, SEAM.md §241): path one's project holds the
      // integrations of any earlier try of this path, the seeded defect's fix among them, so it can no
      // longer show a defect being found. This one starts from the seeded defect and the carried checks.
      let dir = join(ctx.runDir, 'repos', `${M239.name}-two`);
      for (let n = 2; existsSync(dir); n++) dir = join(ctx.runDir, 'repos', `${M239.name}-two-${n}`);
      const repo = makeProjectRepo(dir, { files: { [SEEDED_DEFECT_M3.path]: SEEDED_DEFECT_M3.content } });
      commitEntries(repo.path, repo.ref, carried.entries, `fixture: the checks of path one's version ${carried.version}, as Sean approved them`);
      ({ id: project } = await createProject(fx.engine, { repoPath: repo.path, name: `${M239.name}-two`, tier: M239.tier }));
      await changePolicy(fx.engine, project, { ...realPolicy(REAL.dayVerifiedUsd.pathOne), backend_builder: REAL.backend, backend_verifier: REAL.backend, backend_reviewer: REAL.backend, repair_attempts_max: 0 });
      await pauseProject(fx.engine, project);
      const before = 0;
      const plan = await installGatedPlan(fx.engine, project, { requirements: M239.requirements, constraints: M239.constraints, stages: [{ ...M239.stageTwo, number: 1 }] });
      const stage = plan.stages[0];
      const version = await versionRead(fx.engine, project, effectiveVersion(fx.home, project).id);
      if (version.discovery_errors.length > 0) notEstablished(path, "the carried checks have discovery errors in path two's project", version.discovery_errors);
      await resumeProject(fx.engine, project);
      const build = await runEnds(fx, project, stage.work_item);
      if (build.outcome !== 'completed') notEstablished(path, `the stage's Builder run ended ${build.outcome}/${build.reason_class}`, build.reason_text);
      const first = await nthCandidate(fx, project, before + 1);
      const firstSettled = await waitSettled(fx, project, first.id, `the checks of ${first.id}`);
      const reviewRange = reviewRangeOf(fx.home, project, repo.path, first.revision);

      // The Verifier on the stage's candidate.
      const verification = await tickWhile(fx, project, () => workItemsOf(fx.home, project).find((w) => w.kind === 'verification' && w.subject?.candidate === first.id), { timeoutMs: 180_000, everyMs: 5_000, what: `verification work for ${first.id}` });
      await throughBoundary(fx, project, verification.id);
      const vRun = await runEnds(fx, project, verification.id);
      if (vRun.outcome !== 'completed') notEstablished(path, `the Verifier's run ended ${vRun.outcome}/${vRun.reason_class}`, vRun.reason_text);
      const found = findingsOf(fx.home, project).find((f) => f.criterion === M239.defectCriterion && typeof f.check === 'string' && f.check.length > 0);
      if (!found) notEstablished(path, `the real Verifier reported no finding naming the criterion ${M239.defectCriterion} and a check`, findingsOf(fx.home, project).map((f) => ({ id: f.id, criterion: f.criterion, check: f.check, severity: f.severity, message: f.message })));
      const blockedOnFirst = await gatesOn(fx, project, first, stage.id);

      // A Reviewer on that candidate (the review a T1 project's cadence does not queue, triggered by the fixture).
      const reviewItem = await addWork(fx.engine, project, 'review', { subject: { candidate: first.id } });
      const rRun = await runEnds(fx, project, reviewItem);
      if (rRun.outcome !== 'completed') notEstablished(path, `the Reviewer's run ended ${rRun.outcome}/${rRun.reason_class}`, rRun.reason_text);
      const fix = workItemsOf(fx.home, project).find((w) => w.kind === 'fix' && w.subject?.finding === found.id);
      if (!fix) notEstablished(path, 'the real Reviewer did not disposition the finding fix, so no fix work was registered', findingRow(fx.home, found.id));
      const dispositioned = findingRow(fx.home, found.id);

      // The fix, by a real Builder; the engine runs the checks on the fix's candidate.
      await throughBoundary(fx, project, fix.id);
      const fRun = await runEnds(fx, project, fix.id);
      if (fRun.outcome !== 'completed') notEstablished(path, `the fix's Builder run ended ${fRun.outcome}/${fRun.reason_class}`, fRun.reason_text);
      const fixCandidate = await nthCandidate(fx, project, before + 2);
      const fixSettled = await waitSettled(fx, project, fixCandidate.id, `the checks of ${fixCandidate.id}`);
      const evaluated = await gatesOn(fx, project, fixCandidate, stage.id);
      const resolved = findingRow(fx.home, found.id);
      const named = version.checks.find((c) => c.key === found.check) ?? null;
      const resolvingResult = resolved.resolution_verification?.check_result ? resultRow(fx.home, resolved.resolution_verification.check_result) : null;
      const resolvingExecution = resolvingResult ? executionsOf(fx.home, fixCandidate.id).find((x) => x.id === resolvingResult.execution) ?? null : null;
      const out = {
        project,
        repo: repo.path,
        carried: { from_project: one.project, version: carried.version, revision: carried.revision, files: Object.keys(carried.entries), initial_version: { id: version.id, change_kind: version.change_kind, checks: version.checks.map((c) => c.key) } },
        qualification,
        stage: stage.id,
        candidates: [first.id, fixCandidate.id],
        review_range: reviewRange,
        first_executions: firstSettled.map((x) => executionFacts(fx.home, x)),
        fix_executions: fixSettled.map((x) => executionFacts(fx.home, x)),
        all_executions: [first.id, fixCandidate.id].flatMap((c) => executionsOf(fx.home, c).map((x) => executionFacts(fx.home, x))),
        finding: { id: found.id, criterion: found.criterion, check: found.check, severity: found.severity, message: found.message, disposition: dispositioned.disposition, disposition_seq: dispositioned.disposition_seq },
        named_check: named ? checkFacts(named) : null,
        blocked_on_first: { stage: summary(blockedOnFirst.stage), alpha: summary(blockedOnFirst.alpha) },
        fix: fix.id,
        runs: [build, vRun, rRun, fRun].map((r) => runSummary(fx.home, r)),
        stage_gate: summary(evaluated.stage),
        alpha_gate: summary(evaluated.alpha),
        authorization: evaluated.authorization,
        resolved: { status: resolved.status, resolution_verification: resolved.resolution_verification },
        resolving: resolvingExecution ? executionFacts(fx.home, resolvingExecution) : null,
        fix_status: workItem(fx.home, fix.id).status,
        stage_status: workItem(fx.home, stage.work_item).status,
      };
      observe(ctx, 'M239', 'path_two', out);
      if (resolved.status !== 'resolved') notEstablished(path, 'the finding was not resolved on the fix\'s candidate', out.resolved);
      return out;
    } finally {
      await pauseQuietly(fx, project);
      await fx.engine.stop();
    }
  });
}

// Every check result of the project: the engine's own execution, never a fixture's.
export function projectResults(ctx, project) {
  return resultsOfProject(join(ctx.runDir, 'home'), project);
}
