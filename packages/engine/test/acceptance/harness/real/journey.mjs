// The real-backend journey (M2 slice 14; row M140; plan row M01 with Claude
// Code in every role; spec R12.1 to R12.4; E59 item 3; SEAM.md §§164, 165).
//
// Row M01's two paths (harness/journey.mjs), with a real agent where M01 has
// a scripted one: a Builder, a Verifier and a Reviewer, each Claude Code on
// claude-sonnet-5-5 under the active entry. What stays a fixture, labelled,
// is what M2 has no real mechanism for: the approved plan and its texts, the
// protected check's declaration and its execution (D3 is not built), and
// the Alpha test target. The chain boundary's `continue` is answered by the
// test as M01's journey answers it (SEAM.md §162): Sean's money decisions are
// the attempt's approval and the entry's activation, and the journey's spend
// is bounded by its projects' limits.
//
// A real agent's behaviour cannot be scripted. Each place where the journey
// needs the agent to do one thing (the Builder's run accepted, the Verifier
// reporting the seeded defect as a finding naming the check, the Reviewer
// choosing `fix`, the Reviewer signing off) is checked when it happens; if it
// did not happen, the path is recorded as not established and the step fails,
// which halts the run directory (E59 item 3: "recorded as not established
// and run once more", by Sean's SURETY_REAL_RERUN; the mixed run is the
// recorded fallback, SURETY_REAL_PATH_TWO=mixed).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { releaseBarrier } from '../engine.mjs';
import { FINDING } from '../journey.mjs';
import { PROTECTED_FILES, alphaTarget, check, findingsOf, installChecks, installGatedPlan, passAll, signoffsOf, stageGate } from '../gates.mjs';
import { Scripted, VALID_RESULT, script, step } from '../scripted.mjs';
import { armBarrier, changePolicy, createProject, workItemsOf } from '../journal.mjs';
import { makeProjectRepo, refOid } from '../repos.mjs';
import { answerDecision, getRow, runsOf, stopRun, workItem } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { populated, procsOf } from '../sandbox/cgroup.mjs';
import { realPolicy } from './attempt.mjs';
import { REAL, eventsAboutRun, journeyEngine, ledgerOriginal, observe, realStep, sampleDomains, stepValue, tickWhile } from './lane.mjs';

// ---- the two projects -----------------------------------------------------------------

// Path one: one stage, one requirement, one protected check (the M1 hands-on's shape).
export const PATH_ONE = Object.freeze({
  name: 'real-journey-one',
  files: {},
  requirements: [{ key: 'R1', text: 'src/greeting.js exports a function greeting(name) that returns the string "Hello, " followed by name and "!". For example greeting("Ada") returns "Hello, Ada!".' }],
  constraints: [{ key: 'C1', text: 'Plain JavaScript modules (ES modules) with no dependencies. Do not add a package.json.' }],
  stages: [{ number: 1, goal: 'Implement R1: create src/greeting.js as R1 describes.', implements: ['R1'] }],
});

// Path two: a defect seeded in the code R1 governs, which the stage does not
// ask the Builder to touch, so that the real Verifier, verifying R1 and R2 on
// the candidate, is expected to find it (E59 item 3; plan question 4 (a)).
// R1's 30 minutes are written as 30 * 60 seconds and compared with
// milliseconds: a session stays valid a thousand times too long, which is
// an expired session accepted, the login defect M1's fix loop names.
export const SEEDED_DEFECT = Object.freeze({
  path: 'src/session.js',
  content:
    '// R1: a session is valid for 30 minutes after it was issued.\n' +
    'export const SESSION_LIFETIME = 30 * 60; // seconds\n' +
    'export function isSessionValid(session, nowMs) {\n' +
    '  return nowMs - session.issuedAtMs < SESSION_LIFETIME * 1000 * 1000;\n' +
    '}\n',
});

