// M518, retrofit: the observed design (slice 45; kernel lane). M6 plan §3.7
// M518; D7 §12, §4.1, §5.6, §6.3, §7.4; D6 §8; B11's reasoning; BS6 §8 (the
// retrofit fixture with a UI); SEAM.md §§376 to 386, 521, 528.
//
// "Shelf" (harness/design/retrofit45.mjs): M5's adopted "Sums" with two web
// pages, a stylesheet of literals, a logo and a route its README names,
// adopted in full mode through the owner's routes, its retrofit spec
// (`**Targets:** web`, R5 and R6 observed UI requirements) approved with each
// requirement answered, the retrofit Architect's map with `history-feed`
// `shape: "unknown"`, the conformance plan published. Then a Designer
// session on the adopted project:
// (a) retrofit mode: the package names the UI source as its input;
// (b) its products: tokens from the stylesheet's literals, a screen per
//     existing route mapped to the confirmed requirements, `static_html`
//     copies of the pages, `origin: observed`;
// (c) the existing logo: a slot of provenance `observed`, `proposed`; the
//     default slots with no file: placeholders;
// (d) a convention the code does not show (`browser_back: unknown`):
//     `DESIGN_CONVENTION_UNKNOWN`, blocking approval under `before_build`,
//     shown and not blocking under `at_alpha`;
// (e) the interface the map cannot shape: `shape_known: false` in the
//     inventory, nothing derived from it; `DESIGN_INTERFACE_SHAPE_UNKNOWN`
//     on every screen using it, with the same rule;
// (f) the proposed criterion (R5.2): never in the conformance set: phase 1
//     conforms and completes with R5.2's check failing on the adopted code;
// (g) the approval: `design_approval` with its origin shown.
// Nothing invented: no shape, target or convention the engine did not read.
//
// No unit (kernel lane): the conformance Alpha is the scripted adapter's.
// Nothing the Designer wrote is run (rule 21).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decisionsOfKind } from './harness/decisions.mjs';
import { alphaReady, evaluationsOfKind, phaseCompleted, pump, stagesOfPlan } from './harness/journey/drive.mjs';
import { conformancePlan, conformanceStages, retrofitEngine, toConformancePublished } from './harness/retrofit/drive.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { answerWith, designRevisions, effectiveAssets, inventoryOf, manifestOf, openDesignDue, openDesigner } from './harness/design/drive.mjs';
import { designAssetsOf } from './harness/design/assets43.mjs';
import { specWriter } from './harness/design/plan44.mjs';
import { batchMembers, blockersOf, driveReview, packageJson, packageOfLaunch, readDesign } from './harness/design/review45.mjs';
import {
  HISTORY_HTML,
  LOGO_SVG,
  PAGE_CHECKS,
  PAGE_HTML,
  R5_TOKENS,
  R5_TOKENS_CHECK,
  R5_TOKENS_CORRECTION,
  SHELF_ANSWERS,
  SHELF_ARCHITECT,
  SHELF_EXTRA,
  SHELF_REQUIREMENTS,
  SHELF_SPEC,
  STYLE_CSS,
  UI_FILES,
  observedDesign,
  sha256hex,
  shelfSpecText,
} from './harness/design/retrofit45.mjs';

const codesOf = (check, list = 'reasons') => (check?.[list] ?? []).map((r) => r.code);
const reasonOf = (check, code, list = 'reasons') => (check?.[list] ?? []).filter((r) => r.code === code);
const named = (reasons, ...names) => reasons.some((r) => names.every((n) => JSON.stringify(r.subjects ?? r).includes(n)));

// Shelf adopted, specified, its architecture and conformance plan published under `policy`.
async function shelfPublished(t, policy) {
  const fx = await retrofitEngine(t, { extraAuthoring: PAGE_CHECKS });
  const J = await toConformancePublished(fx, { policy, answers: SHELF_ANSWERS, spec: SHELF_SPEC, architect: SHELF_ARCHITECT, repoOpts: { extra: SHELF_EXTRA } });
  assert.equal(J.architect.closeRes.status, 200, `the retrofit Architect's close is accepted (${J.architect.closeRes.status} ${J.architect.closeRes.text?.slice(0, 800)}; save findings ${JSON.stringify(J.architect.saved?.findings)?.slice(0, 600)})`);
  assert.ok(conformancePlan(fx.home, J.p.id), 'the fixture is live: the conformance plan published');
  return { fx, ...J };
}

