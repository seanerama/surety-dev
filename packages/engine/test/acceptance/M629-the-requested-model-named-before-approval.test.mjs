// M629, the requested model named before model work is approved (slice 49;
// kernel lane). M7 plan §3g M629; request §3, §7; R5, R9; D2 C4; objection
// 232; DECISIONS item 45. Sean, 2026-11-24, verbatim: "Before I click an
// action that can incur model usage, show the requested model that dispatch
// will record for that role. Label the backend separately. If the provider
// later reports which model actually ran, preserve that as a separate fact."
// and "Take the prototype preparation approval next. Apply the same rule to
// both the approval and the brief's role list. Have approval and dispatch use
// the same model-selection logic. Test with a project role model that
// differs from the backend default, then change the role model while
// approval is pending. An approval for model A must not authorize a run
// requesting model B. Preserve historical approvals and receipts as
// recorded."
//
// (a) a rapid-prototype project whose preparation role's `model_spec_writer`
//     differs from the backend's default (the scripted backend's own model is
//     `scripted`): the `prototype_preparation_approval` raised at creation
//     names `model` = the role's policy model (what dispatch records as
//     `model_requested`) and `provider` = the backend, as separate fields,
//     with `resolution`; its question names both; no run before the answer.
// (b) (amended by the driver's companion dab00ab6) the role's model changed
//     while that approval is open: re-asked as a new generation (the engine's
//     existing re-raise, as M403/M411): the earlier decision invalidated with
//     the moved fields recorded, its manifest still naming A; an answer to it
//     refused `decision_invalidated`; the old hash sent to the new decision
//     refused `decision_stale`; the new decision's manifest names B;
//     approving it dispatches exactly one `brief_preparation` run whose
//     `model_requested` is B.
// (c) approval given for model A, the role's model changed to B before
//     dispatch: no run requesting B under the approval given for A; a new
//     `prototype_preparation_approval` naming B, raised with its reason; the
//     earlier decision consumed with its manifest still naming A; nothing
//     runs until the new one is answered.
// (d) after a later change, the consumed decision's manifest and the run's
//     `invocation_receipts.model_requested` still read what was recorded.
// (e) the brief's role list (`briefFacts`, served where the brief is read)
//     names each role's requested model and its backend separately.
// (f) the M627 offer's consequence text names the Verifier role's model,
//     the one its run then records.
// Everywhere: a provider-reported model kept as a separate fact beside
// `model_requested`. The kernel lane's scripted provider reports one when its
// usage line carries `model` (store/transitions/ledger.ts normalize): the
// preparation run of (b) reports one, and (b)/(d) assert it is kept apart.
//
// Readings this file makes (the report says them):
// - "raised at creation": POST /v1/projects/new takes no policy, so the
//   project's `model_spec_writer` at creation is the schema default (`opus`),
//   read here from the effective policy, never written into the test; it
//   differs from the scripted backend's own model (`scripted`). B and C are
//   names no default carries, so a manifest can name them only by reading
//   the policy.
// - (b), as amended: the new generation is read at once after the policy
//   change (no tick, no `…/prepare`); "the moved fields recorded" is read as
//   the earlier decision's `decision.invalidated` event's `changed` paths
//   (decisions.ts manifestChanges), `.model` among them.
// - (b) first changes the other build roles' models (so (e) has four
//   distinct models); that change moves no model of the preparation role, so
//   the question is then read after a tick and, when none is open (the
//   kind's refresh invalidates it and raises none), asked again by the
//   owner's `POST …/iterations/:i/prepare` (the route M602 (c), (d) and the
//   harness's `tightened` use). Which one happened is reported.
// - "before dispatch" in (c): the project is paused (POST …/pause; a paused
//   project's eligible work is not dispatched, runs.ts dispatchBlocker)
//   before the approval, so the approval's own tick cannot dispatch; the
//   role's model is changed, then the project resumed and ticked.
// - "says why" in (c): the reason is served in the new decision's question
//   or the iteration read's outcome reason or next step, naming the model it
//   now requests (B) and either the model or the decision the earlier
//   approval was given for.
// - (e) the role list is read per role: each of the four build roles named
//   by exactly one entry, its requested model in `model` and its backend in
//   `provider` (or `backend`), both present.
// - (f) the fixture is M627 (a)'s Node service under manual policy; the
//   Verifier's model is changed once before the offer is read again, so the
//   text follows the policy, not a value fixed at creation.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { definitionText } from './harness/checks/fixtures.mjs';
import { KERNEL_KINDS } from './harness/design/check41.mjs';
import { stageWork, toPublished } from './harness/design/drive.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { roleThat, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { changePolicy, eventsOfType } from './harness/journal.mjs';
import { journeyContext, phaseCompleted } from './harness/journey/drive.mjs';
import {
  PROTO,
  currentIt,
  decisionRead,
  decisionsOfProject,
  idle,
  iterationRead,
  newApp,
  ok,
  openDecisionsRead,
  answer,
  policyRead,
  prepScript,
  protoEngine,
  pump,
  receiptsOfRun,
  runsOfIteration,
  runsOfProjectRows,
  statusIs,
  workOfProject,
} from './harness/prototype.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, putConfig, qualifyByFixture } from './harness/deploy/kernel.mjs';
import { PAGE_AUTHORING, PAGE_BUILT, PAGE_FILES, PAGE_POLICY, PAGE_SPEC, pageScripts } from './harness/deploy/static-journey.mjs';

