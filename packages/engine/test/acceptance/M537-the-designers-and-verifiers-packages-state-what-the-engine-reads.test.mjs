// M537 (a), the packages state what the engine reads (M6 slice 46; kernel
// lane). M6 plan §3.8 M537 (a); D7 §3.4, §8.4, §10.2, §10.5, §12; E151;
// E135; BS6 §11.4 ("the Designer's package is built from the registry like
// M5's, and its rehearsal fake plays from it"); SEAM.md §§453, 454, 537, 538.
//
// Each package states, as `json surety-reads <id>` blocks of its prompt.md
// listed in its manifest's `reads` (SEAM.md §453's form), what the engine's
// parser and design check read of the role's product, from the constants
// they use (SEAM.md §538 pins each element's JSON):
//   (a1) the Designer's session package: `designer.inventory` (the
//        inventory it is drawn against), `designer.schemas` (B.8 to B.16 as
//        closed JSON Schemas, the turn result's among them; result-schema.json
//        carries `findings`), `designer.check_reasons` (every design-check
//        and asset reason with its meaning, the contrast ratio),
//        `designer.conventions` (§5.3 per target, the not-checkable column),
//        `designer.criterion_catalogue` (§7.2 with targets and technologies),
//        `designer.mockup_kinds` (the kinds each capability admits; an HTML
//        mockup of a non-web target is a simulation and must be declared
//        one), `designer.selection_floor` (the defaults and the floor),
//        `designer.external_urls` (the pinned-URL rule and the project's
//        allowlist), `designer.layouts` (the configured layouts); never the
//        Spec Writer's or the Architect's transcript (searched);
//   (a2) the phase-authoring and correction Verifier packages:
//        `verifier.design_catalogue` (the catalogue with what each kind reads
//        and where it applies; the design criteria with their implemented
//        paths; how a check reads a slot);
//   (a3) the review-mode package of an owner-invoked review: the base
//        elements and `designer.review`, each owner item labelled
//        (the build identifier verbatim and `owner_reported`, each evidence
//        file `owner_supplied`);
//   (a4) the retrofit-mode package: the base elements and
//        `designer.retrofit` (origin observed, the UI source it reads);
//   (a5) the registry (`GET /v1/harness/package-elements`) lists every id.
//
// Pantry (harness/design/), on the scripted backend through the owner's
// routes, `design_widths` and `design_external_urls` set away from their
// defaults so that the package is seen to state the project's values. A
// gap is listed with every other gap of its package in one assertion.
// No unit, no browser, nothing executed (BS6 §4.1 rules 21, 22).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { candidatesOfProject, journeyContext, pump } from './harness/journey/drive.mjs';
import { conformancePlan, retrofitEngine, toConformancePublished } from './harness/retrofit/drive.mjs';
import { scriptedEngine, waitForIdle } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { designPackageProblems, DESIGNER_ELEMENTS, DESIGNER_RETROFIT_ELEMENTS, DESIGNER_REVIEW_ELEMENTS, M6_ELEMENTS, VERIFIER_DESIGN_ELEMENTS } from './harness/design/packages46.mjs';
import { packageReads } from './harness/real/packages.mjs';
import { ANDROID_LOGO_PATH, CORRECTION_FILES, DESIGN_CRITERIA_IDS, WEB_LOGO_PATH, authoringFiles } from './harness/design/reference.mjs';
import { batchOf, designScripts, designerSession, dumpedPackage, inventoryOf, openDesigner, scriptBuilders, toPublished, validDesign, answerWith } from './harness/design/drive.mjs';
import { designedPantry } from './harness/design/plan44.mjs';
import { designReview, driveReview, evidenceBytes, evidenceFiles, packageOfLaunch } from './harness/design/review45.mjs';
import { PAGE_CHECKS, SHELF_ANSWERS, SHELF_ARCHITECT, SHELF_EXTRA, SHELF_SPEC } from './harness/design/retrofit45.mjs';

