// The real deployment journey (M4 slice 30; row M342; M4 plan §3.8 M342;
// D4-T04; D4 §9.4; E95 Q10; BS4 §12; E121 item 4, questions 5 and 6;
// SEAM.md §336). PAID, by Sean's command only, on his subscription token,
// through M2's and M3's real-lane harness (lane.mjs, attempt.mjs,
// checks-journey.mjs): the same run directory, preflight, steps, halts,
// reruns and waits. The command and Sean's steps are
// docs/acceptance/reports/M4-real-lane/README.md.
//
// One temporary project from the reference project's spec (SEAM.md §325):
// T1; R1 (src/sum.mjs) and R2 (server.mjs, the HTTP service, with the user
// operation GET /sum?a=2&b=3 answering {"sum": 5}); criteria R1.1 and R2.1
// (the shared plan fixture's); one stage implementing both. The governed
// file names one program, a pinned copy of the engine's node, and no check.
// Environment `alpha` is the owner's configuration, written by the runner
// through the production route (PUT …/environments/alpha/config): the
// engine's own node by path and hash, `node server.mjs`, a free port, and
// one disposable random secret the runner makes in the run directory
// (`deploy/ref_secret`, REF_SECRET), never one of Sean's credentials (D4
// §7.4; BS4 §12).
//
// The steps (BS4 §12), each run at most once per run directory:
//   m4_attempt, m4_activation  M2's: Sean's `qualification_approval` (three
//                              paid canaries) and `trust_activation`;
//   m4_checks    (paid)  a real Verifier writes the workspace acceptance
//                        checks and the `post_deploy_behavior` check in
//                        `check_correction` work; Sean answers the
//                        classification's decision;
//   m4_build     (paid)  a real Builder builds the service; the engine runs
//                        the workspace checks; the stage gate on them;
//   m4_qualify   (free)  the runner prints, and waits for, Sean's own
//                        `surety qualify-adapter local_service` (question 6);
//   m4_deploy    (free)  the runner writes the configuration, prints it with
//                        the command, and waits for Sean's own `surety
//                        deploy`; the engine deploys, verifies through the
//                        real Verifier's check and completes; the host is read
//                        while the service runs; the teardown follows in
//                        `finally`, whatever happened;
//   m4_teardown  (free)  the engine's teardown of `alpha`, applied; nothing
//                        of the run home's prefix left; the journals searched.
// A rerun names the step to run again (SURETY_REAL_RERUN=m4_deploy); that
// step and the steps after it run, and nothing before it (lane.mjs `order`).
//
// What stays a fixture, labelled (as M239's): the approved plan with its
// texts and index (spec approval is not built) and the first
// `check_correction`'s trigger; the journey's engine runs in the test mode
// of the real lane for them (`--harness-real-lane`), with the real adapter
// (`--harness-deploy-adapter real`) and the runner's own self-test. No check
// result and no qualification is a fixture's: the runner is qualified by its
// self-test at each start, the adapter by Sean's command.
//
// SAFETY (BS4 §4.1; E64; D4 §9.5). Nothing here creates, stops, restarts
// or resets a unit, signals a process or writes to a cgroup: every unit is
// the engine's, under the run home's own prefix, created and removed through
// its adapter. The host is only read: `systemctl --user show` and `list-units`
// (filtered here in JavaScript), cgroup files, /proc, `journalctl --user -u`
// of exact names. Before any step that starts an engine (but the teardown),
// a unit of the run home's prefix still loaded refuses the step. A teardown
// that is not applied, or that leaves anything of the prefix, halts the run
// directory and prints the exact names for Sean; nothing is cleaned by the
// test and nothing by pattern. The token is read from its file into memory
// only, to be searched for (lane.mjs), and never printed.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { CLI, freePort } from '../engine.mjs';
import { authorizationsOf, effectiveVersion, evaluationsOf, installGatedPlan, proposalsOf, stageGate } from '../gates.mjs';
import { changePolicy, createProject } from '../journal.mjs';
import { makeProjectRepo } from '../repos.mjs';
import { addWork, pauseProject, resumeProject, runsOf, workItem } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { executionsOf, governedText, resultsOfProject, versionRead } from '../checks/fixtures.mjs';
import { activeQualification } from '../checks/execution.mjs';
import { RUNTIME, attemptIntent, attemptsOf, candidateRow, configContent, configure, deployWork, environmentRecord, homeHash, operationsOf, roundsOf, unitPrefix, verificationsOf } from '../deploy/kernel.mjs';
import { CGROUP_ROOT } from '../sandbox/cgroup.mjs';
import { REAL_ADAPTER, UNIT_PROPS, cgroupsNamed, holdsAny, intendedUnits, journalOf, listUnits, serviceDomainOf, serviceLinkLogs, transientUnitText, unitShow, unitShowAll } from '../deploy/host.mjs';
import { ADAPTER_CASES, LOCAL_SERVICE_VERSION, adapterQualifications, evidenceOf, leftOnHost, qualificationEnvironment, qualificationRow, qualificationRuns } from '../deploy/qualify.mjs';
import { POLICY, SECRET_REF, SECRET_VAR, roundChecks } from '../project/service.mjs';
import { realPolicy } from './attempt.mjs';
import { M239_GOVERNED, SELF_TEST, checkFacts, executionFacts, leftovers, m239Toolchain, nthCandidate, pauseQuietly, refuseLeftovers, runSummary, selfTested, summary, waitSettled } from './checks-journey.mjs';
import { runEnds } from './journey.mjs';
import { REAL, RUN_BILLABLE_MAX_USD, journeyEngine, observe, realStep, sampleDomains, stepValue, tellSean, tickWhile, waitForSean } from './lane.mjs';