export const PATH_TWO = Object.freeze({
  name: 'real-journey-two',
  files: { [SEEDED_DEFECT.path]: SEEDED_DEFECT.content },
  requirements: [
    { key: 'R1', text: 'src/session.js exports isSessionValid(session, nowMs), true exactly when nowMs - session.issuedAtMs is less than 30 minutes (1 800 000 milliseconds). A session 30 minutes old or older is expired and must be rejected. This is a security requirement.' },
    { key: 'R2', text: 'src/logout.js exports logout(session), which returns a copy of session with the property revoked set to true and does not change the session it was given.' },
  ],
  constraints: [{ key: 'C1', text: 'Plain JavaScript modules (ES modules) with no dependencies. Do not add a package.json.' }],
  stages: [{ number: 1, goal: 'R1 is already implemented in src/session.js. Implement R2: create src/logout.js as R2 describes.', implements: ['R1', 'R2'] }],
});

// A project of the journey: a disposable repository holding its protected
// checks (and, for path two, the seeded defect), created through the public
// route; the plan with its texts and the check declared as fixtures; every
// role Claude Code unless `roles` says otherwise; the lane's limits.
export async function realProject(ctx, fx, spec, { dayUsd, roles = {} }) {
  const dir = join(ctx.runDir, 'repos', spec.name);
  mkdirSync(join(ctx.runDir, 'repos'), { recursive: true, mode: 0o700 });
  const repo = makeProjectRepo(dir, { files: { ...PROTECTED_FILES, ...spec.files } });
  const base = refOid(repo.path, repo.ref);
  const { id } = await createProject(fx.engine, { repoPath: repo.path, name: spec.name, tier: 'T2' });
  // The policy (which backend each role runs) before the plan: the plan makes the first stage's work eligible, and the engine
  // dispatches it at once, under whatever backend the policy names then
  // (found by the E79 rehearsal: installed after the plan, the policy came
  // too late and the Builder ran on the default backend, refused).
  await changePolicy(fx.engine, id, {
    ...realPolicy(dayUsd),
    backend_builder: roles.builder ?? REAL.backend,
    backend_verifier: roles.verifier ?? REAL.backend,
    backend_reviewer: roles.reviewer ?? REAL.backend,
  });
  const plan = await installGatedPlan(fx.engine, id, { requirements: spec.requirements, constraints: spec.constraints, stages: spec.stages });
  const checks = (await installChecks(fx.engine, id, [check('login', { requirements: ['R1'] })])).id;
  return { id, repo: repo.path, ref: repo.ref, base, stage: plan.stages[0], checks };
}

// ---- moving one piece of work through a real role ---------------------------------------

const deadlineOf = (kind) => (kind === 'verification' ? REAL.roleDeadlines.deadline_verifier : kind === 'review' ? REAL.roleDeadlines.deadline_reviewer : REAL.roleDeadlines.deadline_builder);

// Tick until the item's latest run has ended; the run row.
export async function runEnds(fx, project, itemId, { index } = {}) {
  const item = workItem(fx.home, itemId);
  const timeoutMs = (deadlineOf(item?.kind) + 600) * 1000;
  return tickWhile(
    fx,
    project,
    () => {
      const runs = runsOf(fx.home, itemId);
      const r = index === undefined ? runs.at(-1) : runs[index];
      return r?.state === 'ended' ? r : undefined;
    },
    { timeoutMs, everyMs: 10_000, what: `a run of ${itemId} (${item?.kind}) to end` },
  );
}

// The person at the chain boundary lets the waiting work through (as M01's
// journey does; SEAM.md §162).
export async function letThrough(fx, project, itemId) {
  const found = await tickWhile(
    fx,
    project,
    () => withStore(fx.home, (db) => db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`).get(itemId)),
    { timeoutMs: 120_000, everyMs: 3_000, what: `the chain boundary's decision about ${itemId}` },
  );
  await answerDecision(fx.engine, project, found.id, 'continue');
  return found.id;
}

const candidates = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));

export const waitCandidates = (fx, project, count) =>
  tickWhile(fx, project, () => (candidates(fx.home, project).length >= count ? candidates(fx.home, project) : undefined), { timeoutMs: 180_000, everyMs: 5_000, what: `${count} candidate(s) of ${project}` });