const WIDTHS = Object.freeze([400, 1100]);
const ORIENTATIONS = Object.freeze(['portrait', 'landscape']);
const ALLOWLIST = Object.freeze(['cdn.jsdelivr.net']);
const POLICY = Object.freeze({ design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 }, design_widths: [...WIDTHS], design_external_urls: [...ALLOWLIST] });
// What the Spec Writer's and the Architect's sessions said (drive.mjs, journey/spec34.mjs): never in a Designer package.
const OTHER_TRANSCRIPTS = Object.freeze(['Design Pantry from the approved specification and plan phase 1.', 'Architecture, module map with surfaces, targets and shapes, one ADR, the roadmap and phase 1.', 'Write draft 1.']);
const DUMP = Object.freeze({ probe: { action: 'context_dump' } });
const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));
const assertNoGaps = (problems, what) => assert.deepEqual(problems, [], `${what}: every element the engine reads is stated (SEAM.md §538); the gaps:\n- ${problems.join('\n- ')}`);
// {name: {text}} as dumpedPackage gives it → {name: text}, as packageReads reads it.
const texts = (pkg) => Object.fromEntries(Object.entries(pkg ?? {}).map(([k, v]) => [k, v?.text ?? null]));
const digestOf = (home, project) => withStore(home, (db) => db.prepare('SELECT "design_inventory_digest" AS d FROM "projects" WHERE "id" = ?').get(project))?.d ?? null;

// The facts an element is checked against: the inventory as committed, its
// targets, the project's layouts and allowlist.
function factsOf(fx, p, inventory) {
  return {
    inventory,
    digest: digestOf(fx.home, p.id) ?? inventory.inventory_digest,
    targets: (inventory.targets ?? []).map((t) => ({ module: t.module, target: t.target, ui_technology: t.ui_technology, preview_capability: t.preview_capability, layouts: t.layouts })),
    widths: [...WIDTHS],
    orientations: [...ORIENTATIONS],
    allowlist: [...ALLOWLIST],
  };
}

// Every package a launch of `kind` of the project dumped, in launch order.
function dumpsOfKind(fx, project, kind) {
  const out = [];
  for (const launch of fx.scripted.launches().filter((l) => l.work_kind === kind && (l.project === undefined || l.project === project))) {
    const dump = fx.scripted.probes(launch.invocation, 'context_dump').at(-1);
    if (dump?.outcome !== 'dumped') continue;
    out.push(Object.fromEntries((dump.files ?? []).filter((f) => f.type === 'file').map((f) => [f.name, f.text ?? null])));
  }
  return out;
}

