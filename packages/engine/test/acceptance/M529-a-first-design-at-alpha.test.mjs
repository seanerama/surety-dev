// M529, a first design at Alpha (slice 45; kernel lane). M6 plan §3.7 M529;
// D7 §10.6, §10.3, §10.4, §7.4; G7; E153 item 1 (d); E156 Q2; SEAM.md
// §§518, 519, 521 to 527.
//
// Pantry built with no design and `alpha_deployed` on the kernel lane; then
// the review at Alpha finds no approved design and produces the first one.
// (a) `at_alpha`, no design approved, `alpha_complete`: the review opens with
//     no `design_revision`;
// (b) `both` with the design before build waived: the same;
// (c) the review session's product: `origin: observed`, `first_design:
//     true`; the design check as for any design (a defect refused, the whole
//     passing);
// (d) close and approval: `design_approval` scope `initial_review` with no
//     deltas recorded and the consolidated `spec_change`; placeholders for
//     the default slots with no file;
// (e) its criterion (R3.2) names a requirement of the completed phase:
//     failing on the Alpha candidate, one delivery replan as M517 (a), under
//     the built trigger `spec_change` (E156 Q2); passing, none (E153 item 1
//     (d));
// (f) a confirmed implementation defect: filed as M516 (g), a finding
//     against the review's candidate, Medium.
//
// No unit (kernel lane): the Alpha is the scripted adapter's. Nothing the
// Designer wrote is run (rule 21).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { candidatesOfProject, pump, specRevisions } from './harness/journey/drive.mjs';
import { allReplans, changeReplans } from './harness/journey/final153.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { REQUIREMENTS } from './harness/design/reference.mjs';
import { assertNoSilentHold, designRevisions, effectiveAssets, inventoryOf, manifestOf, openDesigner } from './harness/design/drive.mjs';
import { KERNEL_KINDS, designModel, filesOf, variantOf } from './harness/design/check41.mjs';
import { approveReviewBatch, batchSpec, currentRevision, latestRequest, specWriter } from './harness/design/plan44.mjs';
import {
  DELIVERY_BUILDER,
  MARKER_CORRECTION,
  MARKER_CRITERION,
  REVIEW_FILE,
  batchMembers,
  blockersOf,
  deliveryReplan,
  driveReview,
  findingsOf,
  markerFails,
  markerPasses,
  openVerdicts,
  packageJson,
  packageOfLaunch,
  readDesign,
  reviewJson,
  reviewsOf,
  toAlphaWithoutDesign,
} from './harness/design/review45.mjs';

const DEFECT_WORDS = 'On the Alpha the Add button does nothing.';

// The first design drawn from the Alpha (D7 §10.6): designModel's, origin
// observed, the criterion R3.2 on android.
function firstDesign(p) {
  return variantOf(designModel(inventoryOf(p)), (m) => {
    m.design.origin = 'observed';
    m.criteria.criteria = [{ ...MARKER_CRITERION }];
  });
}
// The same with S1 missing the `empty` state of list-items (a defect of clause 3).
const withDefect = (model) =>
  variantOf(model, (m) => {
    const s1 = m.screens.screens.find((s) => s.key === 'S1');
    s1.states = s1.states.filter((s) => !(s.obligation.interface === 'list-items' && s.obligation.state === 'empty'));
  });
const firstReview = (candidate, screens) => reviewJson({ design_version: null, subject: { kind: 'candidate', candidate }, screens, revised_design: false, first_design: true });

// The review's session to its close: the package dumped; a defective first
// design; the whole first design with the review file. Returns {run, out, model, v2}.
async function firstDesignSession(fx, a, { verdicts = [] } = {}) {
  const { p, deployed } = a;
  const model = firstDesign(p);
  const v2 = batchSpec({ base: REQUIREMENTS, criteria: model.criteria });
  fx.scripted.kindScript('spec_change', specWriter(v2.text, v2.changes));
  fx.scripted.kindScript('check_correction', MARKER_CORRECTION);
  const run = await openDesigner(fx, p.id, { mode: 'review' });
  const review = { [REVIEW_FILE(1)]: firstReview(deployed.id, verdicts) };
  const out = await driveReview(fx, p.id, run, [
    { dump: true, say: 'There is no design yet: draw it from what runs.', reply: 'I have the Alpha\'s source and what the engine observed.', save: false },
    { clear: true, files: { ...filesOf(withDefect(model)), ...review }, say: 'Draw it.' },
    { clear: true, files: { ...filesOf(model), ...review }, say: 'Fix what the engine said.', done: true },
  ]);
  return { run, out, model, v2 };
}