const KIND = PROTO.preparation.decision; // prototype_preparation_approval
const ROLE = PROTO.preparation.role; // spec_writer
const BACKEND = 'scripted';
// Models no default carries.
const MODEL_B = 'opus-m629-b';
const MODEL_C = 'opus-m629-c';
const MODEL_C_B = 'opus-m629-c-switched';
const REPORTED = 'opus-m629-reported-by-provider';
const BUILD_ROLE_MODELS = Object.freeze({ model_architect: 'opus-m629-architect', model_verifier: 'sonnet-m629-verifier', model_builder: 'sonnet-m629-builder' });
const BUILD_ROLES = ['spec_writer', 'architect', 'verifier', 'builder'];

const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));
const effectiveOf = async (fx, p) => (await policyRead(fx, p)).effective;
const openPreparations = async (fx, p) => (await openDecisionsRead(fx, p)).filter((d) => d.kind === KIND);
const decisionRow = (home, id) => {
  const [d] = all(home, 'SELECT * FROM "decisions" WHERE "id" = ?', id);
  return d ? { ...d, dependency_manifest: parse(d.dependency_manifest) } : null;
};
const ledgerOfRun = (home, run) => all(home, 'SELECT "id", "provider", "model_requested", "model_observed" FROM "ledger_rows" WHERE "run" = ? ORDER BY rowid', run);
const runRow = (home, run) => all(home, 'SELECT "id", "model_requested", "model_observed", "backend", "role", "work_item" FROM "runs" WHERE "id" = ?', run)[0] ?? null;
const decisionOfItem = (w) => parse(w.subject)?.decision ?? null;
// The preparation script with the provider reporting a model of its own.
const reportedUsage = { usage: { semantics: 'cumulative', raw: { input_tokens: 1200, cache_read_tokens: 300, output_tokens: 400, model: REPORTED } } };

