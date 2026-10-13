// The second journey's steps (D6 §8.1; BS5 §3; M5 plan §3.2; SEAM.md §§376
// to 386), each a function a row's file calls as far as its cases need,
// answering every human act of D6 §8.1 through the owner's production routes
// and installing nothing by fixture (BS5 §4.1 rule 20): the adoption and the
// mode, the retrofit Spec Writer session with its confirmations, the
// retrofit Architect session, then the build by ticks (the journey's pump).
//
// Each step returns what it observed; nothing here asserts a row's clause,
// only that the journey is live.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { runningClassifier, setEngineConfig } from '../checks/classifier.mjs';
import { answer, consume, decision, decisionsOfKind } from '../decisions.mjs';
import { CLI, waitFor } from '../engine.mjs';
import { roleThat } from '../gitruns.mjs';
import { getRow, scriptedEngine, tick, tickUntil, waitForIdle } from '../runs.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from '../sessions.mjs';
import { script, step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { ROUTED_KINDS, activePlan, alphaReady, candidatesOfProject, journeyContext, nextPhasePublished, openDecisions, ownerPolicy, phaseCompleted, planOfPhase, pump, queuedExecutions } from '../journey/drive.mjs';
import { deploy } from '../deploy/kernel.mjs';
import { recordExit } from '../checks/selection.mjs';
import { executionRow } from '../checks/fixtures.mjs';
import { ADOPTED_NAME, SERVER_MJS_FIXED, makeAdoptedRepo, refOid } from './repo.mjs';
import { DEFECT_STAGE, R4_CHECK, SPEC, TIER, authoringFiles, authoringResult, phasePlan, retrofitArchitectFiles } from './products.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);

// ---- the engine and the scripts ---------------------------------------------------------------

// The scripted engine with the classifier `authoritative` (slice 31's
// ruling; SEAM.md §351), the retrofit scripts by kind in place. `config`
// goes to the engine's configuration (e.g. `adoption_full_max_files`).
export async function retrofitEngine(t, { config = {}, withR4 = false, withoutR1 = false, extraAuthoring = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  await fx.start();
  retrofitScripts(fx, { withR4, withoutR1, extraAuthoring });
  return fx;
}

const writes = (files, { head = false } = {}) => Object.entries(files).map(([path, text]) => (head ? { write: { path, content: text, substitute_head: true } } : step.write(path, text)));
const text = (v) => `${JSON.stringify(v, null, 2)}\n`;

// The Architect's replan of phase 2 (D6 §8.1 step 6): one Builder stage for R4.
export const replanScript = ({ spec_version = 1 } = {}) => ({
  steps: [
    ...writes({ '.surety/phases/phase-2.json': text({ ...phasePlan(2, { spec_version, revision: '__HEAD__' }), stages: [DEFECT_STAGE] }), '.surety/phases/phase-2.md': '# Phase 2\n\n- Stage 2: refuse a non-number\n' }, { head: true }),
    step.result({ status: 'completed', summary: 'phase 2 planned', plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});

// The retrofit journey's scripts by work kind (§350's form). Phase 1's
// authoring adopts the project's sum test (`authoringResult`); phase 2's adds
// R4.1's check; phase 2's Builder refuses a non-number.
export function retrofitScripts(fx, { withR4 = false, withoutR1 = false, extraAuthoring = {} } = {}) {
  const phase1 = authoringFiles({ withR4, withoutR1, extra: extraAuthoring });
  fx.scripted.kindScript('check_authoring', [roleThat(writes(phase1), authoringResult(withoutR1 ? { adopted: [] } : {})), roleThat(writes(R4_CHECK), { proposal: { rationale: 'Phase 2: R4.1\'s check.', requested_change_kind: 'tightening' } })]);
  fx.scripted.kindScript('stage_build', roleThat(writes({ 'server.mjs': SERVER_MJS_FIXED })));
  fx.scripted.kindScript('verification', script.complete());
  fx.scripted.kindScript('review', { steps: [{ review_auto: { reason: 'The approved specification requires these checks.' } }] });
  fx.scripted.kindScript('phase_verification', roleThat([], { signoffs: [{ scope: 'phase' }] }));
  fx.scripted.kindScript('replan', replanScript());
  fx.scripted.kindScript('fix', roleThat([]));
  fx.scripted.defaultScript(script.complete());
}

// ---- step 1: the adoption (D6 §8.1 step 1; SEAM.md §377) -----------------------------------------

// `POST /v1/projects/adopt` (A.8; the body as `POST /v1/projects`'s, §377 †).
// The raw response.
export function postAdopt(fx, { repo, name = ADOPTED_NAME, tier = TIER, idea, branch } = {}) {
  const body = { name, tier, dev_repo_path: repo.path, integration_branch: branch ?? repo.branch };
  if (idea !== undefined) body.idea = idea;
  return fx.engine.post('/v1/projects/adopt', body);
}

// A fresh adopted repository under the test's root (`repo.mjs`).
export function adoptedRepo(fx, opts = {}) {
  const n = ++fx.repos;
  return makeAdoptedRepo(join(fx.root, `adopted-${n}`), opts);
}

// The repository made and adopted; waited for `registered`. Returns {id,
// repo, A, res}: `A` is the branch head the test observed before adopting.
export async function adoptProject(fx, { repo, name, tier, idea, repoOpts = {} } = {}) {
  const r = repo ?? adoptedRepo(fx, repoOpts);
  const A = refOid(r.path, r.ref);
  const res = await postAdopt(fx, { repo: r, name, tier, idea });
  assert.equal(res.status, 201, `POST /v1/projects/adopt (D6 A.8; SEAM.md §377) (→ ${res.status} ${res.text})`);
  const id = res.body?.project?.id;
  assert.match(id ?? '', /^proj_/, `the response names the project (${res.text})`);
  await waitFor(() => getRow(fx.home, 'projects', id)?.registration_state === 'registered', { what: `adopted project ${id} to be registered` });
  return { id, repo: r, A, res };
}

export const adoptionOf = (home, project) => json(getRow(home, 'projects', project)?.adoption ?? null);
export const adoptionModeRows = (home, project) => decisionsOfKind(home, project, 'adoption_mode');

// The owner's mode (D6 §8.1 step 1): the open `adoption_mode` answered.
export async function chooseMode(fx, project, mode = 'full') {
  const row = await tickUntil(fx.engine, project, () => adoptionModeRows(fx.home, project).find((d) => d.status === 'open'), { max: 4, what: 'the open adoption_mode decision' });
  return consume(fx, project, row, mode);
}

// `surety project adopt <name> --repo <path> --branch <b> --tier <T>` in the
// test's home (D6 §8.1 step 1, A.8; SEAM.md §377 †): exit 0 and one JSON
// line, the route's answer. Returns {status, body, stdout, stderr}.
export function adoptByCommand(fx, { repo, name = ADOPTED_NAME, tier = TIER, idea } = {}) {
  const args = ['project', 'adopt', name, '--repo', repo.path, '--branch', repo.branch, '--tier', tier, ...(idea === undefined ? [] : ['--idea', idea])];
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, SURETY_HOME: fx.home } });
  let body;
  try {
    body = JSON.parse(done.stdout);
  } catch {
    body = undefined;
  }
  return { status: done.status, body, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}
export function suretyCommand(fx, args) {
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, SURETY_HOME: fx.home } });
  let body;
  try {
    body = JSON.parse(done.stdout);
  } catch {
    body = undefined;
  }
  return { status: done.status, body, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

// ---- step 2: the retrofit Spec Writer session (D6 §8.1 step 2, §8.2; SEAM.md §379) --------------

// One turn writing `spec`, a save, a close. Returns {run, turn, saved,
// closed, approval, confirms}: `approval` the `spec_approval` row and
// `confirms` the `requirement_confirm` rows by key (§379 †).
export async function retrofitSpecSession(fx, project, { spec = SPEC, result = {}, close = true } = {}) {
  const run = await openSession(fx, project, 'spec_writer');
  scriptTurns(fx, run.id, [turnThatWrites({ '.surety/spec/spec.md': spec }, { reply: 'The specification of the code as it is, with the claims table.', done: true, ...result })]);
  const turn = await sayAndSettle(fx, project, run.id, 'Describe the repository as it is: every behaviour a requirement, the README\'s claims in section 12.');
  const saved = await saveSession(fx, project, run.id);
  if (!close) return { run, turn, saved };
  const closed = await closeSession(fx, project, run.id);
  const raised = (closed.decisions ?? []).map((d) => decision(fx.home, d.id));
  const approval = raised.find((d) => d?.kind === 'spec_approval') ?? null;
  return { run, turn, saved, closed, approval, confirms: confirmsByKey(fx.home, project) };
}

// The open `requirement_confirm` rows of the project, by the key their
// manifest binds (§379 †: `dependency_manifest.key`).
export function confirmsByKey(home, project, { status = 'open' } = {}) {
  const out = {};
  for (const d of decisionsOfKind(home, project, 'requirement_confirm')) if (status === null || d.status === status) out[d.manifest?.key ?? d.subject_id] = d;
  return out;
}

// The owner's confirmations ({R1: 'confirm', R4: 'defect', ...}), each a
// separate answer, then `spec_approval` answered `approve`. Returns the
// answers and the approval's.
export async function confirmAndApprove(fx, project, answers, { approve = true } = {}) {
  const out = { answers: {}, approval: null };
  for (const [key, option] of Object.entries(answers)) {
    const row = confirmsByKey(fx.home, project)[key];
    assert.ok(row, `an open requirement_confirm for ${key} (${JSON.stringify(Object.keys(confirmsByKey(fx.home, project, { status: null })))})`);
    out.answers[key] = await consume(fx, project, row, option);
  }
  if (approve) {
    const row = decisionsOfKind(fx.home, project, 'spec_approval').find((d) => d.status === 'open');
    assert.ok(row, 'an open spec_approval');
    out.approval = await consume(fx, project, row, 'approve');
  }
  return out;
}
export const FULL_ANSWERS = Object.freeze({ R1: 'confirm', R2: 'confirm', R3: 'confirm', R4: 'defect' });

// ---- step 3: the retrofit Architect session (D6 §8.1 step 3) -----------------------------------

// One turn writing the retrofit products, a save, a close, the two approvals
// answered (`answer` 'both' | 'none'), the publication waited for.
export async function retrofitArchitectSession(fx, project, repo, { files, answer: which = 'both', publishTicks = 6, ...productOpts } = {}) {
  const run = await openSession(fx, project, 'architect');
  const revision = refOid(repo.path, repo.ref);
  const written = files ?? retrofitArchitectFiles({ revision, ...productOpts });
  scriptTurns(fx, run.id, [turnThatWrites(written, { reply: 'The architecture as it is, the module map, one reconstructed ADR, the conformance roadmap and phase 1.', done: true })]);
  const turn = await sayAndSettle(fx, project, run.id, 'Reconstruct the architecture and plan the conformance phase.');
  const saved = await saveSession(fx, project, run.id);
  const res = await fx.engine.post(`/v1/projects/${project}/sessions/${run.id}/close`, {});
  const out = { run, revision, files: written, turn, saved, closeRes: res, decisions: {}, published: null };
  if (res.status !== 200) return out;
  for (const d of res.body.decisions ?? []) out.decisions[d.kind] = decision(fx.home, d.id);
  if (which === 'both') {
    for (const kind of ['architecture_approval', 'plan_approval']) {
      assert.ok(out.decisions[kind], `the close raised ${kind} (${JSON.stringify(res.body)})`);
      await consume(fx, project, out.decisions[kind], 'approve');
    }
    out.published = await tickUntil(fx.engine, project, () => activePlan(fx.home, project) ?? undefined, { max: publishTicks, what: 'the conformance plan to be published' });
  }
  return out;
}

// Steps 1 to 3 in one call, every human act answered: adopted, mode, spec
// with the confirmations, architecture and the conformance plan published.
// Returns {p: {id, repo, A}, ctx, spec, confirmations, architect}.
export async function toConformancePublished(fx, { mode = 'full', answers = FULL_ANSWERS, spec = SPEC, architect = {}, policy, tier = TIER, repoOpts } = {}) {
  const p = await adoptProject(fx, { tier, repoOpts });
  if (policy !== undefined) await ownerPolicy(fx, p.id, policy);
  const modeAnswer = await chooseMode(fx, p.id, mode);
  const specSession = await retrofitSpecSession(fx, p.id, { spec });
  const confirmations = await confirmAndApprove(fx, p.id, answers);
  const arch = await retrofitArchitectSession(fx, p.id, p.repo, architect);
  const ctx = journeyContext(fx, { id: p.id, repo: p.repo }, { tier });
  return { p, ctx, modeAnswer, spec: specSession, confirmations, architect: arch };
}

// ---- the build by ticks (kernel lane) ----------------------------------------------------------

// Like the journey's pump on the kernel lane, but an execution whose
// `exits(x)` is null is left queued (a check held unrecorded), so a case can
// act between the nomination and the checks' results. `max` ticks.
export async function advance(fx, ctx, done, { max = 40, what = 'the conformance to advance', exits = () => 0 } = {}) {
  // The posts stay in `ctx.humanActs` for diagnostics; the acts are counted from the store (`buildActs`, objection 074).
  ctx.humanActs ??= [];
  ctx.sinceSeq ??= withStore(fx.home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);
  for (let i = 0; i < max; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    await waitForIdle(fx.home, ctx.project);
    for (const x of queuedExecutions(fx.home, ctx.project)) {
      const code = exits(x);
      if (code === null || code === undefined) continue;
      if (executionRow(fx.home, x.id)?.status === 'queued') await recordExit(fx.engine, x.id, code).catch(() => null);
    }
    for (const d of openDecisions(fx.home, ctx.project)) {
      if (!ROUTED_KINDS.includes(d.kind)) continue;
      const option = d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key;
      const res = await answer(fx.engine, ctx.project, d, option);
      ctx.humanActs.push({ kind: d.kind, id: d.id, option, status: res.status, at: new Date().toISOString() });
    }
    await tick(fx.engine, ctx.project, { rounds: 1 });
    await waitForIdle(fx.home, ctx.project);
  }
  throw new Error(`${what}: not reached within ${max} ticks (human acts so far: ${JSON.stringify(ctx.humanActs)})`);
}

// Phase 1's completion on the kernel lane for a published adopted project
// `J`, `alpha` configured and the adapter qualified first (`answers` queued
// for its deploy). Returns {J, env, phase1, c1}.
export async function completeConformance(fx, J, { answers = [{ result: 'issued', apply: true }] } = {}) {
  const ready = await alphaReady(fx, J.ctx, { answers });
  const phase1 = await phaseCompleted(fx, J.ctx, 1, { max: 120 });
  const c1 = candidatesOfProject(fx.home, J.p.id).find((c) => c.id === phase1.completion_binding?.candidate);
  assert.ok(c1, `the phase bound its candidate (${JSON.stringify(phase1.completion_binding)})`);
  return { J, env: ready.env, phase1, c1 };
}
export async function toConformanceComplete(fx, { answers, ...opts } = {}) {
  const J = await toConformancePublished(fx, { policy: { alpha_deploy: 'manual' }, ...opts });
  return completeConformance(fx, J, answers === undefined ? {} : { answers });
}

// Through the Alpha barrier to phase 2 published (D6 §8.1 steps 6, 7): the
// owner deploys c-1, the barrier opens, the replan publishes phase 2.
export async function passAlphaBarrier(fx, done, { max = 40 } = {}) {
  const { J, env, c1 } = done;
  await deploy(fx.engine, J.p.id, c1.id, env.name);
  await pump(fx, J.ctx, () => candidatesOfProject(fx.home, J.p.id).find((c) => c.id === c1.id && c.progress === 'alpha_deployed'), { what: 'c-1 to be alpha_deployed', max: 40 });
  const phase2 = await nextPhasePublished(fx, J.ctx, 2, { max });
  return { ...done, phase2 };
}
export const toPhaseTwoPublished = async (fx, opts = {}) => passAlphaBarrier(fx, await toConformanceComplete(fx, opts));

// ---- readers (SEAM.md §§377 to 386) ----------------------------------------------------------

export const releasesOf = (home, project) => rows(home, 'SELECT * FROM "releases" WHERE "project" = ? ORDER BY rowid', project);
export const specClaimsOf = (home, project) => rows(home, 'SELECT c.* FROM "spec_claims" c JOIN "spec_revisions" s ON s."id" = c."spec_revision" WHERE s."project" = ? ORDER BY c.rowid', project);
export const conformanceStages = (home, project) => rows(home, 'SELECT * FROM "stages" WHERE "project" = ? AND "conformance" = 1 ORDER BY rowid', project);
export const projectsNamed = (home, name) => rows(home, 'SELECT * FROM "projects" WHERE "name" = ?', name);
export const gateReasons = (evaluation) => (json(evaluation?.reasons) ?? []).map((r) => (typeof r === 'string' ? r : r.code));
// `stages.implements` holds requirement ids (SEAM.md §70; objections 066, 075): the keys they name.
export const keysOf = (home, project, ids) => {
  const byId = Object.fromEntries(rows(home, 'SELECT "id", "key" FROM "requirements" WHERE "project" = ?', project).map((r) => [r.id, r.key]));
  return (typeof ids === 'string' ? JSON.parse(ids) : ids ?? []).map((id) => byId[id] ?? id);
};
export const conformancePlan = (home, project) => planOfPhase(home, project, 1).find((p) => p.active === 1 || p.active === true) ?? null;

export { answer, pump };