// ---- the project, the steps, the cost ------------------------------------------------------

// The steps in the order they run (BS4 §12); a rerun of one runs it and those after it.
export const M342_STEPS = Object.freeze(['m4_attempt', 'm4_activation', 'm4_checks', 'm4_build', 'm4_qualify', 'm4_deploy', 'm4_teardown']);

export const M342 = Object.freeze({
  name: 'real-deployment-journey',
  tier: 'T1',
  environment: 'alpha',
  requirements: [
    { key: 'R1', text: 'src/sum.mjs exports a function sum(a, b) that returns the sum of the numbers a and b. For example sum(2, 3) returns 5.' },
    {
      key: 'R2',
      text:
        "server.mjs, at the root of the repository, is an HTTP service written with Node's built-in node:http module only. " +
        'It listens on 127.0.0.1 at the port named by the environment variable PORT. ' +
        'At start it requires the environment variable REF_SECRET to be set and not empty; otherwise it writes one line to standard error and exits with status 1. It never prints or logs the value of REF_SECRET. ' +
        'GET /health answers 200 with the JSON body {"ok": true}. ' +
        'GET /sum?a=<number>&b=<number> answers 200 with the JSON body {"sum": <a + b>}, computed with sum from src/sum.mjs, so GET /sum?a=2&b=3 answers {"sum": 5}; when a or b is not a number it answers 400. Any other request answers 404. ' +
        'This is the user operation of the deployed service: a user sums two numbers through GET /sum.',
    },
  ],
  constraints: [
    { key: 'C1', text: 'Plain JavaScript ES modules (.mjs files) with no dependencies. Do not add a package.json.' },
    // As M239's C2: a T1 project's engine nominates a Builder's work only when the Builder asks.
    { key: 'C2', text: 'A Builder, when its change is done, sets "nominate": true in its result, so that the engine nominates the change as a candidate and runs the project\'s checks on it.' },
    { key: 'C3', text: 'The service is deployed to the environment alpha and started there as `node server.mjs`, with PORT and REF_SECRET in its environment. It must not change its process title or its arguments.' },
  ],
  stage: { number: 1, goal: 'Implement R1 and R2: write src/sum.mjs and server.mjs as they describe.', implements: ['R1', 'R2'] },
});

// The runs a journey can pay for: the attempt's three canaries (if the run
// directory has no active entry), one Verifier authoring run and one to
// three Builder runs (BS4 §12). What each can cost at most, stated before
// anything starts (SEAM.md §161's form).
export function costStatement() {
  const roles = 4;
  return [
    'SURETY REAL LANE, M4 (row M342): what this run can cost, before anything starts.',
    `Expected: under 1 USD in Claude Code's own estimates (BS4 §12; M3's runs cost 0.04 to 0.07 USD each), drawn from your subscription's usage limits, which your own Claude use shares.`,
    `At most, in billable tokens alone: each run is bounded by ${REAL.runBillableTokens} billable tokens, ${RUN_BILLABLE_MAX_USD.toFixed(2)} USD at the dearest rate (${REAL.usdPerMillion.output} USD per million output tokens);`,
    `  the journey's ${roles} role runs (one Verifier, up to three Builders): ${(roles * RUN_BILLABLE_MAX_USD).toFixed(2)} USD, stopped earlier by the project's day limit of ${REAL.dayVerifiedUsd.pathOne} USD in estimates;`,
    `  a new qualification attempt, only if the run directory has none: 3 canaries, ${(3 * RUN_BILLABLE_MAX_USD).toFixed(2)} USD, within the fixture project's day limit of ${REAL.dayVerifiedUsd.qualification} USD;`,
    '  plus cache reads (not counted by the run limit) and any overshoot until a run\'s deadline (D2 §4.2, §8 class C).',
    "The only hard maximum is your subscription's own usage limits. The qualification, the deployment, the identity reads, the checks and the teardown call no model.",
    'An estimate, not a cap and not an authorization (D4 §9.4). Nothing paid starts before your qualification_approval, your trust_activation and your answer to the checks\' decision.',
  ].join('\n');
}

let costShown = false;
export function showCost(ctx) {
  if (costShown) return;
  costShown = true;
  process.stderr.write(`\n${'='.repeat(78)}\n${costStatement()}\n${'='.repeat(78)}\n`);
  observe(ctx, 'M342', 'cost_statement', costStatement());
}

// What Sean is told the activation lets run (attempt.mjs `activation`).
export const M342_JOURNEY = Object.freeze({ name: 'the M4 real deployment journey (M342)', limits: `its one project has a day limit of ${REAL.dayVerifiedUsd.pathOne} USD in estimates` });

// ---- the run home, its units, its secret, its engine ----------------------------------------

export const homeOf = (ctx) => join(ctx.runDir, 'home');
const runHomePrefix = (ctx) => `surety-${homeHash(homeOf(ctx))}-`;