const notEstablished = (path, what, detail) => {
  throw new Error(`${path} not established: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 600)})`}`);
};

const runSummary = (home, run) => ({
  id: run.id,
  role: run.role,
  work_item: run.work_item,
  state: run.state,
  outcome: run.outcome,
  reason_class: run.reason_class,
  reason_text: run.reason_text,
  ledger: ledgerOriginal(home, run.id),
});

// A candidate's verification: let through, ended, completed.
async function verify(fx, P, candidate, path) {
  const verification = await tickWhile(fx, P.id, () => workItemsOf(fx.home, P.id).find((w) => w.kind === 'verification' && w.subject?.candidate === candidate.id), { timeoutMs: 120_000, everyMs: 5_000, what: `verification work for ${candidate.id}` });
  await letThrough(fx, P.id, verification.id);
  const run = await runEnds(fx, P.id, verification.id);
  if (run.outcome !== 'completed') notEstablished(path, `the Verifier's run on ${candidate.id} ended ${run.outcome}/${run.reason_class}`, run.reason_text);
  return { item: verification.id, run };
}

// A candidate's review: the check's execution recorded (a fixture: D3 is
// not built), the review the engine queues let through, the run ended.
async function review(fx, P, candidate, path) {
  const [execution] = await passAll(fx.engine, P.id, candidate.id, [P.checks.login]);
  const queued = await tickWhile(fx, P.id, () => workItemsOf(fx.home, P.id).find((w) => w.kind === 'review' && w.subject?.candidate === candidate.id), { timeoutMs: 180_000, everyMs: 5_000, what: `the engine to queue the review of ${candidate.id}` });
  await letThrough(fx, P.id, queued.id);
  const run = await runEnds(fx, P.id, queued.id);
  if (run.outcome !== 'completed') notEstablished(path, `the Reviewer's run on ${candidate.id} ended ${run.outcome}/${run.reason_class}`, run.reason_text);
  return { item: queued.id, run, execution };
}

// The two gates on a candidate: the stage gate, then a test target and the
// Alpha authorization's gate.
async function gates(fx, P, candidate) {
  const ctx = { project: { id: P.id }, candidate, stage: P.stage.id };
  const stage = await stageGate(fx, ctx);
  const alpha = await alphaTarget(fx, ctx);
  const alphaEvaluation = await alpha.evaluate();
  return { stage, alpha: alphaEvaluation, authorization: alpha.authorization.id };
}

// What the API says about the journey, read while its engine runs, compared
// with the durable rows (M01's last clause): each run's read against its row
// and its run.ended event, each gate's latest recorded evaluation against the
// one the journey asked for; and the project's ledger read, kept for (d).
async function apiReads(fx, project, runIds, evaluations) {
  const mismatches = [];
  for (const id of runIds) {
    const row = getRow(fx.home, 'runs', id);
    const read = (await fx.engine.get(`/v1/projects/${project}/runs/${id}`)).body?.run;
    for (const key of ['state', 'outcome', 'reason_class']) if (read?.[key] !== row?.[key]) mismatches.push({ run: id, key, api: read?.[key] ?? null, store: row?.[key] ?? null });
    if (!eventsAboutRun(fx.home, id).some((e) => e.type === 'run.ended')) mismatches.push({ run: id, key: 'run.ended', api: null, store: 'no event' });
  }
  for (const { candidate, kind, outcome } of evaluations) {
    const read = (await fx.engine.get(`/v1/projects/${project}/candidates/${candidate}/gates/${kind}`)).body;
    const shown = read?.evaluation?.outcome ?? read?.outcome ?? null;
    if (shown !== outcome) mismatches.push({ candidate, kind, api: shown, asked: outcome });
  }
  const ledger = (await fx.engine.get(`/v1/projects/${project}/ledger`)).body ?? null;
  return { mismatches, ledger };
}

// ---- the paths, each a step of the run directory ---------------------------------------