describe('M529 a first design at Alpha under at_alpha, its criterion failing on the Alpha candidate (shared)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    Object.assign(J, await toAlphaWithoutDesign(fx, { name: 'pantry-first-design' }));
    J.old = new Set(candidatesOfProject(fx.home, J.p.id).map((c) => c.id));
  });
  after(shared.cleanup);

  test('(a) at_alpha, no design approved, alpha_complete: design_due alpha_review; the review opens with no design_revision; (c) its product origin observed, first_design true, the design check as for any design', async () => {
    const { fx, p, due } = J;
    assert.equal(due.evidence?.stage, 'alpha_review', 'design_due stage alpha_review');
    assert.deepEqual(designRevisions(fx.home, p.id).filter((r) => ['approved', 'approved_without_criteria'].includes(r.status)), [], 'the fixture is live: no design approved');
    const s = await firstDesignSession(fx, J, { verdicts: [{ target: 'web', key: 'S1', verdict: 'deltas', observed_on: 'browser', evidence: [], deltas: [{ owner_words: DEFECT_WORDS, kind: 'implementation' }] }] });
    Object.assign(J, s);
    const pkg = packageOfLaunch(fx, s.run.id, 0);
    const meta = packageJson(pkg, 'design/review.json');
    assert.deepEqual([meta?.design_revision ?? null, meta?.first_design], [null, true], `the package says there is no approved design: a first design (${JSON.stringify(meta)})`);
    assert.ok(!Object.keys(pkg ?? {}).some((n) => n.startsWith('design/approved/')), 'and carries none');
    const [defective, whole] = s.out.saves.slice(1);
    assert.equal(defective?.body?.design_check?.outcome, 'refused', `the defective first design refused by the design check (${JSON.stringify(defective?.body?.design_check)})`);
    assert.ok((defective.body.design_check.reasons ?? []).some((r) => r.code === 'DESIGN_STATE_UNCOVERED' && JSON.stringify(r.subjects).includes('web')), 'DESIGN_STATE_UNCOVERED naming the web target');
    assert.equal(whole?.body?.design_check?.outcome, 'passed', `the whole first design passes (${JSON.stringify(whole?.body?.design_check)})`);
    assert.equal(s.out.close.status, 200, `the close (${s.out.close.text?.slice(0, 400)})`);
    const review = reviewsOf(fx.home, p.id).at(-1);
    J.review = review;
    assert.equal(review?.design_revision ?? null, null, `the review recorded with no design_revision (${JSON.stringify(review)})`);
    const proposed = designRevisions(fx.home, p.id).at(-1);
    assert.equal(proposed?.origin, 'observed', 'the close\'s design: origin observed');
  });

  test('(d) close and approval: design_approval scope initial_review, no deltas recorded, with the consolidated spec_change; approved as an initial design; placeholders for the default slots with no file', async () => {
    const { fx, p, ctx, review } = J;
    const members = await pump(fx, ctx, () => {
      const v = openVerdicts(fx.home, p.id, review.id);
      const m = v?.batch_key ? batchMembers(fx.home, p.id, v.batch_key) : null;
      return m?.design_approval && m?.spec_change ? m : undefined;
    }, { what: 'the first design\'s batch', max: 40 });
    const approval = members.design_approval;
    assert.equal(approval.evidence?.scope, 'initial_review', `scope initial_review (D7 §10.6) (${JSON.stringify(approval.evidence)?.slice(0, 400)})`);
    assert.deepEqual(approval.evidence?.deltas ?? [], [], 'no deltas recorded: there is nothing to differ from');
    assert.ok(members.spec_change && members.design_verdicts, 'the consolidated spec_change and the verdicts in the same batch');
    assert.ok(blockersOf(approval).some((b) => String(b).startsWith('DESIGN_VERDICTS_UNCONFIRMED')), 'approve waits on the verdicts');
    const before_ = findingsOf(fx.home, p.id).length;
    J.findingsBefore = before_;
    // The correction's proposal left unanswered until (e), so no result of R3.2's check is recorded before it.
    ctx.answerKinds = [];
    await approveReviewBatch(fx, ctx);
    const rev = await pump(fx, ctx, () => currentRevision(fx.home, p.id) ?? undefined, { what: 'the first design approved', max: 20 });
    assert.deepEqual([rev.scope, rev.origin], ['initial_review', 'observed'], 'approved as an initial design, observed');
    const v2 = specRevisions(fx.home, p.id).find((r) => r.version === 2);
    assert.ok(v2, 'its spec change applied');
    const eff = effectiveAssets(fx.home, p.id);
    assert.ok(eff.length > 0 && eff.every((e) => e.source === 'placeholder'), `every default slot the design gave no file: its placeholder (${JSON.stringify(eff)})`);
    const manifest = manifestOf(p);
    for (const slot of manifest.slots) for (const v of slot.variants) assert.ok(v.file && v.digest, `${slot.key}/${v.name} has a file`);
    J.request = latestRequest(fx.home, p.id);
    J.rev = rev;
  });

  test('(f) the confirmed implementation defect: a finding against the review\'s candidate, Medium', async () => {
    const { fx, p, deployed, findingsBefore } = J;
    const found = findingsOf(fx.home, p.id).slice(findingsBefore).filter((f) => (f.message ?? '').includes(DEFECT_WORDS));
    assert.equal(found.length, 1, `one finding from the confirmed defect (${JSON.stringify(findingsOf(fx.home, p.id).slice(findingsBefore))})`);
    assert.deepEqual([found[0].candidate, found[0].category, found[0].proposed_severity], [deployed.id, 'defect', 'medium'], 'against the review\'s candidate, a defect, Medium by default');
  });

  test('(e) the criterion of the completed phase failing on the Alpha candidate: one delivery replan, trigger spec_change naming the request, as M517 (a)', async () => {
    const { fx, p, ctx, old, request } = J;
    const r = deliveryReplan(fx, p.id, { spec_version: 2 });
    fx.scripted.kindScript('replan', [r, r, r]);
    fx.scripted.kindScript('stage_build', DELIVERY_BUILDER);
    ctx.answerKinds = [...KERNEL_KINDS];
    const items = await pump(fx, ctx, () => {
      const x = changeReplans(fx.home, p.id, request.id);
      return x.length > 0 ? x : undefined;
    }, { what: 'the first design\'s replan', max: 60, exits: markerFails(old) });
    assert.equal(items.length, 1, 'one replan from the first design\'s change');
    assert.equal(items[0].trigger_source, 'spec_change', 'under the built trigger spec_change (E156 Q2)');
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(allReplans(fx.home, p.id).length, 1, 'and no other');
    assertNoSilentHold(fx.home, p.id, '(e)');
  });
});