// The open preparation question after a tick; asked again by the owner
// (POST …/prepare) only when none stands open. Returns {decision, how}.
async function reRead(fx, p, it) {
  await tick(fx.engine, p);
  let open = await openPreparations(fx, p);
  let how = 'the engine raised it again';
  if (open.length === 0) {
    await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it}/prepare`, {}), 201, 'POST …/prepare after the model change');
    open = await openPreparations(fx, p);
    how = "asked again by the owner's POST …/prepare (the engine's refresh invalidated it and raised none)";
  }
  assert.equal(open.length, 1, `one preparation question open (${JSON.stringify(open.map((d) => d.id))})`);
  return { decision: await decisionRead(fx, p, open[0].id), how };
}

// ---- (a) to (e): one rapid prototype; (c) another --------------------------------------------

describe('M629 the requested model named before the preparation is approved, bound by the approval, kept as recorded', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) the approval raised at creation names model = the role\'s policy model and provider = the backend, separately, with resolution; the question names both; no run before the answer', async (t) => {
    const { fx } = S;
    const { id } = await newApp(fx, { name: 'Models a' });
    S.p = id;
    const it = await currentIt(fx, id);
    S.it = it.id;
    const eff = await effectiveOf(fx, id);
    const A = eff.model_spec_writer;
    S.A = A;
    t.diagnostic(`model_spec_writer at creation: ${JSON.stringify(A)}`);
    assert.equal(typeof A, 'string', `the effective policy names model_spec_writer (${JSON.stringify(eff)})`);
    assert.notEqual(A, BACKEND, "the role's model differs from the scripted backend's own");
    const open = await openPreparations(fx, id);
    assert.equal(open.length, 1, 'the preparation question raised at creation');
    const d = await decisionRead(fx, id, open[0].id);
    S.d0 = d;
    const m = d.dependency_manifest;
    t.diagnostic(`manifest: ${JSON.stringify({ role: m.role, model: m.model, provider: m.provider, resolution: m.resolution })}`);
    t.diagnostic(`question: ${d.question}`);
    assert.equal(m.role, ROLE);
    assert.equal(m.model, A, `the manifest's model is the role's requested model, what dispatch records (${JSON.stringify(m)})`);
    assert.equal(m.provider, BACKEND, 'the backend, in its own field');
    assert.equal(m.resolution, 'scripted', 'with resolution');
    assert.ok(d.question.includes(A), `the question names the requested model ${A} (${d.question})`);
    assert.ok(d.question.includes(BACKEND), `the question names the backend (${d.question})`);
    await tick(fx.engine, id);
    assert.deepEqual(runsOfProjectRows(fx.home, id), [], 'no run before the answer');
    assert.deepEqual(workOfProject(fx.home, id), [], 'no work item before the answer');
  });

  test('(b) the role\'s model changed while the approval is open: re-asked as a new generation naming B; the earlier invalidated (moved fields recorded, still naming A), answered decision_invalidated; the old hash on the new one decision_stale; approved, exactly one brief_preparation run requesting B; a provider-reported model kept apart', async (t) => {
    const { fx } = S;
    const id = S.p;
    // The other build roles' models first, so that the brief's role list (e)
    // names four distinct models; then the question as it stands now.
    await changePolicy(fx.engine, id, { ...BUILD_ROLE_MODELS });
    const before = await reRead(fx, id, S.it);
    t.diagnostic(`after the other roles' models: ${before.how}; ${before.decision.id}`);
    S.old = before.decision;
    assert.equal(S.old.dependency_manifest.model, S.A, "the spec_writer's model unchanged: the question still names A");
    // The change of the preparation role's model, with the question open:
    // re-asked as a new generation in the same transaction (the amended row).
    await changePolicy(fx.engine, id, { model_spec_writer: MODEL_B });
    const oldRow = decisionRow(fx.home, S.old.id);
    const invalidated = eventsOfType(fx.home, 'decision.invalidated').filter((e) => e.subject?.decision === S.old.id);
    t.diagnostic(`the earlier decision: ${oldRow.status} (${oldRow.invalidated_reason}); decision.invalidated: ${JSON.stringify(invalidated.map((e) => e.payload))}`);
    assert.equal(oldRow.status, 'invalidated', 'the earlier decision invalidated');
    assert.equal(invalidated.length, 1, 'one decision.invalidated event for it');
    const moved = invalidated[0].payload?.changed ?? [];
    assert.ok(moved.includes('.model'), `the moved fields recorded, the model among them (${JSON.stringify(moved)})`);
    assert.equal(oldRow.dependency_manifest.model, S.A, 'its manifest still naming A');
    const res = await answer(fx, id, S.old);
    t.diagnostic(`the answer to the earlier decision: ${res.status} ${res.text}`);
    assert.equal(res.status, 409, `the answer to the earlier decision (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.code, 'decision_invalidated', res.text);
    // The new generation, open without a tick or a …/prepare.
    const open = await openPreparations(fx, id);
    assert.equal(open.length, 1, `the new generation open (${JSON.stringify(open.map((d) => d.id))})`);
    const d = await decisionRead(fx, id, open[0].id);
    const newRow = decisionRow(fx.home, d.id);
    t.diagnostic(`the new generation: ${d.id} g${newRow.semantic_generation} ${JSON.stringify({ model: d.dependency_manifest.model, provider: d.dependency_manifest.provider })}`);
    assert.notEqual(d.id, S.old.id, 'a new decision');
    assert.equal(newRow.semantic_generation, oldRow.semantic_generation + 1, 'its next generation');
    assert.deepEqual([newRow.kind, newRow.subject_id], [oldRow.kind, oldRow.subject_id], 'the same question about the same iteration');
    assert.notEqual(d.preview_hash, S.old.preview_hash, 'the preview changed');
    const staleRes = await answer(fx, id, { id: d.id, preview_hash: S.old.preview_hash });
    t.diagnostic(`the old hash on the new decision: ${staleRes.status} ${staleRes.text}`);
    assert.equal(staleRes.status, 409, `the old hash sent to the new decision (→ ${staleRes.status} ${staleRes.text})`);
    assert.equal(staleRes.body?.code, 'decision_stale', staleRes.text);
    assert.deepEqual(runsOfProjectRows(fx.home, id), [], 'nothing run on the refused answers');
    assert.deepEqual(workOfProject(fx.home, id), [], 'no work item on the refused answers');
    S.reread = { decision: d };
    assert.equal(d.dependency_manifest.model, MODEL_B, `the new decision names model B (${JSON.stringify(d.dependency_manifest)})`);
    assert.equal(d.dependency_manifest.provider, BACKEND);
    assert.ok(d.question.includes(MODEL_B), `its question names B (${d.question})`);
    // Approve it; the provider reports a model of its own.
    S.eff = await effectiveOf(fx, id);
    fx.scripted.kindScript('brief_preparation', prepScript({ use: reportedUsage }));
    await ok(answer(fx, id, d), 200, 'the owner approves the re-read');
    S.approved = d;
    await pump(fx, id, statusIs(fx, id, S.it, 'awaiting_brief_approval'), { what: 'the brief' });
    const runs = runsOfIteration(fx.home, S.it);
    assert.deepEqual(runs.map((r) => [r.work_kind, r.role]), [[PROTO.preparation.work_kind, ROLE]], 'exactly one brief_preparation run');
    const [run] = runs;
    S.run = run.id;
    const [item] = workOfProject(fx.home, id).filter((w) => w.id === run.work_item);
    assert.equal(decisionOfItem(item), d.id, 'under the approval answered');
    assert.equal(run.model_requested, MODEL_B, 'model_requested is B');
    assert.equal(run.backend, BACKEND, 'the backend recorded apart');
    const receipts = receiptsOfRun(fx.home, run.id);
    assert.ok(receipts.length >= 1, 'an invocation receipt');
    assert.deepEqual(receipts.map((r) => [r.provider, r.model_requested]), receipts.map(() => [BACKEND, MODEL_B]), "its receipts' requested model");
    // The provider-reported model, a separate fact.
    const r = runRow(fx.home, run.id);
    const ledger = ledgerOfRun(fx.home, run.id);
    t.diagnostic(`run: ${JSON.stringify(r)}; ledger: ${JSON.stringify(ledger)}`);
    assert.equal(r.model_observed, REPORTED, 'the model the provider reported, on the run');
    assert.equal(r.model_requested, MODEL_B, 'beside model_requested, never over it');
    assert.ok(ledger.length >= 1 && ledger.every((l) => l.model_requested === MODEL_B && l.model_observed === REPORTED), 'and on its ledger rows, each apart');
    S.recorded = { decision: decisionRow(fx.home, d.id), old: decisionRow(fx.home, S.old.id), d0: decisionRow(fx.home, S.d0.id), run: r, receipts, ledger };
  });

  test('(d) after a later change of the role\'s model, the consumed decision and the run\'s receipts read what was recorded', async () => {
    const { fx } = S;
    const id = S.p;
    assert.ok(S.recorded, '(b) recorded the approval and its run');
    await changePolicy(fx.engine, id, { model_spec_writer: MODEL_C });
    await tick(fx.engine, id);
    const consumed = decisionRow(fx.home, S.approved.id);
    assert.equal(consumed.status, 'consumed');
    assert.deepEqual(consumed.dependency_manifest, S.recorded.decision.dependency_manifest, 'the consumed manifest unchanged');
    assert.equal(consumed.dependency_manifest.model, MODEL_B, 'still naming B');
    assert.equal(consumed.preview_hash, S.recorded.decision.preview_hash);
    assert.equal(consumed.question, S.recorded.decision.question);
    const served = await decisionRead(fx, id, S.approved.id);
    assert.equal(served.dependency_manifest.model, MODEL_B, 'served as recorded');
    for (const [what, row] of [['the stale question', S.recorded.old], ['the question raised at creation', S.recorded.d0]]) {
      const now = decisionRow(fx.home, row.id);
      assert.deepEqual([now.status, now.dependency_manifest], [row.status, row.dependency_manifest], `${what} as recorded`);
    }
    assert.deepEqual(runRow(fx.home, S.run), S.recorded.run, 'the run as recorded: model_requested B, model_observed the reported one');
    assert.deepEqual(receiptsOfRun(fx.home, S.run), S.recorded.receipts, 'its receipts as recorded');
    assert.deepEqual(ledgerOfRun(fx.home, S.run), S.recorded.ledger, 'its ledger rows as recorded');
  });

  test("(e) the brief's role list names each role's requested model and its backend separately", async (t) => {
    const { fx } = S;
    assert.ok(S.eff, '(b) read the policy the preparation ran under');
    const read = await iterationRead(fx, S.p, S.it);
    const models = read.brief?.models;
    t.diagnostic(`brief.models: ${JSON.stringify(models)}`);
    assert.ok(Array.isArray(models) && models.length > 0, `the brief's role list (${JSON.stringify(read.brief)})`);
    for (const role of BUILD_ROLES) {
      const named = models.filter((m) => (Array.isArray(m.roles) ? m.roles.includes(role) : m.role === role));
      assert.equal(named.length, 1, `${role} named once (${JSON.stringify(models)})`);
      const [m] = named;
      const want = S.eff[`model_${role}`];
      assert.equal(m.model, want, `${role}: its requested model ${want} (${JSON.stringify(m)})`);
      assert.equal(m.provider ?? m.backend, BACKEND, `${role}: its backend, separately (${JSON.stringify(m)})`);
    }
  });

  test('(c) approval given for A, the role\'s model changed to B before dispatch: no run requesting B under it; a new approval naming B with its reason; the earlier consumed, still naming A; nothing runs until answered', async (t) => {
    const { fx } = S;
    const { id } = await newApp(fx, { name: 'Models c' });
    const it = await currentIt(fx, id);
    const A = (await effectiveOf(fx, id)).model_spec_writer;
    const [open] = await openPreparations(fx, id);
    assert.ok(open, 'the preparation question raised at creation');
    const dA = await decisionRead(fx, id, open.id);
    t.diagnostic(`approved manifest: ${JSON.stringify({ model: dA.dependency_manifest.model, provider: dA.dependency_manifest.provider })}`);
    // Held from dispatch: the project paused before the approval.
    await ok(fx.engine.post(`/v1/projects/${id}/pause`, {}), 200, 'POST …/pause');
    await ok(answer(fx, id, dA), 200, 'the owner approves for A');
    const approvedRow = decisionRow(fx.home, dA.id);
    const items = workOfProject(fx.home, id);
    assert.deepEqual(items.map((w) => [w.kind, decisionOfItem(w)]), [[PROTO.preparation.work_kind, dA.id]], 'one preparation work item under the approval for A');
    assert.deepEqual(runsOfProjectRows(fx.home, id), [], 'held: nothing dispatched yet');
    await changePolicy(fx.engine, id, { model_spec_writer: MODEL_C_B });
    await ok(fx.engine.post(`/v1/projects/${id}/resume`, {}), 200, 'POST …/resume');
    for (let i = 0; i < 3; i++) {
      await tick(fx.engine, id);
      await idle(fx, id);
    }
    const runs = runsOfProjectRows(fx.home, id);
    const byDecision = (rs) => rs.filter((r) => decisionOfItem(workOfProject(fx.home, id).find((w) => w.id === r.work_item) ?? { subject: null }) === dA.id);
    t.diagnostic(`runs: ${JSON.stringify(runs.map((r) => [r.id, r.work_kind, r.model_requested]))}`);
    assert.deepEqual(byDecision(runs).filter((r) => r.model_requested === MODEL_C_B).map((r) => r.id), [], 'no run requesting B under the approval given for A');
    assert.deepEqual(runs.map((r) => r.id), [], 'nothing run until the new question is answered');
    // A new approval naming B, with its reason.
    const now = await openPreparations(fx, id);
    assert.equal(now.length, 1, `a new preparation question open (${JSON.stringify(now.map((d) => d.id))})`);
    const dB = await decisionRead(fx, id, now[0].id);
    t.diagnostic(`new question: ${dB.question}`);
    assert.notEqual(dB.id, dA.id, 'a new decision');
    assert.equal(dB.dependency_manifest.model, MODEL_C_B, 'naming B');
    assert.equal(dB.dependency_manifest.provider, BACKEND);
    const itRead = await iterationRead(fx, id, it.id);
    const texts = [dB.question, itRead.outcome?.reason ?? '', itRead.outcome?.next_step ?? ''];
    t.diagnostic(`iteration outcome: ${JSON.stringify(itRead.outcome)}`);
    assert.ok(
      texts.some((x) => x.includes(MODEL_C_B) && (x.includes(A) || x.includes(dA.id))),
      `the reason is said: the model now requested and the approval's model or decision (${JSON.stringify(texts)})`,
    );
    // The earlier decision consumed as recorded.
    const earlier = decisionRow(fx.home, dA.id);
    assert.equal(earlier.status, 'consumed');
    assert.deepEqual(earlier.dependency_manifest, approvedRow.dependency_manifest, 'its manifest as recorded');
    assert.equal(earlier.dependency_manifest.model, A, 'still naming A');
    // Answered, one run requesting B under the new approval.
    await ok(answer(fx, id, dB), 200, 'the owner approves for B');
    await pump(fx, id, statusIs(fx, id, it.id, 'awaiting_brief_approval'), { what: 'the brief' });
    const after = runsOfProjectRows(fx.home, id);
    assert.deepEqual(after.map((r) => [r.work_kind, r.model_requested]), [[PROTO.preparation.work_kind, MODEL_C_B]], 'exactly one run, requesting B');
    assert.equal(decisionOfItem(workOfProject(fx.home, id).find((w) => w.id === after[0].work_item)), dB.id, 'under the approval for B');
  });
});