// Path one (M140 (a)): nothing goes wrong.
export async function pathOne(ctx) {
  return realStep(ctx, 'path_one', async () => {
    const fx = await journeyEngine(ctx, 'home');
    try {
      const P = await realProject(ctx, fx, PATH_ONE, { dayUsd: REAL.dayVerifiedUsd.pathOne });
      const sampler = sampleDomains(fx.home, P.id, { intervalMs: 1000 });
      try {
        const build = await runEnds(fx, P.id, P.stage.work_item);
        if (build.outcome !== 'completed') notEstablished('path one', `the Builder's run ended ${build.outcome}/${build.reason_class}`, build.reason_text);
        const [candidate] = await waitCandidates(fx, P.id, 1);
        const verification = await verify(fx, P, candidate, 'path one');
        const reviewed = await review(fx, P, candidate, 'path one');
        if (signoffsOf(fx.home, candidate.id).length === 0) notEstablished('path one', 'the real Reviewer signed nothing off', findingsOf(fx.home, P.id));
        const evaluated = await gates(fx, P, candidate);
        const reads = await apiReads(fx, P.id, [build.id, verification.run.id, reviewed.run.id], [
          { candidate: candidate.id, kind: 'stage', outcome: evaluated.stage.outcome },
          { candidate: candidate.id, kind: 'alpha_authorize', outcome: evaluated.alpha.outcome },
        ]);
        const out = {
          api_mismatches: reads.mismatches,
          ledger_read: reads.ledger,
          project: P.id,
          repo: P.repo,
          base: P.base,
          candidate: candidate.id,
          runs: [build, verification.run, reviewed.run].map((r) => runSummary(fx.home, r)),
          findings: findingsOf(fx.home, P.id),
          stage_gate: evaluated.stage.outcome,
          alpha_gate: evaluated.alpha.outcome,
          authorization: evaluated.authorization,
        };
        observe(ctx, 'M140', 'path_one', out);
        if (evaluated.stage.outcome !== 'satisfied' || evaluated.alpha.outcome !== 'satisfied') notEstablished('path one', 'a gate is not satisfied', { stage: evaluated.stage, alpha: evaluated.alpha });
        return out;
      } finally {
        observe(ctx, 'M140', 'path_one_domain_samples', sampler.stop());
      }
    } finally {
      await fx.engine.stop();
    }
  });
}

