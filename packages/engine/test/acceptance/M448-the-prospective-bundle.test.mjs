// M448, the prospective bundle (slice 34; kernel lane). M5 plan §3.4 M448;
// D6-A06; D6 §3.4, §5.5; B02; SEAM.md §§346, 347, 401.
//
// (a) the first Architect close: `checkPlan` passes against versions that do
//     not yet exist (architecture 1, roadmap 1, prospective), and refuses
//     `PLAN_STALE_BASELINE` when the plan names versions the publication will
//     not allocate;
// (b) the bundle record holds the current spec version and head, every
//     proposed blob's hash and the versions to be allocated;
// (d) a spec change approved between the pair's preview and its answer: 409
//     `plan_generation_stale`, the proposal `stale`, nothing current changed;
// (e) recovery with the approval answered and the publication not yet written
//     (`plan.before_publication` †), and with the publication written
//     (`plan.after_publication` †): one publication, one `plan.published`, no
//     duplicate rows or work.
// Not here (COVERAGE): (c) a checkpoint and a refused close publish nothing
// (M405 (e), M403 (d), M404 (c)); (d)'s competing proposal (M403 (f),
// M405 (f)).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { answer, consume, decision, decisionsOfKind } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { armBarrier, eventsOfType } from './harness/journal.mjs';
import {
  NOTHING,
  activePlan,
  architectSession,
  createWithIdea,
  eventsAbout,
  journeyContext,
  nothingPublished,
  phasePlansOf,
  planChecks,
  readPlan,
  recordOf,
  specChangeScript,
  specRevisions,
  specSession,
  stagesOfPlan,
  visionSession,
  waitPublished,
  workOf,
} from './harness/journey/drive.mjs';
import { STAGES, phasePlan } from './harness/journey/reference.mjs';
import { postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { recordFile } from './harness/records.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { closeSession } from './harness/sessions.mjs';

async function readyForArchitect(fx) {
  const p = await createWithIdea(fx);
  await visionSession(fx, p.id);
  await specSession(fx, p.id);
  return p;
}
const bundleOf = (home, id) => {
  const row = recordOf(home, id);
  assert.ok(row, `the bundle ${id} is a record`);
  return JSON.parse(readFileSync(recordFile(home, row), 'utf8'));
};

// The one publication, read whole (as M405's).
function assertOnePublication(home, project, what) {
  const plan = activePlan(home, project);
  assert.ok(plan, `${what}: a plan is active`);
  const counts = [
    phasePlansOf(home, project).length,
    plan.generation,
    stagesOfPlan(home, plan.id).length,
    workOf(home, project, 'stage_build').length,
    workOf(home, project, 'check_authoring').length,
    eventsAbout(home, 'plan.published', project).length,
  ];
  assert.deepEqual(counts, [1, 1, STAGES[1].length, STAGES[1].length, 1, 1], `${what}: one plan, generation 1, its stages, one stage_build each, one check_authoring, one plan.published`);
}

// Answer approve on the plan's pair with `name` armed to kill; restart and
// recover; then restart once more. Exactly one publication either way.
async function killedAt(t, name) {
  const fx = await scriptedEngine(t);
  // The authoring the publication makes eligible ends at once, so a tick's wait for idle returns.
  fx.scripted.defaultScript(script.complete());
  const p = await readyForArchitect(fx);
  const arch = await architectSession(fx, p.id, p.repo, { answer: 'architecture_approval' });
  await armBarrier(fx.engine, name, 'kill');
  const pending = answer(fx.engine, p.id, arch.decisions.plan_approval, 'approve').catch((err) => err);
  const died = await waitFor(
    async () => {
      if (!fx.engine.isRunning()) return true;
      await fx.engine.post(`/v1/projects/${p.id}/tick`, {}).catch(() => null);
      return undefined;
    },
    { timeoutMs: 20_000, intervalMs: 300, what: `the engine to kill itself at ${name}` },
  );
  assert.equal(died, true, `the engine reached ${name} (SEAM.md §401)`);
  await pending;
  await fx.start();
  await waitPublished(fx, p.id);
  await fx.engine.kill();
  await fx.start();
  await tick(fx.engine, p.id, { rounds: 3 });
  assertOnePublication(fx.home, p.id, `after a kill at ${name} and two recoveries`);
  assert.equal(eventsOfType(fx.home, 'plan.published').length, 1, 'one plan.published in the whole store');
}

describe('M448 the prospective bundle', () => {
  test('(a) the first close: checkPlan passes against architecture 1 and roadmap 1, which do not exist yet; (b) the bundle record holds the spec version, the head, every blob and the versions to allocate', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const [check] = planChecks(fx.home, p.id);
    assert.ok(check, 'the plan check ran at the close');
    assert.equal(check.outcome, 'passed', `the check passes against the prospective versions (${JSON.stringify(check.reasons)})`);
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'the versions it was checked against do not exist');
    const architecture = decision(fx.home, arch.decisions.architecture_approval.id);
    assert.equal(check.bundle, architecture.manifest?.bundle, 'the check is of the bundle the approval binds');
    // (b) The bundle record itself (SEAM.md §401: the manifest's keys).
    const bundle = bundleOf(fx.home, check.bundle);
    const [spec] = specRevisions(fx.home, p.id);
    assert.equal(bundle.spec_version, spec.version, `the bundle names the current spec version (${JSON.stringify(bundle)})`);
    assert.equal(bundle.baseline_revision, refOid(p.repo.path, p.repo.ref), 'and the integration head');
    for (const path of Object.keys(arch.files)) assert.match(bundle.blobs?.[path] ?? '', /^[0-9a-f]{40}$/, `and the blob of ${path}`);
    assert.deepEqual(bundle.versions, { architecture: 1, roadmap: 1, phase_plan: 1 }, 'and the versions the publication will allocate');
  });

  for (const [name, versions] of [
    ['architecture_version 2', { architecture_version: 2 }],
    ['roadmap_version 2', { roadmap_version: 2 }],
  ]) {
    test(`(a) a first plan prepared against ${name}, a version the publication will not allocate: the close refused PLAN_STALE_BASELINE, nothing published`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await readyForArchitect(fx);
      const revision = refOid(p.repo.path, p.repo.ref);
      const arch = await architectSession(fx, p.id, p.repo, { answer: 'none', plan: phasePlan(1, { revision, ...versions }) });
      assert.equal(arch.closeRes.status, 422, `the close is refused (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
      assert.equal(arch.closeRes.body?.code, 'plan_refused');
      assert.match(JSON.stringify(arch.closeRes.body?.subject ?? {}), /PLAN_STALE_BASELINE/, 'naming PLAN_STALE_BASELINE');
      assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'nothing published');
      await closeSession(fx, p.id, arch.run.id, { refuse: true });
    });
  }

  test('(d) a spec change approved between the pair\'s preview and its answer: 409 plan_generation_stale, the proposal stale, nothing current changed', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const bundle = decision(fx.home, arch.decisions.architecture_approval.id).manifest?.bundle;
    // The owner's change request, its Spec Writer run and the owner's approval.
    fx.scripted.kindScript('spec_change', specChangeScript());
    const ctx = journeyContext(fx, p);
    await postChange(fx, ctx, 'Two clarifications: R2.1 names the content type; R4 counts successful sums only.');
    await pumpNoIdle(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2', answerKinds: ['spec_change'] });
    // The pair answered on its current preview (the latest of each kind).
    const statuses = [];
    for (const kind of ['architecture_approval', 'plan_approval']) {
      const rows = decisionsOfKind(fx.home, p.id, kind);
      const row = rows.find((r) => r.status === 'open') ?? rows.at(-1);
      const res = await answer(fx.engine, p.id, row, 'approve');
      statuses.push({ kind, status: res.status, code: res.body?.code });
    }
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.ok(statuses.some((s) => s.status === 409 && s.code === 'plan_generation_stale'), `the publication is refused plan_generation_stale (${JSON.stringify(statuses)})`);
    assert.deepEqual(nothingPublished(fx.home, p.id, { allowKinds: ['spec_change', 'check_correction', 'replan'] }), NOTHING, 'nothing current changed: no architecture, roadmap, plan, stage or stage work');
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1, 2]);
    const read = await readPlan(fx, p.id);
    const proposal = (read.proposals ?? []).find((x) => x.bundle === bundle);
    assert.equal(proposal?.status, 'stale', `the bundle is listed stale (${JSON.stringify(read.proposals)})`);
  });

  test('(e) a kill with the approval answered and the publication not yet written (plan.before_publication): exactly one publication after recovery', async (t) => {
    await killedAt(t, 'plan.before_publication');
  });

  test('(e) a kill with the publication written (plan.after_publication): exactly one publication and one plan.published after recovery', async (t) => {
    await killedAt(t, 'plan.after_publication');
  });
});