// The batched change's specification for the observed design: R5.2 under R5
// (the criterion's text verbatim) and the web human-test requirement R7.
function shelfV2() {
  const reqs = SHELF_REQUIREMENTS.map((r) => (r.key === 'R5' ? { ...r, criteria: [...r.criteria, { id: 'R5.2', text: R5_TOKENS.text }] } : r));
  reqs.push({ key: 'R7', title: 'The web UI matches the approved design', phase: 1, module: 'web', origin: 'intended', statement: 'A person judges the web UI against the approved design.', criteria: [] });
  const human = 'The web UI matches approved design version 1, as observed from the adopted pages: screens S1 and S2.';
  const text = shelfSpecText({ version: 2, requirements: reqs, changeLog: [{ version: 2, date: '2026-10-17', change: 'The observed design\'s criterion and human test', by: 'Sean' }] }).replace(
    '### R7. The web UI matches the approved design\n\nA person judges the web UI against the approved design.\n\n**Surface:** ui (web)\n\n**Rationale.** The service does this today, or its README says it does.\n\n**Sensitive areas:** none\n\n**Acceptance criteria**\n\n',
    `### R7. The web UI matches the approved design\n\nA person judges the web UI against the approved design.\n\n**Surface:** ui (web)\n\n**Rationale.** The service does this today, or its README says it does.\n\n**Sensitive areas:** none\n\n**Human test.**\n\n${human}\n`,
  );
  return { text, changes: [{ key: 'R5', kind: 'criteria_added', reason: 'the observed design\'s criterion' }, { key: 'R7', kind: 'added', reason: 'the web human test of the observed design' }] };
}