// Path two (M140 (b)): the fix loop. `mixed` (E59 item 3's recorded
// fallback): the Builders real, the Verifier and the Reviewer scripted in
// the sandbox, labelled a mixed journey.
export async function pathTwo(ctx, { mixed = false } = {}) {
  const label = mixed ? 'path two (mixed)' : 'path two';
  return realStep(ctx, mixed ? 'path_two_mixed' : 'path_two', async () => {
    let scripted = null;
    if (mixed) {
      scripted = new Scripted(join(ctx.runDir, 'scripted-mixed'));
      scripted.defaultScript(script.complete());
    }
    const fx = await journeyEngine(ctx, 'home', { scriptedDir: scripted?.dir ?? null });
    try {
      const P = await realProject(ctx, fx, { ...PATH_TWO, name: mixed ? `${PATH_TWO.name}-mixed` : PATH_TWO.name }, { dayUsd: REAL.dayVerifiedUsd.pathTwo, roles: mixed ? { verifier: 'scripted', reviewer: 'scripted' } : {} });
      const build = await runEnds(fx, P.id, P.stage.work_item);
      if (build.outcome !== 'completed') notEstablished(label, `the Builder's run ended ${build.outcome}/${build.reason_class}`, build.reason_text);
      const [first] = await waitCandidates(fx, P.id, 1);

      // The Verifier: the real one is expected to report the seeded defect as
      // a finding naming the check; the mixed run's scripted one reports M1's.
      if (mixed) {
        const v = await tickWhile(fx, P.id, () => workItemsOf(fx.home, P.id).find((w) => w.kind === 'verification' && w.subject?.candidate === first.id), { timeoutMs: 120_000, everyMs: 5_000, what: 'the first candidate\'s verification work' });
        scripted.script(v.id, [{ steps: [step.result({ ...VALID_RESULT, findings: [FINDING] })] }]);
      }
      const verification = await verify(fx, P, first, label);
      // The finding must name the check (SEAM.md §74, "Resolution"): by its
      // key or by its id, whichever the engine stores.
      const found = findingsOf(fx.home, P.id).filter((f) => f.check === 'login' || f.check === P.checks.login);
      if (found.length === 0) notEstablished(label, 'the Verifier reported no finding naming the check "login"', findingsOf(fx.home, P.id));
      const finding = found[0];

      if (mixed) {
        const rv = () => workItemsOf(fx.home, P.id).find((w) => w.kind === 'review' && w.subject?.candidate === first.id);
        await passAll(fx.engine, P.id, first.id, [P.checks.login]);
        const queued = await tickWhile(fx, P.id, rv, { timeoutMs: 180_000, everyMs: 5_000, what: 'the review of the first candidate' });
        scripted.script(queued.id, [{ steps: [step.result({ ...VALID_RESULT, dispositions: [{ finding: finding.id, disposition: 'fix' }] })] }]);
      }
      const firstReview = mixed ? await reviewQueued(fx, P, first, label) : await review(fx, P, first, label);
      const fix = workItemsOf(fx.home, P.id).find((w) => w.kind === 'fix');
      if (!fix) notEstablished(label, 'the Reviewer did not disposition the finding "fix", so the engine registered no fix work', findingsOf(fx.home, P.id));
      const blocked = await stageGate(fx, { project: { id: P.id }, candidate: first, stage: P.stage.id });

      await letThrough(fx, P.id, fix.id);
      const fixRun = await runEnds(fx, P.id, fix.id);
      if (fixRun.outcome !== 'completed') notEstablished(label, `the fix's Builder run ended ${fixRun.outcome}/${fixRun.reason_class}`, fixRun.reason_text);
      const [, second] = await waitCandidates(fx, P.id, 2);
      const secondVerification = await verify(fx, P, second, label);
      if (mixed) {
        await passAll(fx.engine, P.id, second.id, [P.checks.login]);
        const queued = await tickWhile(fx, P.id, () => workItemsOf(fx.home, P.id).find((w) => w.kind === 'review' && w.subject?.candidate === second.id), { timeoutMs: 180_000, everyMs: 5_000, what: 'the review of the fix\'s candidate' });
        scripted.script(queued.id, [{ steps: [step.result({ ...VALID_RESULT, signoffs: [{ scope: 'candidate' }] })] }]);
      }
      const secondReview = mixed ? await reviewQueued(fx, P, second, label) : await review(fx, P, second, label);
      if (signoffsOf(fx.home, second.id).length === 0) notEstablished(label, 'the Reviewer signed nothing off on the fix\'s candidate', findingsOf(fx.home, P.id));
      const evaluated = await gates(fx, P, second);
      const resolved = findingsOf(fx.home, P.id).find((f) => f.id === finding.id);
      const reads = await apiReads(fx, P.id, [build, verification.run, firstReview.run, fixRun, secondVerification.run, secondReview.run].map((r) => r.id), [
        { candidate: second.id, kind: 'stage', outcome: evaluated.stage.outcome },
        { candidate: second.id, kind: 'alpha_authorize', outcome: evaluated.alpha.outcome },
      ]);
      const out = {
        api_mismatches: reads.mismatches,
        ledger_read: reads.ledger,
        mixed,
        project: P.id,
        repo: P.repo,
        base: P.base,
        candidates: [first.id, second.id],
        finding: resolved,
        blocked_on_first: { outcome: blocked.outcome, reasons: blocked.reasons },
        fix: fix.id,
        runs: [build, verification.run, firstReview.run, fixRun, secondVerification.run, secondReview.run].map((r) => runSummary(fx.home, r)),
        stage_gate: evaluated.stage.outcome,
        alpha_gate: evaluated.alpha.outcome,
        authorization: evaluated.authorization,
        fix_status: workItem(fx.home, fix.id).status,
      };
      observe(ctx, 'M140', mixed ? 'path_two_mixed' : 'path_two', out);
      if (evaluated.stage.outcome !== 'satisfied' || evaluated.alpha.outcome !== 'satisfied') notEstablished(label, 'a gate on the fix\'s candidate is not satisfied', { stage: evaluated.stage, alpha: evaluated.alpha });
      if (resolved?.status !== 'resolved') notEstablished(label, 'the finding was not resolved by the check passing on the fix\'s candidate', resolved);
      return out;
    } finally {
      await fx.engine.stop();
    }
  });
}

// The mixed run's review, whose check result was recorded before its script.
async function reviewQueued(fx, P, candidate, label) {
  const queued = workItemsOf(fx.home, P.id).find((w) => w.kind === 'review' && w.subject?.candidate === candidate.id);
  await letThrough(fx, P.id, queued.id);
  const run = await runEnds(fx, P.id, queued.id);
  if (run.outcome !== 'completed') notEstablished(label, `the Reviewer's run on ${candidate.id} ended ${run.outcome}/${run.reason_class}`, run.reason_text);
  return { item: queued.id, run };
}

