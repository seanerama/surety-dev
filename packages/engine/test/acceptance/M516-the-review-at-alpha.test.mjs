// M516, the review at Alpha (slice 45; project lane, run with `npm test` like
// the sandbox lane). M6 plan §3.7 M516; D7 §10.1 to §10.3, §14; G13; Q4;
// BS6 §4.1 rules 20 to 26; SEAM.md §§480 to 489, 502, 521 to 525.
//
// The design journey's Pantry (BS6 §8) under `design: both`, `autonomy:
// phase`, `alpha_deploy: on_phase_complete`, its approved design drawing two
// more web screens: S3, the big page past `adapter_output_max_bytes`, and S4,
// a route the server does not have. The seed (SEAM.md §357's way, as M401
// part 2): the project carried on the kernel lane's production path to phase
// 1 complete (the design session, the batch approved by the owner's routes,
// the correction, the three stages built and verified), then the same home
// restarted on the project lane, the adapter qualified by `surety
// qualify-adapter` and `alpha` configured by the owner, and Alpha deployed by
// the policy's request on a real unit. Everything this file pins happens on
// the project lane, through production paths only (rule 20): no review,
// observation, evidence, verdict or finding is installed by fixture.
//
// (a) `alpha_complete` under `both`: `design_due` stage `alpha_review` bound
//     to the deployment and the candidate; the candidate `alpha_deployed`
//     and kept so;
// (b) the review session's package: the approved design, the candidate's UI
//     source, the design checks' results, one `observed` record per web
//     screen's route fetched by the engine at the review's start, through
//     the redactor, provenance `engine_observed`;
// (c) the role's reach: from its domain the Alpha's port answers nothing
//     (the host reaches it: the control);
// (d) the review file: every verdict `proposed`; the android screen
//     `not_observed` `no_native_runtime`;
// (e) close: `design_reviews` recorded, `design.review_recorded`, nothing
//     confirmed, `design_verdicts` raised;
// (i) a fetch past `adapter_output_max_bytes` (S3) recorded truncated; a
//     route that fails (S4, 404) recorded with what it answered, never
//     invented;
// (h) the confirmed-to-be design delta: one `design_approval` with one
//     consolidated `spec_change`, batched with the verdicts, `approve`
//     blocked until they are confirmed;
// (f) `design_verdicts` confirmed with one edit and one strike: the
//     confirmed verdicts recorded against the web human test as owner
//     evidence bound to design version, candidate, target and `observed_on`,
//     shown "owner accepted" apart from automated verification; the struck
//     one not; `design.verdicts_confirmed`;
// (g) the confirmed implementation defect: a finding against the review's
//     candidate, Medium, dispositioned by the owner; `fix` as E43.
//
// SAFETY (BS6 §4.1; E64; SEAM.md §§257, 356, 357). The only units are the
// engine's own under this test home's prefix (Alpha's; no preview is asked
// for); the test acts on no unit and signals nothing but its own engine (the
// verified kill at the switch). The role's connection attempt is a guarded
// probe (SEAM.md §141): the role program refuses it outside a network
// namespace of its own, and the case reads the guard's record before reading
// the outcome. Its targets are this home's Alpha on loopback. The served
// pages are read as bytes, through the owner's relay opened by the case's
// own command on 127.0.0.1 and closed by it (rule 24); nothing is rendered
// (rules 21, 22). The secret is
// synthetic. The environment is ended in `after` (`endJourney`: the engine's
// own teardown); the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { operatorGuard } from './harness/deploy/host.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { decisionsOn } from './harness/decisions.mjs';
import { alphaDeployed, candidatesOfProject, phaseCompleted, pump, resultsOf, workOf } from './harness/journey/drive.mjs';
import { alphaByCommand, endJourney, journeyEngine, toProjectLane } from './harness/journey/project.mjs';
import { holdSecret, recordFile, recordRow } from './harness/records.mjs';
import { acting, hostNamespaces } from './harness/scripted.mjs';
import { hostAddresses } from './harness/sandbox/egress.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { REQUIREMENTS } from './harness/design/reference.mjs';
import { assertHoldsAccounted, cli, getBytes, inventoryOf, openDesigner, toPublished } from './harness/design/drive.mjs';
import { approveBatch, assertPassed, checkSession, filesOf, scriptVariant, untilBatch } from './harness/design/check41.mjs';
import { batchSpec, specWriter } from './harness/design/plan44.mjs';
import { quiesce } from './harness/design/preview42.mjs';
import {
  BIG_PAGE,
  REVIEW_FILE,
  ROUTES,
  SECRET_REF,
  SERVED_SECRET,
  TOKENS_CORRECTION,
  batchMembers,
  blockersOf,
  consume,
  decision,
  deployOperations,
  driveReview,
  findingsOf,
  humanTestOf,
  openVerdicts,
  packageJson,
  packageOfLaunch,
  readDesign,
  reviewBuilders,
  reviewEvents,
  reviewJson,
  reviewModel,
  reviewsOf,
  revisedReviewModel,
  verdictOf,
} from './harness/design/review45.mjs';