// ---- (f) the request-checks offer names the Verifier's requested model ------------------------

const VERIFIER_1 = 'sonnet-m629-verifier-1';
const VERIFIER_2 = 'sonnet-m629-verifier-2';
const SERVER = 'web/server.mjs';
const SERVICE_BUILT = Object.freeze({
  ...PAGE_BUILT,
  'web/index.html': '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><ul id="items"></ul></body></html>\n',
  [SERVER]: "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('ok')).listen(Number(process.env.PORT ?? 8080), '127.0.0.1');\n",
});
const BEHAVIOUR_PROGRAM = '.surety/checks/post-deploy/operation.mjs';
const BEHAVIOUR_FILES = Object.freeze({
  [BEHAVIOUR_PROGRAM]: "const r = await fetch(process.env.SURETY_TARGET_APP ?? 'http://127.0.0.1:8080/');\nprocess.exit(r.ok ? 0 : 1);\n",
  '.surety/checks/defs/operation.json': definitionText('operation', {
    inputs: [BEHAVIOUR_PROGRAM],
    kind: 'post_deploy_behavior',
    command: ['node', BEHAVIOUR_PROGRAM],
    timeout_s: 120,
    gate_kinds: ['alpha_complete'],
    requires: ['environment', 'artifact_digest'],
  }),
});
const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));
const GAP_AUTHORING = roleThatHolds(writes(BEHAVIOUR_FILES), [], {
  proposal: { rationale: 'The Verifier writes the required post_deploy_behavior check the Alpha deployment lacks.', requested_change_kind: 'tightening' },
});