// M140 (e): a Stop during a real run, on path one's project. A second stage
// is planned; its real Builder starts; once the agent is a member of its
// domain the test asks for a Stop (and confirms it, as M13 does). The
// engine pauses at `boundary.before_terminated` (it has read `populated 0`
// and is about to record termination): there the test reads the domain's
// `cgroup.events` itself and the run read, which must not yet say `ended`.
export async function stopCase(ctx) {
  return realStep(ctx, 'stop_case', async () => {
    const one = stepValue(ctx, 'path_one');
    const fx = await journeyEngine(ctx, 'home');
    try {
      const plan = await installGatedPlan(fx.engine, one.project, {
        requirements: [{ key: 'R3', text: 'src/farewell.js exports farewell(name), returning "Goodbye, " followed by name and ".".' }],
        stages: [{ number: 2, goal: 'Implement R3: create src/farewell.js as R3 describes.', implements: ['R3'] }],
      });
      const item = plan.stages[0].work_item;
      await armBarrier(fx.engine, 'boundary.before_terminated', 'pause');
      const run = await tickWhile(fx, one.project, () => runsOf(fx.home, item)[0], { timeoutMs: 120_000, everyMs: 3_000, what: 'the second stage\'s Builder run' });
      const domain = await tickWhile(
        fx,
        one.project,
        () => {
          const d = withStore(fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(run.id));
          if (!d?.cgroup_path) return undefined;
          try {
            return procsOf(d.cgroup_path).length > 0 ? d : undefined;
          } catch {
            return undefined;
          }
        },
        { timeoutMs: 180_000, everyMs: 1_000, what: 'the agent to be a member of its domain' },
      );
      // Let it work a little, so a usage observation can exist (bounded: the
      // run is stopped at the latest 60 s after the agent appears).
      const seenAt = performance.now();
      while (performance.now() - seenAt < 60_000) {
        const usage = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "usage_observations" u JOIN "invocation_receipts" i ON i."id" = u."invocation" WHERE i."run" = ?').get(run.id)?.n ?? 0);
        if (usage > 0 && performance.now() - seenAt > 15_000) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      const stopAsked = new Date().toISOString();
      await stopRun(fx.engine, one.project, run.id);
      await fx.engine.waitUntil('barrier:boundary.before_terminated', { timeoutMs: 120_000 });
      const atBarrier = {
        populated: populated(domain.cgroup_path),
        run_read: (await fx.engine.get(`/v1/projects/${one.project}/runs/${run.id}`)).body?.run?.state ?? null,
        at: new Date().toISOString(),
      };
      await releaseBarrier(fx.engine, 'boundary.before_terminated');
      const ended = await tickWhile(fx, one.project, () => (getRow(fx.home, 'runs', run.id)?.state === 'ended' ? getRow(fx.home, 'runs', run.id) : undefined), { timeoutMs: 120_000, everyMs: 2_000, what: 'the stopped run to end' });
      const receipt = withStore(fx.home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(run.id));
      const terminal = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" IN ('ended', 'unknown') ORDER BY "seq" DESC LIMIT 1`).get(receipt.id));
      const out = {
        project: one.project,
        run: run.id,
        domain: domain.id,
        cgroup_path: domain.cgroup_path,
        stop_asked_at: stopAsked,
        at_barrier: atBarrier,
        outcome: [ended.outcome, ended.reason_class],
        exit_class: terminal?.exit_class ?? null,
        exit_evidence: terminal?.exit_evidence ? JSON.parse(terminal.exit_evidence) : null,
        events: eventsAboutRun(fx.home, run.id).map((e) => ({ seq: e.seq, type: e.type })),
        ledger: ledgerOriginal(fx.home, run.id),
        ledger_read: (await fx.engine.get(`/v1/projects/${one.project}/ledger`)).body ?? null,
      };
      observe(ctx, 'M140', 'stop_case', out);
      return out;
    } finally {
      await fx.engine.stop();
    }
  });
}