const MIB = 1024 * 1024;
const OUTPUT_MAX = MIB; // adapter_output_max_bytes at its default (engine configuration)
const REVIEW_POLICY = Object.freeze({ design: 'both', autonomy: 'phase', alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1, phase_size: { min: 1, max: 5 } });
// The kinds the owner answers inside the build on the project lane (as M536).
const BUILD_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']);
const EDITED_WORDS = 'The list has no heading: add "Pantry" above it.';
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('M516 the review at Alpha, on the project lane from a kernel-lane seed', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  let stopped = null;
  const step = (name, fn) =>
    test(name, async () => {
      assert.equal(stopped, null, `the review did not reach this step: it stopped at ${stopped}`);
      try {
        await fn();
      } catch (err) {
        stopped = name.slice(0, 3);
        throw err;
      }
    });

  before(async () => {
    guard = operatorGuard();
    const fx = await journeyEngine(shared.context, guard, { lane: 'kernel' });
    J.fx = fx;
    // The seed, on the kernel lane's production path: published, designed, approved, built, phase 1 complete.
    const { p } = await toPublished(fx, { policy: REVIEW_POLICY, name: 'pantry-review' });
    J.p = p;
    J.model = reviewModel(inventoryOf(p));
    J.v2 = batchSpec({ base: REQUIREMENTS, criteria: J.model.criteria });
    const ctx = scriptVariant(fx, p, J.v2);
    fx.scripted.kindScript('check_correction', TOKENS_CORRECTION);
    reviewBuilders(fx, p.id);
    J.ctx = ctx;
    const out = await checkSession(fx, p.id, [{ name: 'the design with its routes', model: J.model }]);
    assertPassed(out.saves[0].res, 'the seed\'s design');
    const closed = await postCloseRaw(fx, p.id, out.run.id, {});
    assert.equal(closed.status, 200, `the seed's close (${closed.text?.slice(0, 400)})`);
    J.approved = await approveBatch(fx, ctx, await untilBatch(fx, ctx));
    J.phase1 = await phaseCompleted(fx, ctx, 1, { max: 300 });
    // The same home on the project lane; Alpha by the owner's commands and the policy's request.
    J.switched = await toProjectLane(fx, ctx);
    ctx.answerKinds = [...BUILD_KINDS];
    const alpha = await alphaByCommand(fx, ctx);
    J.env = alpha.env;
    J.port = alpha.env.content.port;
    J.deployed = await alphaDeployed(fx, ctx, { newest: true, projectMs: 900_000 });
  });
  after(async () => {
    try {
      const { fx, p } = J;
      if (fx && p) {
        if (J.relayOpen) cli(fx, ['env', 'close', 'alpha', '--project', p.id]);
        await quiesce(fx, p.id).catch(() => null);
        if (J.env) await endJourney(fx, p.id, J.env);
      }
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  step('(a) alpha_complete under both: design_due stage alpha_review bound to the deployment and the candidate; the candidate alpha_deployed and kept so', async () => {
    const { fx, p, ctx, deployed } = J;
    const due = await pump(fx, ctx, () => {
      const open = decisionsOn(fx.home, 'design_due', p.id).filter((d) => d.status === 'open');
      return open.find((d) => d.evidence?.stage === 'alpha_review');
    }, { what: 'design_due (alpha_review)', projectMs: 300_000 });
    J.due = due;
    const op = deployOperations(fx.home, p.id).at(-1);
    const bound = JSON.stringify({ evidence: due.evidence, manifest: due.manifest });
    assert.ok(bound.includes(deployed.id), `bound to the candidate ${deployed.id} (D7 §10.1) (${bound})`);
    assert.ok(op && bound.includes(op.id), `bound to the deployment ${op?.id} (D7 §10.1) (${bound})`);
    assert.match(due.evidence?.command ?? '', /surety session open designer/, 'its command opens a Designer session (the product has a web target)');
    assert.equal(candidatesOfProject(fx.home, p.id).find((c) => c.id === deployed.id)?.progress, 'alpha_deployed', 'nothing waits on it: the candidate stays alpha_deployed');
    await assertHoldsAccounted(fx, p.id, '(a)');
  });

  step('(b) the review session\'s package: the approved design, the candidate\'s UI source, the design checks\' results, one observed record per web screen\'s route fetched by the engine at the review\'s start through the redactor, provenance engine_observed; (c) the role\'s domain does not reach the service', async () => {
    const { fx, p, deployed, port } = J;
    await holdSecret(fx.engine, SECRET_REF, SERVED_SECRET);
    // The owner's relay (D4 Q7; SEAM.md §317), opened by this case's own command on 127.0.0.1 and closed by it (rule 24).
    const relay = cli(fx, ['env', 'open', 'alpha', '--project', p.id]);
    assert.equal(relay.status, 0, `surety env open alpha exits 0 (${relay.stdout.slice(0, 300)} ${relay.stderr.slice(0, 300)})`);
    J.relayOpen = true;
    const targets = [{ host: '127.0.0.1', port }, { host: '::1', port }, ...hostAddresses().map((a) => ({ host: a.address, port }))];
    let run;
    try {
      const control = await getBytes(`http://127.0.0.1:${port}/`);
      assert.equal(control.status, 200, `control: the host reaches the Alpha through the relay on 127.0.0.1:${port}`);
      assert.ok(control.bytes.includes(Buffer.from(SERVED_SECRET)), 'the fixture is live: the served page carries the synthetic secret');
      run = await openDesigner(fx, p.id, { mode: 'review' });
      J.run = run;
      J.turn1 = await driveReview(fx, p.id, run, [{ dump: true, steps: [acting(hostNamespaces()).tcpConnect(targets, { label: 'alpha' })], say: 'Review the Alpha against the approved design.', reply: 'I have the observations.', save: false }], { close: null });
    } finally {
      const closed = cli(fx, ['env', 'close', 'alpha', '--project', p.id]);
      J.relayOpen = closed.status !== 0;
    }
    const pkg = packageOfLaunch(fx, run.id, 0);
    assert.ok(pkg, 'the first turn dumped its package');
    J.pkg = pkg;
    // The approved design (SEAM.md §523: design/approved/<path under .surety/design/>).
    const approvedDesign = packageJson(pkg, 'design/approved/design.json');
    assert.equal(approvedDesign?.version, 1, `the approved design, version 1, in the package (${Object.keys(pkg).filter((n) => n.startsWith('design/')).join(', ')})`);
    assert.deepEqual(packageJson(pkg, 'design/approved/screens.json')?.screens?.map((s) => s.key).sort(), ['S1', 'S2', 'S3', 'S4'], 'its screens');
    // The candidate's UI source, read-only (design/source/<path>).
    assert.ok(pkg['design/source/web/app.css'], 'the candidate\'s web source in the package');
    assert.ok(pkg['design/source/web/index.html'] && pkg['design/source/mobile/App.js'], 'every ui module\'s files');
    assert.ok(!Object.keys(pkg).some((n) => n.startsWith('design/source/server.mjs')), 'and not the api module\'s');
    // The design checks' results on the candidate (design/check-results.json).
    const results = packageJson(pkg, 'design/check-results.json');
    assert.equal(results?.candidate, deployed.id, `the design checks' results on the Alpha candidate (${JSON.stringify(results)?.slice(0, 400)})`);
    assert.ok((results?.results ?? []).some((r) => r.key === 'accept-r2-tokens'), 'the design criterion\'s check among them');
    // One observation per web screen's route.
    const observations = packageJson(pkg, 'design/observations.json')?.observations ?? [];
    J.observations = observations;
    for (const [screen, route] of Object.entries(ROUTES)) {
      const o = observations.filter((x) => x.screen === screen && x.target === 'web');
      assert.equal(o.length, 1, `one observation of ${screen}'s route ${route} (${JSON.stringify(observations)})`);
      assert.deepEqual([o[0].route, o[0].provenance], [route, 'engine_observed'], `${screen}: its route, engine-observed`);
      assert.equal(recordRow(fx.home, o[0].record)?.kind, 'design_observation', `${screen}: a design_observation record`);
    }
    assert.ok(!observations.some((x) => x.target === 'android'), 'none for the android screen: no native runtime');
    const s1 = observations.find((x) => x.screen === 'S1');
    assert.equal(s1.status, 200, 'S1 answered 200');
    const firstLaunch = fx.scripted.launches({ run: run.id })[0];
    const rec = recordRow(fx.home, s1.record);
    // At the review's start: the first turn's package already holds every observation (read above).
    const bytes = readFileSync(recordFile(fx.home, rec));
    assert.ok(bytes.includes(Buffer.from('id="S1"')), 'the record holds the served page');
    assert.ok(!bytes.includes(Buffer.from(SERVED_SECRET)), 'through the redactor: the held secret is not in the record');
    const inPackage = pkg[`design/observations/${s1.evidence}`];
    assert.ok(inPackage, `the role is given the observed bytes (design/observations/${s1.evidence})`);
    assert.equal(inPackage.sha256, sha256hex(bytes), 'the recorded bytes, as recorded');
    // (c) the role's reach.
    const probe = fx.scripted.probes(firstLaunch.invocation, 'tcp_connect').find((e) => e.label === 'alpha');
    assert.ok(probe, 'the guarded probe ran');
    assert.deepEqual(probe.guard?.reasons ?? ['unread'], [], `the role was contained when it tried (${JSON.stringify(probe.guard)})`);
    assert.ok((probe.results ?? []).length === targets.length, `every target tried (${JSON.stringify(probe.results)})`);
    for (const r of probe.results) assert.notEqual(r.outcome, 'connected', `${r.host}:${r.port} unreachable from the role's domain (D2 §2) (${JSON.stringify(r)})`);
  });

  step('(i) a fetch past adapter_output_max_bytes recorded truncated; a route that fails recorded with what it answered, never invented', async () => {
    const { fx, observations } = J;
    const s3 = observations.find((x) => x.screen === 'S3');
    assert.ok(Buffer.byteLength(BIG_PAGE) > OUTPUT_MAX, 'the fixture is live: the big page is past the bound');
    assert.equal(s3.truncated, true, `S3 recorded truncated (${JSON.stringify(s3)})`);
    assert.ok(s3.bytes > 0 && s3.bytes <= OUTPUT_MAX, `within adapter_output_max_bytes (${s3.bytes})`);
    assert.ok(readFileSync(recordFile(fx.home, recordRow(fx.home, s3.record))).length <= OUTPUT_MAX, 'the record holds no more than the bound');
    const s4 = observations.find((x) => x.screen === 'S4');
    assert.equal(s4.status, 404, `S4's route recorded as it answered (${JSON.stringify(s4)})`);
    assert.equal(s4.truncated, false, 'not truncated');
    const body = readFileSync(recordFile(fx.home, recordRow(fx.home, s4.record)));
    assert.ok(body.includes(Buffer.from('not found')), 'its record holds what the server answered, nothing else');
  });

  step('(d) the review file: every verdict proposed, the android screen not_observed no_native_runtime; (e) close: design_reviews recorded, design.review_recorded, nothing confirmed, design_verdicts raised', async () => {
    const { fx, p, run, observations, deployed } = J;
    const ev = (screen) => [observations.find((x) => x.screen === screen).evidence];
    J.revised = revisedReviewModel(J.model);
    const humanKeys = J.v2.humanKeys;
    const v3 = batchSpec({ base: J.v2.requirements.filter((r) => !Object.values(humanKeys).includes(r.key)), criteria: { criteria: [], human_tests: J.revised.criteria.human_tests }, version: 3, humanKind: 'text_changed', humanKeys });
    fx.scripted.kindScript('spec_change', specWriter(v3.text, v3.changes));
    const screens = [
      { target: 'web', key: 'S1', verdict: 'deltas', observed_on: 'browser', evidence: ev('S1'), deltas: [{ owner_words: 'The list has no heading.', kind: 'implementation' }] },
      { target: 'web', key: 'S3', verdict: 'matches', observed_on: 'browser', evidence: ev('S3'), deltas: [] },
      { target: 'web', key: 'S4', verdict: 'deltas', observed_on: 'browser', evidence: ev('S4'), deltas: [{ owner_words: 'A page that is not there should say so and link back to the list.', kind: 'design' }] },
      { target: 'android', key: 'S2', verdict: 'not_observed', not_observed_reason: 'no_native_runtime', evidence: [], deltas: [] },
    ];
    const files = { ...filesOf(J.revised), [REVIEW_FILE(1)]: reviewJson({ subject: { kind: 'candidate', candidate: deployed.id }, screens, revised_design: true }) };
    const before = { confirmed: reviewEvents(fx.home, 'design.verdicts_confirmed', p.id).length, results: resultsOf(fx.home, p.id).length };
    J.before = before;
    const turn2 = await driveReview(fx, p.id, run, [{ clear: true, files, say: 'S1 has no heading; the big page is right; the missing page should say so. Write it down.', done: true }]);
    assert.equal(turn2.saves[0].status, 200, `the review's save (${turn2.saves[0].text?.slice(0, 400)})`);
    assert.equal(turn2.saves[0].body?.design_check?.outcome, 'passed', `the revised design passes its check (${JSON.stringify(turn2.saves[0].body?.design_check)})`);
    assert.equal(turn2.close.status, 200, `the close (${turn2.close.text?.slice(0, 400)})`);
    const [review] = await pump(fx, J.ctx, () => (reviewsOf(fx.home, p.id).some((r) => r.verdicts.length > 0) ? reviewsOf(fx.home, p.id).filter((r) => r.verdicts.length > 0) : undefined), { what: 'the review recorded', projectMs: 300_000 });
    J.review = review;
    assert.deepEqual([review.subject?.kind, review.subject?.candidate], ['candidate', deployed.id], 'its subject the Alpha candidate');
    assert.equal(review.trigger, 'alpha_complete', 'its trigger');
    assert.ok(review.verdicts.length === 4 && review.verdicts.every((v) => v.status === 'proposed'), `(d) every verdict proposed (${JSON.stringify(review.verdicts)})`);
    const android = verdictOf(review, 'android', 'S2');
    assert.deepEqual([android?.verdict, android?.not_observed_reason], ['not_observed', 'no_native_runtime'], '(d) the android screen not observed: no native runtime');
    assert.ok(reviewEvents(fx.home, 'design.review_recorded', p.id).length >= 1, '(e) design.review_recorded');
    assert.equal(review.confirmed_by ?? null, null, '(e) close confirms nothing');
    assert.equal(reviewEvents(fx.home, 'design.verdicts_confirmed', p.id).length, before.confirmed, '(e) no design.verdicts_confirmed');
    const design = await readDesign(fx, p.id);
    assert.equal(humanTestOf(design, 'web')?.status, 'pending', '(e) the web human test still pending');
    assert.deepEqual((humanTestOf(design, 'web')?.evidence ?? []).filter((e) => e.review === review.id), [], '(e) no owner evidence from the review yet');
    const verdicts = await pump(fx, J.ctx, () => openVerdicts(fx.home, p.id, review.id) ?? undefined, { what: 'design_verdicts raised at the close', projectMs: 300_000 });
    J.verdicts = verdicts;
    assert.equal(verdicts.subject_id, review.id, '(e) design_verdicts about the review');
  });

  step('(h) the design delta: one design_approval with one consolidated spec_change, batched with the verdicts; approve blocked until they are confirmed', async () => {
    const { fx, p, verdicts } = J;
    const approval = await pump(fx, J.ctx, () => {
      const v = decision(fx.home, verdicts.id);
      if (!v?.batch_key) return undefined;
      const m = batchMembers(fx.home, p.id, v.batch_key);
      return m.design_approval && m.spec_change ? m : undefined;
    }, { what: 'the review\'s batch: design_verdicts, design_approval and spec_change under one batch_key', projectMs: 600_000 });
    J.batch = approval;
    const kinds = Object.keys(approval).sort();
    assert.deepEqual(kinds, ['design_approval', 'design_verdicts', 'spec_change'], `one of each, one batch (${kinds})`);
    assert.equal(decisionsOn(fx.home, 'design_approval', approval.design_approval.subject_id).filter((d) => d.status === 'open').length, 1, 'one design_approval for the revised design');
    const blockers = blockersOf(approval.design_approval);
    assert.ok(blockers.some((b) => String(b).startsWith('DESIGN_VERDICTS_UNCONFIRMED')), `approve blocked until the verdicts are confirmed (${JSON.stringify(blockers)})`);
  });

  step('(f) design_verdicts confirmed with one edit and one strike: the confirmed verdicts recorded against the web human test as owner evidence bound to design version, candidate, target and observed_on, shown owner accepted apart from automated verification; the struck one not; design.verdicts_confirmed', async () => {
    const { fx, p, verdicts, review, deployed, before } = J;
    const now = decision(fx.home, verdicts.id);
    const res = await fx.engine.post(`/v1/projects/${p.id}/decisions/${now.id}/answer`, {
      option: 'confirm',
      preview_hash: now.preview_hash,
      edits: [{ target: 'web', screen: 'S1', deltas: [{ owner_words: EDITED_WORDS, kind: 'implementation' }] }],
      strikes: [{ target: 'web', screen: 'S3' }],
    });
    assert.equal(res.status, 200, `design_verdicts answered confirm with an edit and a strike (${res.text})`);
    const after_ = await pump(fx, J.ctx, () => {
      const r = reviewsOf(fx.home, p.id).find((x) => x.id === review.id);
      return r?.confirmed_by ? r : undefined;
    }, { what: 'the verdicts confirmed', projectMs: 120_000 });
    J.confirmed = after_;
    assert.equal(after_.confirmation_decision, now.id, 'recorded with the decision that confirmed them');
    const s1 = verdictOf(after_, 'web', 'S1');
    assert.equal(s1?.status, 'confirmed', 'S1 confirmed');
    assert.equal(s1?.deltas?.[0]?.owner_words, EDITED_WORDS, 'as the owner edited it');
    assert.equal(verdictOf(after_, 'web', 'S3')?.status, 'struck', 'S3 struck');
    assert.equal(verdictOf(after_, 'web', 'S4')?.status, 'confirmed', 'S4 confirmed');
    assert.equal(reviewEvents(fx.home, 'design.verdicts_confirmed', p.id).length, before.confirmed + 1, 'design.verdicts_confirmed');
    const design = await readDesign(fx, p.id);
    const web = humanTestOf(design, 'web');
    assert.notEqual(web?.status, 'verified', `never verified by the owner's word (${JSON.stringify(web)})`);
    const evidence = (web?.evidence ?? []).filter((e) => e.review === review.id);
    assert.deepEqual(evidence.map((e) => e.screen).sort(), ['S1', 'S4'], `the confirmed verdicts, and not the struck one, recorded against the web human test (${JSON.stringify(web?.evidence)})`);
    for (const e of evidence) {
      assert.deepEqual([e.design_version, e.candidate, e.target, e.observed_on], [1, deployed.id, 'web', 'browser'], `${e.screen}: bound to design version, candidate, target and observed_on (${JSON.stringify(e)})`);
      assert.equal(e.label, 'owner accepted', `${e.screen}: shown owner accepted (Q4)`);
    }
    assert.equal(humanTestOf(design, 'android')?.status, 'pending', 'the android human test pending: nothing observed natively');
    assert.equal(resultsOf(fx.home, p.id).length >= before.results, true, 'the check results are their own');
    assert.ok(!resultsOf(fx.home, p.id).some((r) => JSON.stringify(r).includes(review.id)), 'no check result made of the verdicts: apart from automated verification');
    // (h), continued: approve unblocked once they are confirmed.
    const approval = await pump(fx, J.ctx, () => {
      const a = decision(fx.home, J.batch.design_approval.id);
      const open = a.status === 'open' ? a : decisionsOn(fx.home, 'design_approval', a.subject_id).find((d) => d.status === 'open');
      return open && !blockersOf(open).some((b) => String(b).startsWith('DESIGN_VERDICTS_UNCONFIRMED')) ? open : undefined;
    }, { what: 'design_approval\'s approve unblocked by the confirmation', projectMs: 120_000 });
    assert.ok(approval, '(h) the approval no longer waits on the verdicts');
  });

  step('(g) the confirmed implementation defect: a finding against the review\'s candidate, Medium by default, dispositioned by the owner; fix as E43', async () => {
    const { fx, p, deployed } = J;
    const finding = await pump(fx, J.ctx, () => findingsOf(fx.home, p.id).find((f) => (f.message ?? '').includes(EDITED_WORDS)), { what: 'the finding from the confirmed defect', projectMs: 120_000 });
    assert.deepEqual([finding.scope, finding.candidate, finding.category], ['candidate', deployed.id, 'defect'], `against the review's candidate (${JSON.stringify(finding)})`);
    assert.deepEqual([finding.proposed_severity, finding.effective_severity], ['medium', 'medium'], 'Medium by default');
    assert.ok(!findingsOf(fx.home, p.id).some((f) => /should say so and link back/.test(f.message ?? '')), 'the design delta is not a finding');
    assert.ok(!findingsOf(fx.home, p.id).some((f) => /big page|S3/.test(f.message ?? '') && f.id !== finding.id), 'nothing from the struck verdict');
    const question = await pump(fx, J.ctx, () => decisionsOn(fx.home, 'finding_disposition', finding.id).find((d) => d.status === 'open'), { what: 'the owner\'s disposition question', projectMs: 120_000 });
    fx.scripted.kindScript('fix', { steps: [{ write: { path: 'web/index.html', content: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Pantry</title></head><body><main id="S1"><h1>Pantry</h1></main></body></html>\n' } }, { result: { status: 'completed', summary: 'the heading' } }] });
    await consume(fx, p.id, question, 'fix');
    const fix = await pump(fx, J.ctx, () => workOf(fx.home, p.id, 'fix').find((w) => w.subject?.finding === finding.id), { what: 'fix work from the owner\'s disposition (E43)', projectMs: 120_000 });
    assert.ok(fix, 'fix work registered from the finding');
    assert.equal(candidatesOfProject(fx.home, p.id).find((c) => c.id === deployed.id)?.progress, 'alpha_deployed', '(a) the review\'s candidate still alpha_deployed');
    await assertHoldsAccounted(fx, p.id, '(g)');
  });
});