const notEstablished = (path, what, detail) => {
  throw new Error(`${path} not established: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 900)})`}`);
};

// Every unit the user manager has loaded under the run home's prefix, by
// exact name (a read; the list is filtered here). Unread is a refusal, never "none".
export function unitsOfRunHome(ctx, path = 'M342') {
  const units = listUnits();
  if (units === null) throw new Error(`${path} refused: the user units could not be listed (systemctl --user list-units), so what is loaded is unknown. Nothing was started.`);
  return units.filter((u) => u.unit.startsWith(runHomePrefix(ctx))).map((u) => u.unit);
}

// BS4 §12: a rerun refuses while any unit of the run home's prefix is loaded.
function refuseLoadedUnits(ctx, path) {
  const left = unitsOfRunHome(ctx, path);
  if (left.length === 0) return;
  tellSean(
    ctx,
    [
      `SURETY REAL LANE: ${path} refused before starting anything: units of this run home's prefix are loaded.`,
      ...left.map((u) => `  ${u}`),
      'Each was created by this run home\'s engine. A rerun of m4_teardown asks the engine to tear the environment down;',
      'or stop one yourself by its exact name: systemctl --user stop -- <name>. Nothing is cleaned by the test, and nothing by pattern.',
    ].join('\n'),
  );
  throw new Error(`${path} refused: units of the run home's prefix are loaded (${left.join(', ')}). Nothing was started.`);
}

// The journey's projects in the home (an earlier try's included).
const journeyProjects = (home) =>
  existsSync(join(home, 'store.db')) ? withStore(home, (db) => db.prepare('SELECT "id" FROM "projects" WHERE "name" LIKE ?').all(`${M342.name}%`).map((r) => r.id)) : [];

// The one disposable secret of the service (D4 §7.4; BS4 §12): random,
// made once in the run directory (outside the engine home, which
// `--secret-file` refuses), 0600, never printed, never one of Sean's.
export function deploySecretFile(ctx) {
  const dir = join(ctx.runDir, 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'ref_secret');
  if (!existsSync(file)) writeFileSync(file, `surety-m4-ref-${randomBytes(18).toString('hex')}`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// The journey's engine: the run home in the real lane's test mode, with the
// runner's self-test, the real adapter and the service's secret by reference.
const engineFor = (ctx) => journeyEngine(ctx, 'home', { extra: [...SELF_TEST, ...REAL_ADAPTER, '--secret-file', `${SECRET_REF}=${deploySecretFile(ctx)}`] });

const priorQualification = (ctx) => (existsSync(join(homeOf(ctx), 'store.db')) ? (activeQualification(homeOf(ctx))?.id ?? null) : null);

async function startJourneyEngine(ctx, path) {
  const prior = priorQualification(ctx);
  const fx = await engineFor(ctx);
  fx.priorQualification = prior;
  return fx;
}

// The owner's configuration of `alpha` (SEAM.md §§245, 325): the engine's
// own node by path and hash, `node server.mjs`, a port free now, the one
// secret by reference.
export const m342Config = (port) => configContent({ adapter_version: LOCAL_SERVICE_VERSION, port, start: [RUNTIME.path, 'server.mjs'], secrets: { [SECRET_VAR]: SECRET_REF } });

const runCount = (home) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "runs"').get().n);
const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const gateEvaluation = (home, id) => {
  const row = id ? withStore(home, (db) => db.prepare('SELECT * FROM "gate_evaluations" WHERE "id" = ?').get(id)) : null;
  return row ? { id: row.id, gate_kind: row.gate_kind, outcome: row.outcome, reasons: json(row.reasons), check_states: json(row.check_states), checks: json(row.checks) } : null;
};

// Poll a store or host read (no tick) until it answers, on the monotonic clock.
async function pollUntil(probe, { timeoutMs, everyMs = 5_000, what }) {
  const until = performance.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() > until) throw new Error(`no ${what} within ${Math.round(timeoutMs / 60_000)} minutes; nothing further was started`);
    await sleep(everyMs);
  }
}

// The command Sean runs, as he would type it (the CLI of this checkout, the engine's node).
const cliLine = (home, args) => `SURETY_HOME=${home} ${process.execPath} ${CLI} ${args.join(' ')}`;

// In a rehearsal (SEAM.md §171) the harness runs Sean's command itself, after printing it.
function rehearsalCommand(ctx, home, args) {
  tellSean(ctx, `SURETY REAL LANE REHEARSAL: the harness runs Sean's command itself (SURETY_REAL_REHEARSAL=1):\n  ${cliLine(home, args)}`);
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, SURETY_HOME: home } });
  return { status: done.status, stdout: (done.stdout ?? '').slice(0, 4000), stderr: (done.stderr ?? '').slice(0, 4000) };
}

// ---- m4_checks: the real Verifier writes the checks; Sean answers ----------------------------

