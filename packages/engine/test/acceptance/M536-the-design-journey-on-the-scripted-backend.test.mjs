// M536, the design journey on the scripted backend (slice 40; project lane,
// run with `npm test` like the sandbox lane). M6 plan §3.2 M536; D7 §1,
// §§3 to 11; E40; BS6 §4.1 rules 20 to 26; SEAM.md §§480 to 489.
//
// The reference project "Pantry" (BS6 §8; `harness/design/reference.mjs`):
// `**Targets:** web, android`, `**Cross-platform:** yes`, an `api` module
// and two `ui` modules (web `html_css`, `android` `react_native`), one phase
// of three stages, `design: both`, `autonomy: phase`, `alpha_deploy:
// on_phase_complete`; real `role` and `check` domains, the check runner
// self-tested at every start, the classifier authoritative (as M401); the
// adapter qualified by `surety qualify-adapter` in the test's home and
// `alpha` configured by the owner. The harness answers every human act
// through the owner's production routes or the `surety` CLI in the test's
// home, and installs no design, effective asset row, binding, readiness or
// verdict by fixture (rule 20): every one of them is the engine's, reached
// by the production paths.
//
// The cases run in order, each one step of D7 §1, each asserting its clause
// of the row; a step that cannot run because an earlier one failed says so
// and fails. After each step: every design-held stage accounted for by an
// open owner question, an owner-opened active Designer session, pending
// engine work or an unexpired owner deferral, the reads naming the cause and
// the next action (D7 §11 as corrected; rule 25; E162 item 1;
// `assertHoldsAccounted`, SEAM.md §547).
//
// SAFETY (BS6 §4.1; E64; SEAM.md §§257, 356, 488). The units are the
// engine's own under this test home's prefix: the preview's
// `surety-<h>-<env id>-g<n>.service` (`<env id>` the project's reserved
// `design-preview` row's, as D4 §9.3 names every unit; objection 135,
// decided) and Alpha's, both under the guard's `env_` pattern; the test
// starts and stops them only through the engine's commands, reads them by exact name,
// and acts on no unit itself; it signals nothing but its own engine (the
// verified kill). The relay is opened by the test's own command on
// 127.0.0.1 and closed by the case that opened it (rule 24). Nothing the
// Designer wrote is executed by the test: mockups are read as bytes over
// HTTP (rules 21, 22). The first run that deploys the preview on a real
// unit is the driver's to start (rule 23). The file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { assertOwnUnit, operatorGuard, serviceOf, unitShow } from './harness/deploy/host.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  alphaDeployed,
  candidatesOfProject,
  deploymentRequests,
  eventsAbout,
  executionsOf,
  journeyContext,
  phaseCompleted,
  planOfPhase,
  pump,
  readPace,
  paceLeaves,
  requirementsOf,
  resultsOf,
  specRevisions,
  architectureRevisions,
  visionSession,
  workOf,
} from './harness/journey/drive.mjs';
import { alphaByCommand, endJourney, journeyEngine } from './harness/journey/project.mjs';
import { changedPaths, fileAt } from './harness/repos.mjs';
import { closeSession, ledgerRowsOf, saveSession, sayAndSettle, scriptTurns, transcriptEntries } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { previewCgroups, previewEnvRow, previewUnitName, previewUnits } from './harness/design/preview42.mjs';
import { semanticsOf } from './harness/journey/spec34.mjs';
import {
  DESIGN,
  DESIGN_CHECKS,
  FIRST_SAVE_DEFECT,
  HUMAN_TEST_KEYS,
  IDEA_RECORD,
  INVENTORY_PATH,
  LOGO_SVG,
  MANIFEST_PATH,
  PARITY_CHECKS,
  REVIEW_PATH,
  WEB_LOGO_PATH,
  ANDROID_LOGO_PATH,
  ANDROID_MOCKUP_PATH,
  WEB_MOCKUP_PATH,
  reviewFile,
  sha256hex,
} from './harness/design/reference.mjs';
import {
  DESIGN_POLICY,
  answerWith,
  assertHoldsAccounted,
  assetBindings,
  batchOf,
  cli,
  createPantry,
  designDecisions,
  designEvents,
  designRevisions,
  designScripts,
  designerSession,
  dumpedPackage,
  effectiveAssets,
  getBytes,
  inventoryOf,
  journeyDesignerTurns,
  manifestOf,
  openDesignDue,
  openDesigner,
  openOfKind,
  pantryArchitect,
  pantrySpec,
  readDesign,
  revisionsOfKind,
  scriptBuilders,
  stageRow,
  stageWork,
  workItems,
} from './harness/design/drive.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const parse = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);
const LOGO_DIGEST = sha256hex(LOGO_SVG);
// The kinds the owner answers inside the build on the project lane (as M401: under
// `classifier_authority: authoritative` a tightening is the Reviewer's). The
// design's decisions and the batched spec change are answered by the steps, never by the pump.
const BUILD_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']);
// The preview's unit is named from its reserved environment's id (objection 135; SEAM.md §§488, 499).
const previewUnitsOf = (home, project) => {
  const env = previewEnvRow(home, project);
  return env ? previewUnits(home, env.id) : [];
};