describe('M537 (a) the Designer\'s package, and the Verifier\'s design additions (Pantry, designed before build)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: POLICY, name: 'pantry-m537' });
    designScripts(fx);
    // Every authoring and correction run dumps its package first.
    const authoring = roleThat([DUMP, ...writes(authoringFiles())], { proposal: { rationale: 'The Verifier authors phase 1\'s checks before any stage builds.', requested_change_kind: 'unclassifiable' } });
    fx.scripted.kindScript('check_authoring', [0, 1, 2, 3].map(() => authoring));
    fx.scripted.kindScript('check_correction', roleThat([DUMP, ...writes(CORRECTION_FILES)], { proposal: { rationale: 'The approved design added R2.2, R2.3 and R3.2: their checks.', requested_change_kind: 'tightening' } }));
    scriptBuilders(fx, p.id);
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
    J.inventory = inventoryOf(p);
    const s = await designerSession(fx, p.id, [{ files: validDesign(p), dump: true, say: 'Draw Pantry for the web and Android.', result: { done: true } }]);
    J.designer = texts(dumpedPackage(fx, s.run.id, 0));
    J.saved = s.saves[0];
    const batch = await pump(fx, ctx, () => {
      const b = batchOf(fx.home, p.id);
      return b?.spec_change ? b : undefined;
    }, { what: 'the batch', max: 40 });
    const a = await answerWith(fx, p.id, batch.design_approval, 'approve');
    assert.equal(a.status, 200, `design_approval answered approve (${a.text})`);
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => (dumpsOfKind(fx, p.id, 'check_correction').length > 0 ? true : undefined), { what: 'the design criteria\'s correction to run', max: 60 });
    J.authoring = dumpsOfKind(fx, p.id, 'check_authoring')[0] ?? null;
    J.correction = dumpsOfKind(fx, p.id, 'check_correction')[0] ?? null;
    Object.assign(J, { fx, p, facts: factsOf(fx, p, J.inventory) });
  });
  after(shared.cleanup);

  test('(a1) the Designer\'s session package states the inventory, B.8 to B.16, the reasons, the conventions, the catalogue, the mockup kinds and the simulation rule, the defaults and the floor, the pinned-URL rule and allowlist, the layouts', () => {
    assert.ok(J.designer?.['prompt.md'], 'the Designer\'s turn dumped its package');
    const problems = designPackageProblems(J.designer, DESIGNER_ELEMENTS, { absent: ['designer.review', 'designer.retrofit'], facts: J.facts });
    const props = packageReads(J.designer).resultSchema?.properties ?? {};
    if (!props.findings) problems.push('result-schema.json: findings (B.12\'s Designer turn result)');
    assertNoGaps(problems, 'the Designer\'s package');
  });

  test('(a1) never another role\'s transcript: the Spec Writer\'s and the Architect\'s words are in no file of the Designer\'s package', () => {
    assert.ok(J.designer?.['prompt.md'], 'the Designer\'s turn dumped its package');
    const hits = [];
    for (const [name, text] of Object.entries(J.designer)) for (const words of OTHER_TRANSCRIPTS) if ((text ?? '').includes(words)) hits.push(`${name}: "${words}"`);
    assert.deepEqual(hits, [], 'no other role\'s transcript (D7 §3.4; D6 §3.5)');
  });

  test('(a2) the phase-authoring Verifier\'s package states the design catalogue; the correction\'s states it with the design criteria and their implemented paths', () => {
    assert.ok(J.authoring?.['prompt.md'], 'phase 1\'s authoring dumped its package');
    assert.ok(J.correction?.['prompt.md'], 'the design criteria\'s correction dumped its package');
    const criteria = [
      { id: DESIGN_CRITERIA_IDS.tokens, kind: 'tokens_only', targets: ['web'], paths: ['web/app.css', 'web/tokens.css'] },
      { id: DESIGN_CRITERIA_IDS.parityWeb, kind: 'asset_parity', targets: ['web'], paths: [WEB_LOGO_PATH], slot: 'logo', variant: 'full' },
      { id: DESIGN_CRITERIA_IDS.parityAndroid, kind: 'asset_parity', targets: ['android'], paths: [ANDROID_LOGO_PATH], slot: 'logo', variant: 'full' },
    ];
    const problems = [
      ...designPackageProblems(J.authoring, VERIFIER_DESIGN_ELEMENTS, { facts: { criteria: [] } }).map((s) => `check_authoring (before any design): ${s}`),
      ...designPackageProblems(J.correction, VERIFIER_DESIGN_ELEMENTS, { facts: { criteria } }).map((s) => `check_correction: ${s}`),
    ];
    assertNoGaps(problems, 'the Verifier packages\' design additions');
  });

  test('(a5) the registry lists every element id, each with the packages that carry it', async () => {
    const res = await J.fx.engine.get('/v1/harness/package-elements');
    assert.equal(res.status, 200, `GET /v1/harness/package-elements (SEAM.md §453) (→ ${res.status} ${res.text})`);
    const elements = res.body?.elements ?? [];
    const ids = elements.map((e) => e.id);
    assert.deepEqual(M6_ELEMENTS.filter((id) => !ids.includes(id)), [], `every M6 element id is in the registry (${JSON.stringify(ids)})`);
    const carried = (id) => elements.find((e) => e.id === id)?.packages ?? [];
    for (const id of DESIGNER_ELEMENTS) for (const pkg of ['designer', 'designer_review', 'designer_retrofit']) assert.ok(carried(id).includes(pkg), `${id} carried by ${pkg} (${JSON.stringify(carried(id))})`);
    assert.deepEqual(carried('designer.review'), ['designer_review'], 'designer.review by the review package only');
    assert.deepEqual(carried('designer.retrofit'), ['designer_retrofit'], 'designer.retrofit by the retrofit package only');
    for (const pkg of ['verifier_authoring', 'verifier_correction']) assert.ok(carried('verifier.design_catalogue').includes(pkg), `verifier.design_catalogue carried by ${pkg} (${JSON.stringify(carried('verifier.design_catalogue'))})`);
  });
});