export async function m4Checks(ctx) {
  return realStep(ctx, 'm4_checks', async () => {
    const path = 'M342 (a), the checks';
    const home = homeOf(ctx);
    refuseLoadedUnits(ctx, path);
    refuseLeftovers(path, leftovers(home, journeyProjects(home)), { evenIfPaused: false });
    const fx = await startJourneyEngine(ctx, path);
    let project = null;
    try {
      const qualification = await selfTested(fx, path);

      // The project: a disposable repository holding the governed file and nothing else of its checks.
      let dir = join(ctx.runDir, 'repos', M342.name);
      for (let n = 2; existsSync(dir); n++) dir = join(ctx.runDir, 'repos', `${M342.name}-${n}`);
      mkdirSync(join(ctx.runDir, 'repos'), { recursive: true, mode: 0o700 });
      const toolchain = m239Toolchain(ctx.runDir);
      const repo = makeProjectRepo(dir, { files: { '.surety/checks/protected-policy.json': governedText(M239_GOVERNED(toolchain)) } });
      ({ id: project } = await createProject(fx.engine, { repoPath: repo.path, name: M342.name, tier: M342.tier }));
      await changePolicy(fx.engine, project, { ...realPolicy(REAL.dayVerifiedUsd.pathOne), ...POLICY, backend_builder: REAL.backend, backend_verifier: REAL.backend, backend_reviewer: REAL.backend });
      // The owner's configuration first, so that the Verifier's package can name the environment's target.
      const configured = await configure(fx.engine, project, M342.environment, m342Config(await freePort()));
      const initial = await versionRead(fx.engine, project, effectiveVersion(fx.home, project).id);

      // (a) The checks, written first: the stage waits, paused, until they are applied (M239's order).
      await pauseProject(fx.engine, project);
      const plan = await installGatedPlan(fx.engine, project, { requirements: M342.requirements, constraints: M342.constraints, stages: [M342.stage] });
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
      if (errors.length > 0) notEstablished(path, "the real Verifier's definitions have discovery errors, so no approval could apply them; Sean is not asked", errors);
      // Before Sean is asked: where the discovery names kinds, a post_deploy_behavior check must be among them.
      const discovered = classified.c.discovery?.checks ?? [];
      const kinds = discovered.map((c) => (c && typeof c === 'object' ? (c.kind ?? c.definition?.kind) : undefined)).filter(Boolean);
      if (kinds.length > 0 && !kinds.includes('post_deploy_behavior')) notEstablished(path, 'the real Verifier wrote no post_deploy_behavior check, so no deployment could be completed; Sean is not asked', discovered);
      const kind = `check_correction_${classified.c.change_kind}`;
      const answered = await waitForSean(ctx, fx, kind, captured.id, {
        project,
        what: `the classification's decision about the checks the real Verifier wrote for the deployment journey (${classified.c.change_kind}): its workspace checks and its post_deploy_behavior check. Approving applies them as the project's protected checks; it starts no paid run by itself.`,
        facts: {
          proposal: captured.id,
          class: classified.c.change_kind,
          elements: classified.c.elements,
          'checks discovered': discovered.map((c) => (c && typeof c === 'object' ? `${c.key ?? '?'} (${c.kind ?? c.definition?.kind ?? 'kind not shown'})` : c)),
          'the proposal tree': captured.tree_id,
        },
      });
      const applied = await tickWhile(fx, project, () => {
        const row = proposalsOf(fx.home, project).find((p) => p.id === captured.id);
        return row?.status === 'applied' ? row : undefined;
      }, { timeoutMs: 300_000, everyMs: 3_000, what: `the application of ${captured.id}` });
      const version = await versionRead(fx.engine, project, effectiveVersion(fx.home, project).id);
      const checks = version.checks.map((c) => ({ ...checkFacts(c), requires: c.definition?.requires ?? [] }));
      const out = {
        project,
        repo: repo.path,
        toolchain: { node: toolchain.node, sha256: toolchain.sha256 },
        qualification,
        environment: { id: configured.environment.id, name: M342.environment, config: configured.config.id, config_identity: configured.config.config_identity },
        initial_version: { id: initial.id, checks: initial.checks.map((c) => c.key), discovery_errors: initial.discovery_errors },
        stage: stage.id,
        stage_work_item: stage.work_item,
        correction: { work_item: correction, run: runSummary(fx.home, corrRun) },
        proposal: { id: captured.id, class: classified.c.change_kind, elements: classified.c.elements, classifier_version: classified.c.classifier_version, discovery_errors: errors, decision: answered.id, decision_kind: kind, answer: answered.answer?.option ?? null, status: applied.status, resulting_version: applied.resulting_version },
        version: { id: version.id, change_kind: version.change_kind, discovery_errors: version.discovery_errors, checks },
      };
      observe(ctx, 'M342', 'checks', out);
      if (!checks.some((c) => c.kind === 'post_deploy_behavior' && c.required && (c.gate_kinds ?? []).includes('alpha_complete'))) notEstablished(path, 'the applied checks hold no required post_deploy_behavior check of gate kind alpha_complete', checks);
      return out;
    } finally {
      await pauseQuietly(fx, project);
      await fx.engine.stop();
    }
  });
}

// ---- m4_build: a real Builder; the engine runs the workspace checks ------------------------