describe('M536 the design journey on the scripted backend, a real preview unit and a real Alpha unit (project lane)', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  let stopped = null;
  // Each step in order; a step after a failed one fails naming it.
  const step = (name, fn) =>
    test(name, async () => {
      assert.equal(stopped, null, `the journey did not reach this step: it stopped at ${stopped}`);
      try {
        await fn();
      } catch (err) {
        stopped = name.slice(0, 3);
        throw err;
      }
    });

  before(async () => {
    guard = operatorGuard();
    J.fx = await journeyEngine(shared.context, guard, { lane: 'project' });
    designScripts(J.fx);
  });
  after(async () => {
    try {
      const { fx, p } = J;
      if (fx && p) {
        if (J.relayOpen) cli(fx, ['env', 'close', 'design-preview', '--project', p.id]);
        // Units unread (null) are not none: the engine's --stop is asked then too.
        const left = (() => {
          try {
            return previewUnitsOf(fx.home, p.id);
          } catch {
            return null;
          }
        })();
        if (left === null || left.length > 0) cli(fx, ['design', 'preview', '--stop', '--project', p.id]);
        if (J.env && !J.afterTeardown) J.afterTeardown = await endJourney(fx, p.id, J.env);
      }
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  step('(a) create, the Vision, Spec Writer and Architect sessions and their approvals: the spec\'s targets in spec_semantics, the module map\'s surfaces, technologies and shapes on architecture_revisions 1', async () => {
    const { fx } = J;
    const p = await createPantry(fx, { policy: DESIGN_POLICY });
    J.p = p;
    J.ctx = journeyContext(fx, p, { lane: 'project', tier: 'T2' });
    J.ctx.answerKinds = [...BUILD_KINDS];
    J.vision = await visionSession(fx, p.id, { record: IDEA_RECORD, firstTurn: undefined });
    J.spec = await pantrySpec(fx, p.id);
    J.arch = await pantryArchitect(fx, p.id, p.repo);
    assert.equal(J.arch.closeRes.status, 200, `the Architect's close is accepted (${J.arch.closeRes.status} ${J.arch.closeRes.text?.slice(0, 600)}; findings ${JSON.stringify(J.arch.saved?.findings)})`);
    assert.equal(eventsAbout(fx.home, 'project.created', p.id).length, 1, 'project.created');
    const [v1] = specRevisions(fx.home, p.id);
    assert.ok(v1, 'spec_revisions 1');
    const sem = semanticsOf(fx.home, J.spec.run.id).find((s) => s.semantic_digest === v1.semantic_digest) ?? semanticsOf(fx.home, J.spec.run.id).at(-1);
    assert.deepEqual([sem?.representation?.targets, sem?.representation?.cross_platform], [['web', 'android'], true], `the spec's targets and cross-platform in spec_semantics (G3; SEAM.md §481) (${JSON.stringify(sem?.representation)?.slice(0, 400)})`);
    const [a1] = architectureRevisions(fx.home, p.id);
    const map = parse(a1?.module_map);
    const mod = (name) => (map?.modules ?? []).find((m) => m.name === name);
    assert.deepEqual(['api', 'web', 'mobile'].map((m) => mod(m)?.surface), ['api', 'ui', 'ui'], 'surfaces on architecture_revisions 1');
    assert.deepEqual(mod('web')?.targets, [{ target: 'web', ui_technology: 'html_css' }], 'web under html_css');
    assert.deepEqual(mod('mobile')?.targets, [{ target: 'android', ui_technology: 'react_native', form_factors: ['phone'] }], 'android under react_native, its form factor');
    const add = (mod('api')?.interfaces ?? []).find((i) => i.name === 'add-item');
    assert.deepEqual([add?.request?.properties?.quantity?.unit, add?.errors?.map((e) => e.code), add?.consumed_by], ['pcs', ['name_taken', 'invalid_item'], ['web', 'mobile']], 'shapes, errors and consumers recorded');
  });

  step('(b) publication: one design.inventory_derived; inventory.json, its fixtures and a placeholder for every default slot and variant committed as one engine intent revision before any Designer session; design_due raised naming both UI stages', async () => {
    const { fx, p } = J;
    J.plan = planOfPhase(fx.home, p.id, 1).at(-1);
    assert.ok(J.plan?.published_at, 'phase 1 published');
    J.stage = { api: stageRow(fx.home, p.id, 1), web: stageRow(fx.home, p.id, 2), mobile: stageRow(fx.home, p.id, 3) };
    assert.equal(designEvents(fx.home, 'design.inventory_derived', p.id).length, 1, 'one design.inventory_derived');
    const inventory = inventoryOf(p);
    const manifest = manifestOf(p);
    J.inventory = inventory;
    J.placeholderManifest = manifest;
    // The one engine intent revision that committed them (no run made it).
    const intents = revisionsOfKind(fx.home, p.id, 'intent').filter((r) => r.created_by_run === null);
    const carrying = intents.filter((r) => r.parent_sha && changedPaths(p.repo.path, r.parent_sha, r.sha)[INVENTORY_PATH]);
    assert.equal(carrying.length, 1, `one engine intent revision commits the inventory (${JSON.stringify(intents.map((r) => r.sha))})`);
    const changed = changedPaths(p.repo.path, carrying[0].parent_sha, carrying[0].sha);
    const fixtures = (inventory.fixtures ?? []).map((f) => (f.path.startsWith(DESIGN) ? f.path : `${DESIGN}${f.path}`));
    assert.ok(fixtures.length > 0, 'the inventory lists its fixtures');
    for (const f of fixtures) assert.ok(changed[f], `${f} committed in it`);
    assert.ok(changed[MANIFEST_PATH], 'the asset manifest committed in it');
    for (const t of inventory.targets) {
      for (const s of t.required_slots) {
        const slot = manifest.slots.find((x) => x.kind === s.kind && x.platforms.includes(t.target));
        assert.ok(slot, `a ${s.kind} slot for ${t.target} (D7 §6.2)`);
        assert.deepEqual([slot.status, slot.provenance], ['placeholder', 'engine_placeholder'], `${slot.key}: an engine placeholder`);
        for (const v of s.variants) {
          const variant = slot.variants.find((x) => x.name === v);
          assert.ok(variant?.file, `${slot.key} ${v}: a placeholder file`);
          assert.ok(changed[`${DESIGN}${variant.file}`], `${slot.key} ${v}: committed in the same revision`);
        }
      }
    }
    const firstDesigner = rows(fx.home, 'SELECT MIN(rowid) AS r FROM "runs" WHERE "project" = ? AND "role" = \'designer\'', p.id)[0]?.r ?? null;
    assert.equal(firstDesigner, null, 'no Designer session before it');
    const due = openDesignDue(fx.home, p.id);
    assert.ok(due, 'design_due raised');
    assert.equal(due.evidence?.stage, 'before_build');
    assert.deepEqual([...(due.evidence?.held_stages ?? [])].sort(), [J.stage.web.id, J.stage.mobile.id].sort(), `naming both UI stages (${JSON.stringify(due.evidence)})`);
    assert.match(due.evidence?.command ?? '', /surety session open designer/, 'and the exact command');
    await assertHoldsAccounted(fx, p.id, '(b)');
  });

  step('(c) check authoring; the API stage verified while both UI stages\' work is held design_pending with recorded intervals', async () => {
    const { fx, p, ctx } = J;
    J.alpha = await alphaByCommand(fx, ctx);
    J.env = J.alpha.env;
    scriptBuilders(fx, p.id, { dump: [1, 2, 3] });
    await pump(fx, ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'the API stage to be verified' });
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      assert.equal(w?.held, 'design_pending', `stage ${n}'s stage_build held design_pending (${JSON.stringify(w && { status: w.status, held: w.held })})`);
      assert.ok(w.held_intervals.some((i) => i.reason === 'design_pending'), `with a recorded interval (${JSON.stringify(w.held_intervals)})`);
      assert.deepEqual(fx.scripted.launches({ work_item: w.id }), [], `no Builder launched for stage ${n}`);
    }
    await assertHoldsAccounted(fx, p.id, '(c)');
  });

  step('(d) a Designer session of three turns: the first save refused by the design check, the reason the next turn\'s engine entry; a corrected save; surety design preview of the checkpoint on surety-<h>-<env id>-g1.service, two identity reads, no alpha_authorize; the relay opened and the preview read; --stop leaves nothing', async () => {
    const { fx, p } = J;
    const authorizationsBefore = rows(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations"')[0].n;
    const alphaAuthorizeBefore = rows(fx.home, 'SELECT COUNT(*) AS n FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = \'alpha_authorize\'', p.id)[0].n;
    const s = await designerSession(fx, p.id, journeyDesignerTurns(p, { defect: FIRST_SAVE_DEFECT }), { close: null });
    J.designer = s;
    assert.equal(rows(fx.home, 'SELECT COUNT(*) AS n FROM "runs" WHERE "project" = ? AND "kind" = \'session\' AND "role" = \'designer\'', p.id)[0].n, 1, 'one session run of role designer');
    assert.equal(ledgerRowsOf(fx.home, p.id, s.run.id).length, 3, 'three ledger rows');
    const [save1, save2] = s.saves;
    assert.equal(save1?.status, 200, `the first save is committed as a checkpoint (${save1?.status} ${save1?.text?.slice(0, 300)})`);
    assert.equal(save1.body?.design_check?.outcome, 'refused', `and refused by the design check (SEAM.md §483) (${save1.text?.slice(0, 600)})`);
    const reason = (save1.body.design_check.reasons ?? []).find((r) => r.code === FIRST_SAVE_DEFECT.reason);
    assert.ok(reason && JSON.stringify(reason.subjects).includes('"web"') && JSON.stringify(reason.subjects).includes(FIRST_SAVE_DEFECT.state), `naming ${FIRST_SAVE_DEFECT.reason}, its target and the obligation (${JSON.stringify(save1.body.design_check.reasons)})`);
    const entries = transcriptEntries(fx.home, s.run.id).filter((e) => e.speaker === 'engine' && e.turn === 2);
    assert.ok(entries.some((e) => (e.text ?? '').includes(FIRST_SAVE_DEFECT.reason) && (e.text ?? '').includes('web')), `the refusal the next turn's engine entry (${JSON.stringify(entries)})`);
    assert.equal(save2?.body?.design_check?.outcome, 'passed', `the corrected save passes (${save2?.text?.slice(0, 600)})`);
    assert.equal(designEvents(fx.home, 'design.checked', p.id).length >= 2, true, 'design.checked at each save');

    // The preview of the checkpoint, by the owner's command.
    const preview = cli(fx, ['design', 'preview', '--project', p.id, '--revision', 'checkpoint']);
    assert.equal(preview.status, 0, `surety design preview exits 0 (stdout ${preview.stdout.slice(0, 400)}; stderr ${preview.stderr.slice(0, 400)})`);
    const url = preview.body?.preview?.url;
    assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/, `the URL printed (SEAM.md §488) (${preview.stdout.slice(0, 400)})`);
    const deployed = await pump(fx, J.ctx, () => designEvents(fx.home, 'design.preview_deployed', p.id).at(-1), { what: 'the preview to be deployed', projectMs: 300_000 });
    J.previewEnv = previewEnvRow(fx.home, p.id);
    assert.ok(J.previewEnv, 'the reserved environment design-preview, a row of the project (SEAM.md §499)');
    const unit = previewUnitName(fx.home, J.previewEnv.id, 1);
    assertOwnUnit(fx.home, unit, 'the preview\'s unit');
    assert.deepEqual(previewUnits(fx.home, J.previewEnv.id).map((u) => u.unit), [unit], 'the preview\'s unit by exact name');
    const shown = unitShow(unit, ['LoadState', 'ActiveState']);
    assert.deepEqual([shown?.LoadState, shown?.ActiveState], ['loaded', 'active'], `read from the host by exact name (${JSON.stringify(shown)})`);
    assert.equal(deployed.payload?.unit, unit, 'the event names the unit');
    assert.equal((deployed.payload?.identity_reads ?? []).filter((r) => r.match === 'match').length, 2, `verified by its two identity reads (${JSON.stringify(deployed.payload)})`);
    assert.equal(rows(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations"')[0].n, authorizationsBefore, 'no authorization');
    assert.equal(rows(fx.home, 'SELECT COUNT(*) AS n FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = \'alpha_authorize\'', p.id)[0].n, alphaAuthorizeBefore, 'no alpha_authorize');
    const relay = cli(fx, ['env', 'open', 'design-preview', '--project', p.id]);
    assert.equal(relay.status, 0, `surety env open design-preview exits 0 (${relay.stdout.slice(0, 300)} ${relay.stderr.slice(0, 300)})`);
    J.relayOpen = true;
    try {
      const checkpoint = s.saves[1]?.body?.revision;
      const blob = (path) => Buffer.from(fileAt(p.repo.path, checkpoint ?? p.repo.ref, `${DESIGN}${path}`), 'utf8');
      const index = await getBytes(url);
      assert.equal(index.status, 200, 'the index');
      const indexText = index.bytes.toString('utf8');
      for (const [path, capability] of [[WEB_MOCKUP_PATH, 'native'], [ANDROID_MOCKUP_PATH, 'simulated']]) assert.ok(indexText.includes(path) && indexText.includes(capability), `the index lists ${path} with its capability ${capability}`);
      const web = await getBytes(new URL(WEB_MOCKUP_PATH, url));
      assert.equal(web.status, 200);
      assert.ok(web.bytes.equals(blob(WEB_MOCKUP_PATH)), 'the web mockup\'s bytes equal the tree\'s');
      const android = await getBytes(new URL(ANDROID_MOCKUP_PATH, url));
      assert.equal(android.status, 200);
      assert.ok(!android.bytes.equals(blob(ANDROID_MOCKUP_PATH)), 'the android mockup\'s path is never answered with its bytes bare');
      const frame = android.bytes.toString('utf8');
      assert.match(frame, /Simulation of android/, 'answered with the engine\'s frame and its label (D7 §5.7)');
      assert.match(frame, /<iframe[^>]*\ssandbox="allow-scripts"/, 'around an iframe that allows scripts and not same origin');
    } finally {
      const closed = cli(fx, ['env', 'close', 'design-preview', '--project', p.id]);
      J.relayOpen = closed.status !== 0;
    }
    const stop = cli(fx, ['design', 'preview', '--stop', '--project', p.id]);
    assert.equal(stop.status, 0, `surety design preview --stop exits 0 (${stop.stdout.slice(0, 300)} ${stop.stderr.slice(0, 300)})`);
    await pump(fx, J.ctx, () => (designEvents(fx.home, 'design.preview_torn_down', p.id).length > 0 && previewUnits(fx.home, J.previewEnv.id).length === 0 ? true : undefined), { what: 'the preview to be torn down', projectMs: 300_000 });
    assert.deepEqual(previewUnits(fx.home, J.previewEnv.id), [], 'no unit of the preview left');
    assert.deepEqual(previewCgroups(fx.home, J.previewEnv.id), [], 'no cgroup of the preview left');
    await assertHoldsAccounted(fx, p.id, '(d)');
  });

  step('(e) close and the batch: a Spec Writer one-shot writes the diff on its side ref; design_approval and spec_change (source design) under one batch_key; answered approve with the logo held; design_revisions 1 current against the spec version the change created; the logo still proposed; the effective logo the placeholder', async () => {
    const { fx, p, ctx } = J;
    const closed = await closeSession(fx, p.id, J.designer.run.id);
    J.closed = closed;
    const batch = await pump(fx, ctx, () => {
      const b = batchOf(fx.home, p.id);
      return b?.spec_change ? b : undefined;
    }, { what: 'the batch to be raised', projectMs: 600_000 });
    const writer = runsOfRole(fx.home, p.id, 'spec_writer').filter((r) => r.kind !== 'session');
    assert.ok(writer.some((r) => r.outcome === 'completed'), `a Spec Writer one-shot change run (${JSON.stringify(writer.map((r) => [r.kind, r.outcome]))})`);
    assert.equal(batch.spec_change.batch_key, batch.batch_key, 'one batch_key');
    const request = rows(fx.home, 'SELECT * FROM "spec_change_requests" WHERE "id" = ?', batch.spec_change.subject_id)[0];
    assert.equal(request?.source, 'design', `the change request's source is design (${JSON.stringify(request)})`);
    for (const n of [2, 3]) assert.deepEqual(fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }), [], 'nothing else launched');
    J.batch = batch;
    const held = await answerWith(fx, p.id, batch.design_approval, 'approve', { assets_held: ['logo'] });
    assert.equal(held.status, 200, `design_approval answered approve with the logo held (${held.text})`);
    const change = await answerWith(fx, p.id, batch.spec_change, 'approve');
    assert.equal(change.status, 200, `spec_change answered approve (${change.text})`);
    const v2 = await pump(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2', projectMs: 300_000 });
    const [d1] = designRevisions(fx.home, p.id);
    assert.deepEqual([d1?.version, d1?.status, d1?.current_against_spec], [1, 'approved', v2.id], `design_revisions 1 approved, current against version 2 (${JSON.stringify(d1)})`);
    const logo = manifestOf(p).slots.find((s) => s.kind === 'logo');
    assert.equal(logo.status, 'proposed', 'the logo slot still proposed');
    const row = rows(fx.home, 'SELECT * FROM "design_assets" WHERE "design_revision" = ? AND "slot" = ?', d1.id, logo.key)[0];
    assert.equal(row?.held, 1, 'and held');
    const eff = effectiveAssets(fx.home, p.id).find((e) => e.slot === logo.key && e.variant === 'full');
    const placeholder = J.placeholderManifest.slots.find((s) => s.kind === 'logo');
    assert.deepEqual([eff?.source, eff?.slot_version, eff?.digest], ['placeholder', placeholder.slot_version, placeholder.variants.find((v) => v.name === 'full').digest], `the effective logo the placeholder (${JSON.stringify(eff)})`);
    await assertHoldsAccounted(fx, p.id, '(e)');
  });

  step('(f) the spec change\'s effect: version 2 with the design criteria and two human-test requirements; the check correction applied; design_ready_at set, design.ready, the UI stages\' work.dependency_met; no UI Builder launched before', async () => {
    const { fx, p, ctx } = J;
    const ready = await pump(fx, ctx, () => designRevisions(fx.home, p.id)[0]?.ready_at ?? undefined, { what: 'the design to be ready', projectMs: 900_000 });
    J.readyAt = ready;
    const reqs = requirementsOf(fx.home, p.id);
    const crit = (key) => (reqs.find((r) => r.key === key)?.criteria ?? []).map((c) => (typeof c === 'string' ? c : c.id));
    assert.ok(crit('R2').includes('R2.2') && crit('R2').includes('R2.3') && crit('R3').includes('R3.2'), `the design criteria in version 2 (${JSON.stringify(reqs.map((r) => [r.key, crit(r.key)]))})`);
    for (const key of Object.values(HUMAN_TEST_KEYS)) assert.ok(reqs.some((r) => r.key === key), `the human-test requirement ${key}`);
    const corrections = workOf(fx.home, p.id, 'check_correction');
    assert.ok(corrections.length >= 1 && corrections.every((w) => w.status === 'complete'), `check_correction done (${JSON.stringify(corrections.map((w) => w.status))})`);
    const keys = rows(fx.home, 'SELECT c."key" FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version" WHERE c."project" = ? ORDER BY v."seq" DESC', p.id).map((r) => r.key);
    for (const k of DESIGN_CHECKS) assert.ok(keys.includes(k), `${k} in the applied protected version`);
    assert.equal(designEvents(fx.home, 'design.ready', p.id).length, 1, 'design.ready');
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      assert.ok(eventsAbout(fx.home, 'work.dependency_met', p.id).some((e) => e.subject?.work_item === w.id), `stage ${n}'s work.dependency_met`);
      const early = fx.scripted.launches({ work_item: w.id }).filter((l) => Date.parse(l.at) < Date.parse(ready));
      assert.deepEqual(early, [], `no stage ${n} Builder launched before readiness`);
    }
    await assertHoldsAccounted(fx, p.id, '(f)');
  });

  step('(g) the two UI stages built: each UI Builder\'s package holds its target\'s screens and the effective set, the held proposal\'s digest in no Builder package and no check\'s asset inputs; bindings validated and recorded; the design checks engine-run on the candidates', async () => {
    const { fx, p, ctx } = J;
    await pump(fx, ctx, () => ([2, 3].every((n) => stageRow(fx.home, p.id, n)?.status === 'verified') ? true : undefined), { what: 'both UI stages to be verified', projectMs: 1_200_000 });
    for (const [n, target, screen] of [[2, 'web', 'S1'], [3, 'android', 'S2']]) {
      const w = stageWork(fx.home, p.id, n);
      const launch = fx.scripted.launches({ work_item: w.id })[0];
      const pkg = dumpedPackage(fx, launch.run, 0);
      assert.ok(pkg, `stage ${n}'s Builder dumped its package`);
      const screens = parse(pkg['design/screens.json']?.text);
      assert.deepEqual((screens?.screens ?? []).map((s) => [s.key, s.target]), [[screen, target]], `stage ${n}: its target's screens only (SEAM.md §482)`);
      const eff = parse(pkg['design/effective-assets.json']?.text) ?? [];
      const logo = eff.find((e) => e.variant === 'full' && String(e.slot).length > 0 && J.placeholderManifest.slots.some((s) => s.key === e.slot && s.kind === 'logo'));
      assert.equal(logo?.source, 'placeholder', `stage ${n}: the effective logo is the placeholder (${JSON.stringify(eff)})`);
      for (const [name, f] of Object.entries(pkg)) {
        assert.notEqual(f.sha256, LOGO_DIGEST, `stage ${n}: the held proposal is not in the package (${name})`);
        assert.ok(!(f.text ?? '').includes(LOGO_DIGEST), `stage ${n}: nor its digest (${name})`);
      }
    }
    const bindings = assetBindings(fx.home, p.id);
    for (const [stage, target, path] of [[J.stage.web.id, 'web', WEB_LOGO_PATH], [J.stage.mobile.id, 'android', ANDROID_LOGO_PATH]]) {
      const b = bindings.find((x) => x.stage === stage && x.path === path);
      assert.ok(b, `stage ${target}'s binding recorded (${JSON.stringify(bindings)})`);
      assert.deepEqual([b.target, b.variant, b.form, b.declared_by], [target, 'full', 'copy', 'builder']);
    }
    assert.ok(designEvents(fx.home, 'design.asset_bound', p.id).length >= 2, 'design.asset_bound');
    for (const k of DESIGN_CHECKS) {
      const rs = resultsOfKey(fx.home, p.id, k);
      assert.ok(rs.length > 0 && rs.every((r) => r.runner_qualification), `${k}: engine-run on the candidates (${rs.length} results)`);
    }
    for (const k of PARITY_CHECKS) for (const r of resultsOfKey(fx.home, p.id, k)) assert.ok(!JSON.stringify(parse(r.asset_inputs) ?? []).includes(LOGO_DIGEST), `${k}: no check read the held proposal`);
    await assertHoldsAccounted(fx, p.id, '(g)');
  });

  step('(h) the held logo approved by surety design assets submit: the effective set moved to its slot@version; one asset_updated fix naming the old and new versions and the bound paths, integrated; asset_version_changed obligations; the parity checks passing with the new slot@version', async () => {
    const { fx, p, ctx } = J;
    const submit = cli(fx, ['design', 'assets', 'submit', '--project', p.id]);
    assert.equal(submit.status, 0, `surety design assets submit exits 0 (${submit.stdout.slice(0, 300)} ${submit.stderr.slice(0, 300)})`);
    const approval = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').at(-1), { what: 'the asset-only design_approval', projectMs: 300_000 });
    assert.equal(approval.batch_key ? rows(fx.home, 'SELECT COUNT(*) AS n FROM "decisions" WHERE "batch_key" = ? AND "kind" = \'spec_change\'', approval.batch_key)[0].n : 0, 0, 'with no consolidated spec change');
    const res = await answerWith(fx, p.id, approval, 'approve');
    assert.equal(res.status, 200, `approved (${res.text})`);
    const logoKey = J.placeholderManifest.slots.find((s) => s.kind === 'logo').key;
    const eff = await pump(fx, ctx, () => effectiveAssets(fx.home, p.id).find((e) => e.slot === logoKey && e.variant === 'full' && e.source === 'approved'), { what: 'the logo to be effective', projectMs: 300_000 });
    assert.equal(eff.digest, LOGO_DIGEST, 'the effective logo is the approved proposal');
    assert.ok(designEvents(fx.home, 'design.assets_approved', p.id).length >= 1, 'design.assets_approved');
    const fixes = workItems(fx.home, p.id, 'fix').filter((w) => w.subject?.cause === 'asset_updated');
    assert.equal(fixes.length, 1, `one asset_updated fix (${JSON.stringify(fixes.map((w) => w.subject))})`);
    const [fix] = fixes;
    const placeholderVersion = J.placeholderManifest.slots.find((s) => s.kind === 'logo').slot_version;
    assert.deepEqual([fix.subject.slot, fix.subject.from_version, fix.subject.to_version], [logoKey, `${logoKey}@${placeholderVersion}`, `${logoKey}@${eff.slot_version}`], `naming the old and new slot@version (${JSON.stringify(fix.subject)})`);
    assert.deepEqual((fix.subject.bindings ?? []).map((b) => b.path).sort(), [ANDROID_LOGO_PATH, WEB_LOGO_PATH].sort(), 'and every bound path');
    const integrated = await pump(fx, ctx, () => (workItems(fx.home, p.id, 'fix').find((w) => w.id === fix.id)?.status === 'complete' ? true : undefined), { what: 'the asset_updated fix to be integrated', projectMs: 900_000 });
    assert.ok(integrated);
    const obligations = rows(fx.home, 'SELECT * FROM "check_obligations" WHERE "project" = ? AND "reason" = \'asset_version_changed\'', p.id);
    assert.deepEqual([...new Set(obligations.map((o) => o.key))].sort(), [...PARITY_CHECKS].sort(), `asset_version_changed for every check reading the slot (${JSON.stringify(obligations.map((o) => o.key))})`);
    const fixCandidate = candidatesOfProject(fx.home, p.id).at(-1);
    J.fixCandidate = fixCandidate;
    await pump(fx, ctx, () => (PARITY_CHECKS.every((k) => resultsOfKey(fx.home, p.id, k).some((r) => r.candidate === fixCandidate.id && r.exit_status === 0)) ? true : undefined), { what: 'the parity checks on the asset_updated candidate', projectMs: 900_000 });
    for (const k of PARITY_CHECKS) {
      const r = resultsOfKey(fx.home, p.id, k).find((x) => x.candidate === fixCandidate.id && x.exit_status === 0);
      assert.deepEqual(parse(r.asset_inputs), [{ slot: logoKey, variant: 'full', slot_version: eff.slot_version }], `${k} passed with the new slot@version on its result (G14) (${r.asset_inputs})`);
    }
    await assertHoldsAccounted(fx, p.id, '(h)');
  });

  step('(i) the phase gate and Alpha under policy: the phase complete once; one deployment_requests row requested_by policy; alpha_deployed on a real unit read by exact name', async () => {
    const { fx, p, ctx } = J;
    J.phase1 = await phaseCompleted(fx, ctx, 1, { projectMs: 1_200_000 });
    J.deployed = await alphaDeployed(fx, ctx, { newest: true, projectMs: 900_000 });
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', p.id).length, 1, 'the phase complete once');
    assert.equal(J.phase1.completion_binding.candidate, J.deployed.id, 'on the candidate deployed');
    assert.ok(candidatesOfProject(fx.home, p.id).findIndex((c) => c.id === J.deployed.id) >= candidatesOfProject(fx.home, p.id).findIndex((c) => c.id === J.fixCandidate.id), 'which carries the asset_updated work');
    const requests = deploymentRequests(fx.home, p.id).filter((r) => r.requested_by === 'policy');
    assert.equal(requests.length, 1, 'one request by policy');
    const op = rows(fx.home, 'SELECT * FROM "operations" WHERE "project" = ? AND "kind" = \'deploy\' ORDER BY "seq"', p.id).at(-1);
    const svc = serviceOf(ctx, J.env, op);
    const shown = unitShow(svc.unit, ['LoadState', 'ActiveState']);
    assert.deepEqual([shown?.LoadState, shown?.ActiveState], ['loaded', 'active'], `alpha_deployed on a real unit read by exact name (${svc.unit})`);
  });

  step('(j) the review at Alpha: design_due stage alpha_review; a review-mode session whose package holds the engine\'s observed records of the web route; verdicts proposed; design_verdicts answered confirm; the web human test owner-accepted, android not_observed no_native_runtime and pending', async () => {
    const { fx, p, ctx } = J;
    const due = await pump(fx, ctx, () => {
      const d = openDesignDue(fx.home, p.id);
      return d?.evidence?.stage === 'alpha_review' ? d : undefined;
    }, { what: 'design_due (alpha_review)', projectMs: 600_000 });
    assert.ok(due, 'design_due stage alpha_review');
    const run = await openDesigner(fx, p.id, { mode: 'review' });
    scriptTurns(fx, run.id, [{ steps: [{ probe: { action: 'context_dump' } }, { result: { status: 'completed', summary: 'read', reply: 'I have the observations.', artifact_changed: false } }] }]);
    await sayAndSettle(fx, p.id, run.id, 'Review the Alpha against the approved design.');
    const pkg = dumpedPackage(fx, run.id, 0);
    const observations = parse(pkg?.['design/observations.json']?.text)?.observations ?? [];
    const s1 = observations.find((o) => o.screen === 'S1' && o.target === 'web');
    assert.ok(s1 && s1.provenance === 'engine_observed' && s1.route === '/' && s1.status === 200, `the package holds the engine's observation of S1's route (SEAM.md §489) (${JSON.stringify(observations)})`);
    assert.ok(recordsOf(fx.home, 'design_observation').some((r) => r.id === s1.record), 'recorded as a design_observation record');
    const review = reviewFile({ candidate: J.deployed.id, webEvidence: [s1.evidence] });
    scriptTurns(fx, run.id, [
      { steps: [{ probe: { action: 'context_dump' } }, { result: { status: 'completed', summary: 'read', reply: 'I have the observations.', artifact_changed: false } }] },
      { steps: [{ write: { path: REVIEW_PATH, content: review } }, { result: { status: 'completed', summary: 'review', reply: 'S1 matches; S2 cannot be observed.', artifact_changed: true, done: true } }] },
    ]);
    await sayAndSettle(fx, p.id, run.id, 'The web page matches. Write the review.');
    await saveSession(fx, p.id, run.id);
    await closeSession(fx, p.id, run.id);
    const [rev] = await pump(fx, ctx, () => (designReviewsOf(fx.home, p.id).length > 0 ? designReviewsOf(fx.home, p.id) : undefined), { what: 'the review recorded', projectMs: 300_000 });
    assert.ok(designEvents(fx.home, 'design.review_recorded', p.id).length >= 1, 'design.review_recorded');
    assert.ok(rev.verdicts.every((v) => v.status === 'proposed'), `every verdict proposed (${JSON.stringify(rev.verdicts)})`);
    const android = rev.verdicts.find((v) => v.target === 'android');
    assert.deepEqual([android?.verdict, android?.not_observed_reason], ['not_observed', 'no_native_runtime']);
    const verdicts = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_verdicts').at(-1), { what: 'design_verdicts', projectMs: 300_000 });
    const confirmed = await answerWith(fx, p.id, verdicts, 'confirm');
    assert.equal(confirmed.status, 200, `design_verdicts answered confirm (${confirmed.text})`);
    const after_ = designReviewsOf(fx.home, p.id).at(-1);
    assert.equal(after_.verdicts.find((v) => v.target === 'web')?.status, 'confirmed', 'the web verdict confirmed');
    const design = await readDesign(fx, p.id);
    const ht = (target) => (design.human_tests ?? []).find((h) => h.target === target);
    assert.equal(ht('web')?.status, 'owner_accepted', `the web human test carries the owner's confirmed verdict (${JSON.stringify(design.human_tests)})`);
    assert.equal(ht('android')?.status, 'pending', 'the android human test pending');
  });

  step('(k) the pace read: BS6 §10\'s design figures present or unknown with their reasons', async () => {
    const { fx, p } = J;
    const pace = await readPace(fx, p.id);
    assert.ok(pace.design && typeof pace.design === 'object', `the read has its design figures (SEAM.md §489) (${Object.keys(pace).join(', ')})`);
    for (const key of ['project', 'designer_sessions', 'ui_stages', 'previews', 'reviews', 'asset_approvals']) assert.ok(key in pace.design, `design.${key}`);
    for (const [path, value] of paceLeaves(pace.design)) {
      const ok = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || (value && typeof value === 'object' && typeof value.unknown === 'string');
      assert.ok(ok, `design.${path}: a value or {unknown: <reason>}, never null (${JSON.stringify(value)})`);
    }
    assert.equal(pace.design.designer_sessions.length, 2, 'the session before build and the review');
    assert.equal(pace.design.previews.length, 1, 'one preview');
    assert.equal(pace.design.reviews.length, 1, 'one review');
    assert.ok(pace.design.asset_approvals.length >= 1, 'the asset approval');
  });

  step('(l) teardown applied, nothing of the prefix left (Alpha\'s and the preview\'s); no check result from a fixture; no decision answered by a role; never a hold unaccounted for (E162 item 1)', async () => {
    const { fx, p } = J;
    J.afterTeardown = await endJourney(fx, p.id, J.env);
    assert.deepEqual(J.afterTeardown.units, [], 'no unit of Alpha\'s prefix');
    assert.deepEqual(J.afterTeardown.cgroups, [], 'no cgroup of Alpha\'s prefix');
    assert.ok(J.previewEnv, 'the preview\'s environment, read at (d)');
    assert.deepEqual(previewUnits(fx.home, J.previewEnv.id), [], 'no unit of the preview\'s prefix');
    assert.deepEqual(previewCgroups(fx.home, J.previewEnv.id), [], 'no cgroup of the preview\'s prefix');
    const fixtures = resultsOf(fx.home, p.id).filter((r) => !r.runner_qualification || r.runner_id === 'test_fixture');
    assert.deepEqual(fixtures.map((r) => r.id), [], 'no check result from a fixture');
    const answered = rows(fx.home, 'SELECT "kind", "answer" FROM "decisions" WHERE "project" = ? AND "status" = \'consumed\'', p.id).map((r) => ({ kind: r.kind, answer: JSON.parse(r.answer ?? '{}') }));
    assert.ok(answered.every((a) => (a.answer.actor ?? 'human') === 'human'), `no decision answered by a role (${JSON.stringify(answered.filter((a) => a.answer.actor !== 'human'))})`);
    for (const kind of ['design_due', 'design_approval', 'design_verdicts']) for (const d of designDecisions(fx.home, p.id, kind).filter((x) => x.status === 'consumed')) assert.equal(d.answer?.actor ?? 'human', 'human', `${kind} answered by the owner`);
    await assertHoldsAccounted(fx, p.id, '(l)');
  });
});

// ---- reads this file adds --------------------------------------------------------------------

function runsOfRole(home, project, role) {
  return withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "project" = ? AND "role" = ? ORDER BY "seq"').all(project, role));
}
function resultsOfKey(home, project, key) {
  return withStore(home, (db) => db.prepare('SELECT r.* FROM "check_results" r JOIN "check_executions" x ON x."id" = r."execution" JOIN "checks" c ON c."id" = x."check" WHERE r."project" = ? AND c."key" = ? ORDER BY r."execution_seq"').all(project, key));
}
function recordsOf(home, kind) {
  return withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "kind" = ? ORDER BY rowid').all(kind));
}
function designReviewsOf(home, project) {
  return withStore(home, (db) => {
    const has = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'design_reviews\'').get();
    if (!has) return [];
    return db
      .prepare('SELECT r.* FROM "design_reviews" r JOIN "design_revisions" d ON d."id" = r."design_revision" WHERE d."project" = ? ORDER BY r.rowid')
      .all(project)
      .map((r) => ({ ...r, subject: r.subject ? JSON.parse(r.subject) : null, verdicts: r.verdicts ? JSON.parse(r.verdicts) : [] }));
  });
}
void executionsOf;
void workOf;