describe('M529 a first design at Alpha: the criterion passing; under both with the design waived', () => {
  test('(e) the criterion passing on the Alpha candidate: no replan, no build phase (E153 item 1 (d))', async (t) => {
    const fx = await scriptedEngine(t);
    const a = await toAlphaWithoutDesign(fx, { name: 'pantry-first-satisfied' });
    const s = await firstDesignSession(fx, a);
    assert.equal(s.out.close.status, 200, `the close (${s.out.close.text?.slice(0, 400)})`);
    await approveReviewBatch(fx, a.ctx, { verdicts: 'any' });
    const request = latestRequest(fx.home, a.p.id);
    let quiet = 0;
    await pump(fx, a.ctx, () => (++quiet > 20 ? true : undefined), { what: 'the change applied and quiet', max: 40, exits: markerPasses() });
    assert.equal(currentRevision(fx.home, a.p.id)?.scope, 'initial_review', 'the fixture is live: the first design approved');
    assert.deepEqual(changeReplans(fx.home, a.p.id, request.id), [], 'no replan: the existing candidate satisfies the change');
    assert.deepEqual(allReplans(fx.home, a.p.id), [], 'none at all');
  });

  test('(b) both with the design before build waived: at alpha_complete the review opens with no design_revision', async (t) => {
    const fx = await scriptedEngine(t);
    const a = await toAlphaWithoutDesign(fx, { name: 'pantry-waived', waive: true });
    assert.equal(a.waived?.evidence?.stage, 'before_build', 'the fixture is live: design_due before build, answered waive');
    assert.deepEqual(designRevisions(fx.home, a.p.id), [], 'no design revision');
    const run = await openDesigner(fx, a.p.id, { mode: 'review' });
    await driveReview(fx, a.p.id, run, [{ dump: true, say: 'Nothing was designed: draw it from the Alpha.', save: false }], { close: { refuse: true } });
    const meta = packageJson(packageOfLaunch(fx, run.id, 0), 'design/review.json');
    assert.deepEqual([meta?.design_revision ?? null, meta?.first_design], [null, true], `the review opens with no design_revision: a first design (${JSON.stringify(meta)})`);
    const design = await readDesign(fx, a.p.id);
    assert.ok(!(design.revisions ?? []).some((r) => ['approved', 'approved_without_criteria'].includes(r.status)), 'nothing approved');
  });
});