export async function m4Build(ctx) {
  return realStep(ctx, 'm4_build', async () => {
    const path = 'M342 (b), the build';
    const checks = stepValue(ctx, 'm4_checks');
    const home = homeOf(ctx);
    refuseLoadedUnits(ctx, path);
    refuseLeftovers(path, leftovers(home, journeyProjects(home)), { evenIfPaused: false });
    const fx = await startJourneyEngine(ctx, path);
    const project = checks.project;
    try {
      const qualification = await selfTested(fx, path);
      await resumeProject(fx.engine, project);
      const sampler = sampleDomains(fx.home, project, { intervalMs: 1000 });
      const rounds = [];
      try {
        for (let round = 0; round < 3; round++) {
          const build = await runEnds(fx, project, checks.stage_work_item, { index: round });
          if (build.outcome !== 'completed') notEstablished(path, `the Builder's run ended ${build.outcome}/${build.reason_class}`, build.reason_text);
          const candidate = await nthCandidate(fx, project, round + 1);
          const settled = await waitSettled(fx, project, candidate.id, `the checks of ${candidate.id}`);
          const evaluated = await stageGate(fx, { project: { id: project }, candidate, stage: checks.stage });
          rounds.push({
            build: runSummary(fx.home, build),
            candidate: candidate.id,
            revision: candidate.revision,
            executions: settled.map((x) => executionFacts(fx.home, x)),
            all_executions: executionsOf(fx.home, candidate.id).map((x) => executionFacts(fx.home, x)),
            stage_gate: summary(evaluated),
          });
          if (evaluated.outcome === 'satisfied') break;
          const item = workItem(fx.home, checks.stage_work_item);
          if (item.status !== 'eligible' && item.status !== 'executing') break; // not sent back for a repair
        }
      } finally {
        observe(ctx, 'M342', 'build_domain_samples', sampler.stop());
      }
      const last = rounds.at(-1);
      const out = { project, qualification, rounds, candidate: last.candidate, revision: last.revision, stage_gate: last.stage_gate.outcome, stage_status: workItem(fx.home, checks.stage_work_item).status };
      observe(ctx, 'M342', 'build', out);
      if (out.stage_gate !== 'satisfied') notEstablished(path, 'the stage gate is not satisfied on the last candidate', last.stage_gate);
      return out;
    } finally {
      await pauseQuietly(fx, project);
      await fx.engine.stop();
    }
  });
}

// ---- m4_qualify: Sean's `surety qualify-adapter local_service` -----------------------------

export async function m4Qualify(ctx) {
  return realStep(ctx, 'm4_qualify', async () => {
    const path = 'M342 (c), the adapter qualification';
    stepValue(ctx, 'm4_build');
    const home = homeOf(ctx);
    refuseLoadedUnits(ctx, path);
    refuseLeftovers(path, leftovers(home, journeyProjects(home)), { evenIfPaused: false });
    const fx = await startJourneyEngine(ctx, path);
    try {
      const qualification = await selfTested(fx, path);
      const runsBefore = runCount(fx.home);
      const rowsBefore = new Set(adapterQualifications(fx.home).map((r) => r.id));
      const qrunsBefore = new Set(qualificationRuns(fx.home).map((r) => r.id));
      const args = ['qualify-adapter', 'local_service'];
      const started = performance.now();
      let cli = null;
      if (ctx.rehearsal) cli = rehearsalCommand(ctx, fx.home, args);
      else
        tellSean(
          ctx,
          [
            "SURETY REAL LANE: waiting for Sean's own command (the test will not run it): the adapter's qualification (D4 §2.6; question 6).",
            'It deploys the engine\'s own fixture services under this run home\'s prefix, runs D4 §2.6\'s nine cases with their controls, removes everything it created,',
            'and calls no model: it costs nothing. In another terminal, from any directory:',
            `  ${cliLine(fx.home, args)}`,
            'It prints its answer and exits 0 when the adapter is qualified. This test waits for the run it starts to end.',
            `This test waits ${ctx.waitMinutes} minutes, then stops with nothing further started.`,
          ].join('\n'),
        );
      const ended = await pollUntil(
        () => {
          const run = qualificationRuns(fx.home).find((r) => !qrunsBefore.has(r.id) && r.status !== 'running');
          const row = adapterQualifications(fx.home).find((r) => !rowsBefore.has(r.id) && r.status === 'current');
          return run || row ? { run: run ?? null, row: row ?? null } : undefined;
        },
        { timeoutMs: ctx.waitMinutes * 60_000, everyMs: 5_000, what: "end of Sean's qualify-adapter run" },
      );
      // The row, once the run's record says it ended (they are written together; a short grace for the row).
      let row = ended.row;
      for (let i = 0; i < 6 && !row; i++) {
        await sleep(2_000);
        row = adapterQualifications(fx.home).find((r) => !rowsBefore.has(r.id) && r.status === 'current') ?? null;
      }
      const run = ended.run ?? qualificationRuns(fx.home).find((r) => !qrunsBefore.has(r.id)) ?? null;
      const evidence = row?.evidence ? evidenceOf(fx.home, row.evidence).content : null;
      const env = run ? qualificationEnvironment(fx.home, run.id) : null;
      const out = {
        at: new Date().toISOString(),
        by: ctx.rehearsal ? 'the rehearsal harness (never evidence)' : "Sean's command",
        command: cliLine(fx.home, args),
        cli,
        waited_ms: Math.round(performance.now() - started),
        host_qualification: qualification.id,
        run: run && { id: run.id, status: run.status, cases: run.cases },
        row: row && { id: row.id, status: row.status, label: row.label, adapter: row.adapter, adapter_version: row.adapter_version, engine_build: row.engine_build, host_qualification: row.host_qualification, profile_fingerprint: row.profile_fingerprint, cases: row.cases, evidence: row.evidence },
        evidence: evidence && { tools: evidence.tools ?? null, host_time_ms: evidence.host_time_ms ?? null, identity_reads: evidence.identity_reads ?? null, unread_host_facts: evidence.unread_host_facts ?? [] },
        environment: env && { id: env.id, prefix: env.prefix },
        left: env ? leftOnHost(fx.home, env) : null,
        roles_started: runCount(fx.home) - runsBefore,
      };
      observe(ctx, 'M342', 'qualification', out);
      if (!row) notEstablished(path, 'the qualification did not qualify the adapter (no row current)', out.run);
      return out;
    } finally {
      await fx.engine.stop();
    }
  });
}