async function projectBody(fx, project) {
  const p = await fx.engine.get(`/v1/projects/${project}`);
  assert.equal(p.status, 200, `GET /v1/projects/${project} (→ ${p.status} ${p.text})`);
  return p.body.project;
}
async function settled(fx, project) {
  await idle(fx, project);
  await tick(fx.engine, project);
  await idle(fx, project);
}

describe("M629 (f) the request-checks offer names the Verifier's requested model, the one its run records", () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await toPublished(fx, { policy: { ...PAGE_POLICY, model_verifier: VERIFIER_1 }, name: 'pantry-models-f', spec: PAGE_SPEC, files: PAGE_FILES });
    J.p = p;
    pageScripts(fx);
    fx.scripted.kindScript('check_authoring', [0, 1, 2, 3].map(() => roleThat(writes(PAGE_AUTHORING), { proposal: { rationale: "The Verifier authors phase 1's checks before any stage builds.", requested_change_kind: 'unclassifiable' } })));
    const w = stageWork(fx.home, p.id, 1);
    assert.ok(w, 'the published plan has its stage_build work item');
    fx.scripted.script(w.id, [0, 1, 2].map(() => roleThat(writes(SERVICE_BUILT))));
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KERNEL_KINDS];
    await phaseCompleted(fx, ctx, 1, { max: 160 });
    await qualifyByFixture(fx.engine);
    await settled(fx, p.id);
    const res = await putConfig(fx.engine, p.id, 'alpha', configContent({ start: [process.execPath, SERVER], port: 18691 }));
    assert.ok([200, 201].includes(res.status), `PUT …/environments/alpha/config (→ ${res.status} ${res.text})`);
    await settled(fx, p.id);
    fx.scripted.kindScript('check_authoring', GAP_AUTHORING);
    J.first = (await projectBody(fx, p.id)).build.deploy_readiness;
    await changePolicy(fx.engine, p.id, { model_verifier: VERIFIER_2 });
    J.second = (await projectBody(fx, p.id)).build.deploy_readiness;
    J.ask = await fx.engine.post(`/v1/projects/${p.id}/environments/alpha/request-checks`, {});
    const item = typeof J.ask.body?.work_item === 'string' ? J.ask.body.work_item : (J.ask.body?.work_item?.id ?? null);
    if (J.ask.status !== 202 || !item) return;
    J.held = await runToHold(fx, p.id, item);
    J.runModel = all(fx.home, 'SELECT "model_requested", "backend" FROM "runs" WHERE "id" = ?', J.held.run.id)[0] ?? null;
  });
  after(async () => {
    J.fx?.scripted.release('all');
    await shared.cleanup();
  });

  test('(f) the consequence text names the Verifier role and its requested model, the backend labelled apart; it follows a change of the model; the run then records that model', (t) => {
    for (const [what, d, model, other] of [
      ['configured with VERIFIER_1', J.first, VERIFIER_1, VERIFIER_2],
      ['after the change to VERIFIER_2', J.second, VERIFIER_2, VERIFIER_1],
    ]) {
      t.diagnostic(`${what}: ${JSON.stringify(d)}`);
      assert.equal(d?.state, 'blocked', `${what}: ${JSON.stringify(d)}`);
      const text = d.authoring?.offer?.consequence_text;
      assert.equal(typeof text, 'string', `${what}: the offer's consequence text (${JSON.stringify(d.authoring)})`);
      assert.match(text, /Verifier/, `${what}: names the role`);
      assert.ok(text.includes(model), `${what}: names the requested model ${model} (${text})`);
      assert.ok(!text.includes(other), `${what}: not the other (${text})`);
      assert.ok(text.replace(model, '').includes(BACKEND), `${what}: the backend named apart from the model (${text})`);
    }
    t.diagnostic(`request-checks: ${J.ask?.status} ${J.ask?.text}`);
    assert.equal(J.ask?.status, 202, J.ask?.text);
    assert.deepEqual(J.runModel, { model_requested: VERIFIER_2, backend: BACKEND }, 'the run records the model the offer named, the backend apart');
  });
});