describe('M518 retrofit: the observed design', () => {
  test('(a) a retrofit-mode Designer session: the package names the UI source as input; (e) the interface the map cannot shape listed shape unknown, nothing derived from it; (d), (e) under before_build DESIGN_CONVENTION_UNKNOWN and DESIGN_INTERFACE_SHAPE_UNKNOWN block approval', async (t) => {
    const { fx, p } = await shelfPublished(t, { design: 'before_build' });
    // (e) the inventory: nothing invented.
    const inventory = inventoryOf(p);
    const feed = (inventory.interfaces ?? []).find((i) => i.name === 'history-feed');
    assert.ok(feed, `the inventory lists the interface the map could not shape (${JSON.stringify(inventory.interfaces)})`);
    assert.equal(feed.shape_known, false, 'shape unknown (B.9 shape_known)');
    assert.ok(feed.request === undefined && feed.response === undefined, `no shape invented (${JSON.stringify(feed)})`);
    assert.deepEqual((inventory.obligations ?? []).filter((o) => o.interface === 'history-feed'), [], 'no state obligation derived from an unknown shape');
    assert.deepEqual((inventory.fixtures ?? []).filter((f) => f.interface === 'history-feed'), [], 'no fixture generated for it');
    assert.equal((inventory.interfaces ?? []).find((i) => i.name === 'sum-route')?.shape_known, true, 'the shaped interface is known');
    assert.deepEqual((inventory.targets ?? []).map((x) => x.target), ['web'], 'no target beyond the spec\'s');
    // (a) the retrofit-mode session.
    const run = await openDesigner(fx, p.id);
    const out = await driveReview(fx, p.id, run, [
      { dump: true, say: 'Capture the design of the pages as they are.', reply: 'I have the pages and the stylesheet.', save: false },
      { files: observedDesign(inventory, manifestOf(p), { unknownBack: true }), say: 'Write what you see; where you cannot tell, say unknown.' },
    ], { close: null });
    const pkg = packageOfLaunch(fx, run.id, 0);
    assert.match(pkg?.['prompt.md']?.text ?? '', /retrofit/i, 'the package says retrofit');
    for (const [path, text] of Object.entries(UI_FILES)) assert.equal(pkg?.[`design/source/${path}`]?.sha256, sha256hex(text), `the adopted ${path} in the package as its input (design/source/${path})`);
    assert.ok(!Object.keys(pkg ?? {}).some((n) => n === 'design/source/server.mjs'), 'the UI source only');
    // (d), (e) blocking under before_build.
    const check = out.saves[1]?.body?.design_check;
    assert.equal(out.saves[1]?.status, 200, `the save answers with its check (${out.saves[1]?.text?.slice(0, 400)})`);
    assert.equal(check?.outcome, 'refused', `refused under before_build (${JSON.stringify(check)})`);
    assert.ok(named(reasonOf(check, 'DESIGN_CONVENTION_UNKNOWN'), 'S2', 'browser_back'), `(d) DESIGN_CONVENTION_UNKNOWN naming S2 and browser_back (${JSON.stringify(check?.reasons)})`);
    for (const screen of ['S1', 'S2']) assert.ok(named(reasonOf(check, 'DESIGN_INTERFACE_SHAPE_UNKNOWN'), screen, 'history-feed'), `(e) DESIGN_INTERFACE_SHAPE_UNKNOWN on ${screen}, which uses history-feed`);
    const closed = await postCloseRaw(fx, p.id, run.id, {});
    assert.deepEqual([closed.status, closed.body?.code], [422, 'design_check_failed'], `the close refused: approval blocked (${closed.text?.slice(0, 400)})`);
    assert.ok(openDesignDue(fx.home, p.id), 'design_due open: no silent stall');
    assert.deepEqual(designRevisions(fx.home, p.id).filter((r) => ['approved', 'approved_without_criteria'].includes(r.status)), [], 'nothing approved');
  });

  test('(d), (e) under at_alpha shown and not blocking; (b) the observed products; (c) the existing logo observed and proposed, placeholders for the rest; (g) design_approval with its origin shown; (f) the criterion never in the conformance set', async (t) => {
    const s = await shelfPublished(t, { design: 'at_alpha', alpha_deploy: 'manual' });
    const { fx, p, ctx } = s;
    fx.scripted.kindScript('check_correction', R5_TOKENS_CORRECTION);
    const v2 = shelfV2();
    fx.scripted.kindScript('spec_change', specWriter(v2.text, v2.changes));
    const inventory = inventoryOf(p);
    const run = await openDesigner(fx, p.id);
    const out = await driveReview(fx, p.id, run, [{ files: observedDesign(inventory, manifestOf(p), { unknownBack: true }), say: 'Capture the design of the pages as they are.', done: true }], { close: null });
    const check = out.saves[0]?.body?.design_check;
    assert.equal(check?.outcome, 'passed', `(d), (e) not blocking under at_alpha (${JSON.stringify(check)})`);
    assert.ok(named(reasonOf(check, 'DESIGN_CONVENTION_UNKNOWN', 'notices'), 'S2', 'browser_back'), `(d) shown: DESIGN_CONVENTION_UNKNOWN among the check's notices (${JSON.stringify(check?.notices)})`);
    assert.ok(named(reasonOf(check, 'DESIGN_INTERFACE_SHAPE_UNKNOWN', 'notices'), 'S1', 'history-feed') && named(reasonOf(check, 'DESIGN_INTERFACE_SHAPE_UNKNOWN', 'notices'), 'S2', 'history-feed'), '(e) shown on both screens');
    assert.ok(!codesOf(check).includes('DESIGN_CONVENTION_UNKNOWN') && !codesOf(check).includes('DESIGN_INTERFACE_SHAPE_UNKNOWN'), 'and not among the reasons that refuse');
    // The close and its batch; the build's own routed decisions held back until (f).
    ctx.answerKinds = [];
    const closed = await postCloseRaw(fx, p.id, run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const batch = await pump(fx, ctx, () => designRevisions(fx.home, p.id).filter((r) => r.status === 'proposed').at(-1), { what: 'the close\'s product recorded', max: 10 });
    // (b) the products, as recorded.
    assert.deepEqual([batch.origin, batch.status], ['observed', 'proposed'], `(b) the design recorded origin observed (${JSON.stringify(batch)})`);
    // (c) the logo and the placeholders, on the close's revision.
    const assets = designAssetsOf(fx.home, batch.id);
    const logo = assets.find((a) => a.slot === 'logo' || a.kind === 'logo');
    assert.deepEqual([logo?.provenance, logo?.status], ['observed', 'proposed'], `(c) the existing logo: provenance observed, proposed (${JSON.stringify(logo)})`);
    const favicon = assets.find((a) => a.slot === 'favicon' || a.kind === 'favicon');
    assert.deepEqual([favicon?.provenance, favicon?.status], ['engine_placeholder', 'placeholder'], `(c) a default slot with no file: its placeholder (${JSON.stringify(favicon)})`);
    // (g) the approval with its origin shown; the notices shown, not blocking.
    const approval = await pump(fx, ctx, () => decisionsOfKind(fx.home, p.id, 'design_approval').filter((d) => d.status === 'open').at(-1), { what: 'design_approval raised', max: 40 });
    assert.equal(approval.evidence?.origin, 'observed', `(g) the approval shows the origin (${JSON.stringify(approval.evidence)?.slice(0, 400)})`);
    assert.match(JSON.stringify(approval.evidence), /DESIGN_CONVENTION_UNKNOWN/, '(d) shown on the approval');
    assert.ok(!blockersOf(approval).some((b) => /DESIGN_CONVENTION_UNKNOWN|DESIGN_INTERFACE_SHAPE_UNKNOWN/.test(String(b))), '(d), (e) and not blocking it');
    const members = batchMembers(fx.home, p.id, approval.batch_key);
    assert.ok(members.spec_change, 'its consolidated spec_change in the batch');
    const a = await answerWith(fx, p.id, approval, 'approve');
    assert.equal(a.status, 200, `design_approval approved (${a.text})`);
    await consume(fx, p.id, members.spec_change, 'approve');
    const approved = await pump(fx, ctx, () => designRevisions(fx.home, p.id).find((r) => r.status === 'approved'), { what: 'the observed design approved', max: 20 });
    assert.equal(approved.origin, 'observed', '(g) approved as observed');
    const design = await readDesign(fx, p.id);
    assert.ok((design.revisions ?? []).some((r) => r.id === approved.id && r.origin === 'observed'), '(g) GET …/design shows the origin');
    const eff = effectiveAssets(fx.home, p.id);
    assert.equal(eff.find((e) => e.slot === 'logo' && e.variant === 'full')?.digest, sha256hex(LOGO_SVG), '(c) approved: the repository\'s logo effective');
    assert.ok(eff.filter((e) => e.slot !== 'logo').every((e) => e.source === 'placeholder'), '(c) the rest placeholders');
    // (f) never the conformance set: R5.2's check failing on the adopted code, phase 1 conforms and completes.
    ctx.answerKinds = undefined;
    const exits = (x) => (x.key === R5_TOKENS_CHECK ? 1 : 0);
    await alphaReady(fx, ctx);
    const phase1 = await phaseCompleted(fx, ctx, 1, { max: 160, exits });
    assert.ok(phase1.completed_at, '(f) phase 1 complete');
    const stage = conformanceStages(fx.home, p.id)[0];
    assert.equal(stage.conformance_state, 'conformed', '(f) the conformance stage conformed');
    const plan = conformancePlan(fx.home, p.id) ?? { id: stage.phase_plan };
    const criteria = stagesOfPlan(fx.home, plan.id).flatMap((x) => x.validation?.criteria ?? []);
    assert.ok(!criteria.includes('R5.2'), `(f) R5.2 is not in the conformance stage's criteria (${criteria})`);
    for (const e of [...evaluationsOfKind(fx.home, p.id, 'stage'), ...evaluationsOfKind(fx.home, p.id, 'phase')]) {
      if (e.outcome === 'satisfied') continue;
      assert.ok(!JSON.stringify(e.reasons).includes('R5.2') && !JSON.stringify(e.reasons).includes(R5_TOKENS_CHECK), `(f) no conformance-phase gate waits on the design criterion (${JSON.stringify(e.reasons)})`);
    }
    void STYLE_CSS;
    void PAGE_HTML;
    void HISTORY_HTML;
  });
});