describe('M537 (a3) the review-mode package of an owner-invoked review', () => {
  const shared = sharedFixture();
  const R = {};
  const BUILD = 'pantry-android 2.0.1 (51)';
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const d = await designedPantry(fx, { name: 'pantry-m537-review', policy: POLICY });
    await pump(fx, d.ctx, () => candidatesOfProject(fx.home, d.p.id).at(-1), { what: 'a candidate of the built stages', max: 120 });
    await waitForIdle(fx.home, d.p.id);
    const [png] = evidenceFiles(fx, { 'phone.png': evidenceBytes('png', { tag: 7 }) });
    const res = designReview(fx, d.p.id, { target: 'android', build: BUILD, observedOn: 'device', evidence: [png] });
    assert.equal(res.status, 0, `surety design review exits 0 (${res.stdout.slice(0, 400)} ${res.stderr.slice(0, 400)})`);
    const run = res.body?.run;
    R.evidence = (res.body?.evidence ?? []).map((e) => e.id ?? e);
    await driveReview(fx, d.p.id, run, [{ dump: true, say: 'Here is my phone.', reply: 'I see the screenshot.', save: false }], { close: null });
    R.pkg = texts(packageOfLaunch(fx, run.id, 0));
    Object.assign(R, { fx, p: d.p, facts: factsOf(fx, d.p, inventoryOf(d.p)) });
  });
  after(shared.cleanup);

  test('(a3) the base elements and designer.review: the build identifier verbatim and owner_reported, each evidence file owner_supplied, no engine observation', () => {
    assert.ok(R.pkg?.['prompt.md'], 'the review session\'s turn dumped its package');
    assert.equal(R.evidence.length, 1, `one evidence record (${JSON.stringify(R.evidence)})`);
    assertNoGaps(designPackageProblems(R.pkg, DESIGNER_REVIEW_ELEMENTS, { absent: ['designer.retrofit'], facts: { ...R.facts, review: { build_ref: BUILD, evidence: R.evidence } } }), 'the review-mode package');
  });
});

describe('M537 (a4) the retrofit-mode package (Shelf, adopted)', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const fx = await retrofitEngine(shared.context, { extraAuthoring: PAGE_CHECKS });
    const J = await toConformancePublished(fx, { policy: { design: 'before_build' }, answers: SHELF_ANSWERS, spec: SHELF_SPEC, architect: SHELF_ARCHITECT, repoOpts: { extra: SHELF_EXTRA } });
    assert.equal(J.architect.closeRes.status, 200, `the retrofit Architect's close is accepted (${J.architect.closeRes.text?.slice(0, 600)})`);
    assert.ok(conformancePlan(fx.home, J.p.id), 'the conformance plan published');
    const run = await openDesigner(fx, J.p.id);
    await driveReview(fx, J.p.id, run, [{ dump: true, say: 'Capture the design of the pages as they are.', reply: 'I have the pages.', save: false }], { close: null });
    S.pkg = texts(packageOfLaunch(fx, run.id, 0));
    const inventory = inventoryOf(J.p);
    S.facts = {
      inventory,
      digest: digestOf(fx.home, J.p.id) ?? inventory.inventory_digest,
      targets: (inventory.targets ?? []).map((t) => ({ module: t.module, target: t.target, ui_technology: t.ui_technology, preview_capability: t.preview_capability, layouts: t.layouts })),
      sourcePaths: Object.keys(S.pkg ?? {}).filter((n) => n.startsWith('design/source/')).map((n) => n.slice('design/source/'.length)).sort(),
    };
  });
  after(shared.cleanup);

  test('(a4) the base elements and designer.retrofit: origin observed, the UI source it reads', () => {
    assert.ok(S.pkg?.['prompt.md'], 'the retrofit Designer\'s turn dumped its package');
    assert.ok(S.facts.sourcePaths.length > 0, `the package carries the UI source (SEAM.md §523) (${JSON.stringify(Object.keys(S.pkg ?? {}))})`);
    assertNoGaps(designPackageProblems(S.pkg, DESIGNER_RETROFIT_ELEMENTS, { absent: ['designer.review'], facts: S.facts }), 'the retrofit-mode package');
  });
});