// ---- m4_deploy: Sean's `surety deploy`; deploy, verify, complete; the host read ----------------

// The host while the service runs (read only): the unit by its exact name,
// the application in its cgroup, and the token searched for in its
// properties, its transient unit file and its journal (counts only).
function hostWhileRunning(ctx, home, envId, svc) {
  const props = unitShow(svc.unit, UNIT_PROPS);
  const cg = props?.ControlGroup ? join(CGROUP_ROOT, props.ControlGroup) : null;
  let procs = null;
  try {
    procs = cg ? readFileSync(join(cg, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number) : null;
  } catch {
    procs = null;
  }
  let appCgroup = null;
  try {
    appCgroup = svc.app?.pid ? join(CGROUP_ROOT, readFileSync(`/proc/${svc.app.pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? '') : null;
  } catch {
    appCgroup = null;
  }
  const all = unitShowAll(svc.unit);
  const transient = transientUnitText(svc.unit);
  const journal = journalOf(svc.unit);
  const token = { token: ctx.keyValue };
  return {
    at: new Date().toISOString(),
    unit: svc.unit,
    own_prefix: svc.unit.startsWith(unitPrefix(home, envId)),
    props: props && Object.fromEntries(['LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID', 'Delegate', 'Restart', 'MemoryMax', 'MemorySwapMax', 'TasksMax'].map((k) => [k, props[k] ?? null])),
    app: svc.app,
    app_cgroup: appCgroup,
    app_in_unit_tree: cg !== null && appCgroup !== null && (appCgroup === cg || appCgroup.startsWith(`${cg}/`)),
    unit_cgroup_procs: procs,
    unit_property_search: { read: /^Id=/m.test(all), hits: holdsAny(all, token).length },
    transient_file_search: { read: transient !== null, hits: transient === null ? null : holdsAny(transient, token).length },
    journal_search: { status: journal.status, hits: holdsAny(journal.text, token).length },
  };
}

export async function m4Deploy(ctx) {
  return realStep(ctx, 'm4_deploy', async () => {
    const path = 'M342 (c), the deployment';
    const checks = stepValue(ctx, 'm4_checks');
    const build = stepValue(ctx, 'm4_build');
    const qual = stepValue(ctx, 'm4_qualify');
    const home = homeOf(ctx);
    const project = checks.project;
    refuseLoadedUnits(ctx, path);
    // The project is resumed below: nothing earlier of it may be dispatchable, paused or not (M239's S1).
    refuseLeftovers(path, leftovers(home, journeyProjects(home)), { evenIfPaused: true });
    const fx = await startJourneyEngine(ctx, path);
    const out = { project, candidate: build.candidate, environment: null };
    let failure = null;
    try {
      out.host_qualification = (await selfTested(fx, path)).id;
      const current = qualificationRow(fx.home, qual.row.id);
      out.qualification_at_start = current && { id: current.id, status: current.status, lapsed_reason: current.lapsed_reason ?? null };
      if (current?.status !== 'current') notEstablished(path, `the adapter's qualification ${qual.row.id} is not current at this start (rerun m4_qualify)`, out.qualification_at_start);
      const runsBefore = runCount(fx.home);

      // The owner's configuration, written again with a port free now, and printed for Sean.
      const content = m342Config(await freePort());
      const configured = await configure(fx.engine, project, M342.environment, content);
      const env = { id: configured.environment.id, name: M342.environment };
      out.environment = env;
      out.config = { id: configured.config.id, version: configured.config.version, config_identity: configured.config.config_identity, content: { ...content, secrets: { [SECRET_VAR]: SECRET_REF } } };
      await resumeProject(fx.engine, project);
      const workBefore = new Set(deployWork(fx.home, project).map((w) => w.id));
      const opsBefore = new Set(operationsOf(fx.home, project, 'deploy').map((o) => o.id));
      const args = ['deploy', build.candidate, '--env', M342.environment, '--project', project];
      out.command = cliLine(fx.home, args);
      if (ctx.rehearsal) out.cli = rehearsalCommand(ctx, fx.home, args);
      else
        tellSean(
          ctx,
          [
            "SURETY REAL LANE: waiting for Sean's own deployment request (the test will not make it; Q3, question 6).",
            `The candidate: ${build.candidate} at ${build.revision}, its workspace checks recorded and the stage gate satisfied (M342 (b)).`,
            `The environment ${M342.environment}'s configuration, written by the runner through the owner's route (version ${configured.config.version}, ${configured.config.config_identity}):`,
            ...JSON.stringify(out.config.content, null, 2).split('\n').map((l) => `  ${l}`),
            `(${SECRET_VAR} is the disposable random secret ${SECRET_REF}, made by the runner in the run directory: not one of your credentials.)`,
            'The deployment calls no model: it costs nothing. In another terminal:',
            `  ${out.command}`,
            'It prints the authorization and the deploy work item, or the gate\'s reasons if refused. The engine then deploys, verifies and completes;',
            'the runner tears the environment down afterwards, whatever happens.',
            `This test waits ${ctx.waitMinutes} minutes for the request, then tears down what exists and stops.`,
          ].join('\n'),
        );
      const work = await pollUntil(() => deployWork(fx.home, project).find((w) => !workBefore.has(w.id)), { timeoutMs: ctx.waitMinutes * 60_000, everyMs: 5_000, what: "Sean's deployment request" });
      const authorization = authorizationsOf(fx.home, build.candidate).find((a) => a.id === work.subject?.authorization) ?? null;
      out.request = {
        work_item: work.id,
        trigger: { source: work.trigger_source ?? null, id: work.trigger_id ?? null, generation: work.trigger_generation ?? null },
        authorization: authorization && { id: authorization.id, status_at_request: authorization.status, environment: authorization.environment, artifact_digest: authorization.artifact_digest, config_identity: authorization.config_identity, target_set: json(authorization.target_set), evaluation: authorization.evaluation },
        alpha_authorize: gateEvaluation(fx.home, authorization?.evaluation),
      };
      const op = await tickWhile(fx, project, () => operationsOf(fx.home, project, 'deploy').find((o) => !opsBefore.has(o.id)), { timeoutMs: 600_000, everyMs: 5_000, what: 'the deploy operation' });
      const found = await tickWhile(
        fx,
        project,
        () => {
          const round = roundsOf(fx.home, op.id).at(-1);
          const row = round ? verificationsOf(fx.home, round.id).at(-1) : undefined;
          return row ? { round, row } : undefined;
        },
        { timeoutMs: 2_400_000, everyMs: 5_000, what: "the verification row of the deploy's round" },
      );
      const attempts = attemptsOf(fx.home, op.id);
      const attempt = attempts.at(-1);
      const intent = attemptIntent(fx.home, attempt.id);
      const svc = { unit: intent?.create_units?.[0] ?? null, app: attempt.app_instance, init: attempt.init_instance };
      out.operation = { id: op.id, authorization: op.finalizer_inputs?.authorization ?? null, attempts: attempts.map((a) => ({ id: a.id, number: a.attempt_number, status: a.status, generation: a.deployment_generation, launch_state: a.launch_state, last_read: a.reconciliation_reads?.at(-1)?.result ?? null })) };
      out.service = { unit: svc.unit, unit_pattern: svc.unit ? svc.unit.startsWith(unitPrefix(home, env.id)) && /-g[1-9][0-9]*\.service$/.test(svc.unit) : false, init: svc.init, app: svc.app, domain: (() => { const d = serviceDomainOf(fx.home, attempt.id); return d && { id: d.id, profile: d.profile, cgroup_path: d.cgroup_path }; })() };
      if (svc.unit) out.host = hostWhileRunning(ctx, home, env.id, svc);
      const xs = roundChecks({ fx }, found.round);
      const links = serviceLinkLogs(fx.home, project);
      out.round = { id: found.round.id, round: found.round.round, required_checks: found.round.required_checks };
      out.verification = { id: found.row.id, outcome: found.row.outcome, identity_reads: found.row.identity_reads, missing: found.row.missing };
      out.post_deploy = xs.map((x) => ({
        execution: x.id,
        key: x.key,
        status: x.status,
        domain: x.domain && { id: x.domain.id, profile: x.domain.profile, check_execution: x.domain.check_execution },
        result: x.result && { id: x.result.id, execution: x.result.execution, execution_established: x.result.execution_established, exit_status: x.result.exit_status, runner_id: x.result.runner_id },
        link: links.filter((l) => l.entries.some((e) => e.execution === x.id)).flatMap((l) => l.entries.filter((e) => e.execution === x.id)).map((e) => ({ decision: e.decision, round: e.round, attempt: e.attempt, generation: e.generation, limit: e.limit ?? null })),
      }));
      out.kinds = Object.fromEntries((checks.version?.checks ?? []).map((c) => [c.key, c.kind]));
      out.completed = await tickWhile(fx, project, () => (candidateRow(fx.home, build.candidate)?.progress === 'alpha_deployed' ? true : undefined), { timeoutMs: 600_000, everyMs: 5_000, what: 'the candidate to be alpha_deployed' }).catch((err) => ({ not_reached: err.message }));
      out.progress = candidateRow(fx.home, build.candidate)?.progress ?? null;
      out.alpha_complete = (() => { const e = evaluationsOf(fx.home, build.candidate, 'alpha_complete').at(-1); return e ? { id: e.id, outcome: e.outcome, reasons: json(e.reasons) } : null; })();
      out.last_verified = environmentRecord(fx.home, env.id)?.last_verified ?? null;
      out.authorization_after = (() => { const a = authorizationsOf(fx.home, build.candidate).find((r) => r.id === authorization?.id); return a ? { id: a.id, status: a.status } : null; })();
      out.deploy_work = deployWork(fx.home, project).filter((w) => !workBefore.has(w.id)).map((w) => w.id);
      out.deploy_operations = operationsOf(fx.home, project, 'deploy').filter((o) => !opsBefore.has(o.id)).map((o) => o.id);
      out.roles_started = runCount(fx.home) - runsBefore;
      if (out.completed !== true) notEstablished(path, 'the candidate did not reach alpha_deployed', { verification: out.verification, alpha_complete: out.alpha_complete });
      return out;
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      observe(ctx, 'M342', failure ? 'deploy_not_established' : 'deploy', { ...out, failure: failure ? String(failure.message).slice(0, 1500) : null });
      // Every run ends with the environment's teardown (BS4 §12), its own step.
      try {
        await m4Teardown(ctx, fx);
      } catch (err) {
        process.stderr.write(`M342: the teardown step failed: ${String(err.message).slice(0, 800)}\n`);
      }
      await pauseQuietly(fx, project);
      await fx.engine.stop();
    }
  });
}

// ---- m4_teardown: the engine's teardown, applied; nothing of the prefix left ----------------

export async function m4Teardown(ctx, given = null) {
  return realStep(ctx, 'm4_teardown', async () => {
    const path = 'M342 (d), the teardown';
    const checks = stepValue(ctx, 'm4_checks');
    const home = homeOf(ctx);
    const project = checks.project;
    let fx = given;
    if (fx === null) {
      // A rerun of the teardown alone: the project is resumed for the engine's ticks, so nothing
      // earlier of it may be dispatchable, paused or not (M239's S1).
      refuseLeftovers(path, leftovers(home, journeyProjects(home)), { evenIfPaused: true });
      fx = await startJourneyEngine(ctx, path);
      await resumeProject(fx.engine, project);
    }
    try {
      const runsBefore = runCount(fx.home);
      const envRow = withStore(fx.home, (db) => db.prepare('SELECT "id", "name" FROM "environments" WHERE "project" = ? AND "name" = ?').get(project, M342.environment)) ?? null;
      const ofEnv = (kind) => (envRow ? operationsOf(fx.home, project, kind).filter((o) => o.target?.environment === envRow.id) : []);
      const deploys = ofEnv('deploy');
      const loadedBefore = unitsOfRunHome(ctx, path);
      const out = { environment: envRow?.id ?? null, deploys: deploys.map((o) => o.id), loaded_before: loadedBefore, request: null, operation: null, attempt: null, applied: null };
      if (envRow && (deploys.length > 0 || loadedBefore.length > 0)) {
        // Preempting only while the newest deploy is not finalized (D4 §4.6): an exact teardown would wait for its lease.
        const preempt = deploys.length > 0 && !deploys.at(-1).finalized_at;
        const earlier = new Set(ofEnv('teardown').map((o) => o.id));
        const res = await fx.engine.post(`/v1/projects/${project}/environments/${M342.environment}/teardown`, preempt ? { preempt: true } : {});
        out.request = { status: res.status, preempt, code: res.body?.code ?? null };
        if (res.status >= 200 && res.status < 300) {
          const done = await tickWhile(
            fx,
            project,
            () => {
              const t = ofEnv('teardown').find((o) => !earlier.has(o.id) && o.finalized_at);
              if (!t) return undefined;
              const latest = attemptsOf(fx.home, t.id).at(-1);
              return latest && ['succeeded', 'reconciled_succeeded', 'failed', 'reconciled_absent'].includes(latest.status) ? { op: t, attempt: latest } : undefined;
            },
            { timeoutMs: 600_000, everyMs: 5_000, what: 'the teardown of alpha to be finalized' },
          ).catch((err) => ({ error: err.message }));
          if (done.op) {
            out.operation = done.op.id;
            out.attempt = { id: done.attempt.id, status: done.attempt.status, last_read: done.attempt.reconciliation_reads?.at(-1)?.result ?? null };
            out.applied = ['succeeded', 'reconciled_succeeded'].includes(done.attempt.status) && out.attempt.last_read === 'applied';
          } else out.applied = false;
          if (done.error) out.wait_error = done.error;
        } else out.applied = false;
      }
      out.left = {
        units: unitsOfRunHome(ctx, path),
        cgroups: cgroupsNamed(runHomePrefix(ctx)),
        run_files: (() => {
          if (!envRow) return [];
          try {
            return readdirSync(join(home, 'run'), { recursive: true }).map(String).filter((n) => n.includes(envRow.id));
          } catch {
            return [];
          }
        })(),
      };
      // The token in no journal output of any unit the store's intents name (by exact name; read only).
      out.journal_search = intendedUnits(home).map((unit) => {
        const j = journalOf(unit);
        return { unit, status: j.status, hits: holdsAny(j.text, { token: ctx.keyValue }).length };
      });
      out.roles_started = runCount(fx.home) - runsBefore;
      observe(ctx, 'M342', 'teardown', out);
      const clean = out.left.units.length === 0 && out.left.cgroups.length === 0 && out.left.run_files.length === 0;
      if (!clean || out.applied === false) {
        tellSean(
          ctx,
          [
            'SURETY REAL LANE: the teardown was not applied, or something of this run home\'s prefix is left. Nothing is cleaned by the test, and nothing by pattern.',
            ...out.left.units.map((u) => `  unit    ${u}`),
            ...out.left.cgroups.map((c) => `  cgroup  ${c}`),
            ...out.left.run_files.map((f) => `  file    ${join(home, 'run', f)}`),
            'Each was made by this run home\'s engine. To stop a unit yourself, by its exact name: systemctl --user stop -- <name>',
            '(then systemctl --user reset-failed -- <name> if it failed). The run directory is halted; SURETY_REAL_RERUN=m4_teardown asks the engine again.',
          ].join('\n'),
        );
        throw new Error(`${path}: ${out.applied === false ? 'the teardown was not applied' : 'applied'}; left ${JSON.stringify(out.left)}`);
      }
      return out;
    } finally {
      if (given === null) {
        await pauseQuietly(fx, project);
        await fx.engine.stop();
      }
    }
  });
}

// ---- reading the journey's records ---------------------------------------------------------

// Every check result of the project: the engine's own execution, never a fixture's.
export const journeyResults = (ctx, project) => resultsOfProject(homeOf(ctx), project);

export { ADAPTER_CASES };
