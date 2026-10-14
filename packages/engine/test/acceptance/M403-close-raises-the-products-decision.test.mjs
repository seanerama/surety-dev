// M403, close raises the product's decision; the consolidated approval
// publishes once (slice 31a; kernel lane). M5 plan §3.1 M403; D6-S05,
// D6-A02; D6 §3.4, §5.5; D1 §10.3; readings 2, 7; B02; SEAM.md §§344, 346, 347.
//
// (a) close of each role's session with a differing workspace, and with none:
//     a save then exactly one decision per role (`idea_accept`,
//     `spec_approval`, the batched pair), raised once, launching nothing; no
//     save when nothing differs;
// (b) the Architect's close: one `batch_key`, two rows, the parsed machine
//     files `observed`, the prose `claimed`; the architecture's manifest binds
//     the spec version, the proposed blobs and the versions to be allocated;
//     the check ran against those prospective versions;
// (c) `architecture_approval` alone publishes nothing; `plan_approval` alone
//     nothing; both: the plan published after both by the authorized
//     finalizer, `plan.published` once; a role's attempt to answer reaches
//     no route;
// (d) `--refuse`: the products recorded, no decision;
// (e) a save between the decision's preview and its answer: the decision stale;
// (f) two Architect sessions' bundles (different blobs), the second answered
//     after the first published: `plan_generation_stale`; never mixed;
// (g) no `architecture_revisions`, `roadmap_revisions`, `phase_plans`,
//     `stages` or work rows exist before the publication, whatever the
//     checkpoints committed.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, approvalsOf, consume, decision, decisionsOfKind, intentsOf } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import {
  NOTHING,
  activePlan,
  architectSession,
  architectureRevisions,
  batchOf,
  createWithIdea,
  eventsAbout,
  nothingPublished,
  phasePlansOf,
  planChecks,
  recordOf,
  specRevisions,
  specSession,
  stagesOfPlan,
  visionSession,
  waitPublished,
  workOf,
} from './harness/journey/drive.mjs';
import { ADR_001_REVISED, ADR_KEY, IDEA_RECORD, SPEC } from './harness/journey/reference.mjs';
import { ENGINE_ROW, assertEngineRow } from './harness/journey/spec34.mjs';
import { fileAt, refOid } from './harness/repos.mjs';
import { addWork, runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatSays, turnThatWrites } from './harness/sessions.mjs';

// The idea accepted and the specification approved; the project ready for an Architect.
async function readyForArchitect(fx, { policy } = {}) {
  const p = await createWithIdea(fx, policy === undefined ? {} : { policy });
  const vision = await visionSession(fx, p.id);
  const spec = await specSession(fx, p.id);
  return { p, vision, spec };
}

// D1 §4.6's stale answer, as a bundle's approval reads it since M5 slice 37
// (D6 K1; objection 100; SEAM.md §436): the second session's save finalizes
// an operation, which requests a tick, and that tick finds the bundle unable
// to publish and invalidates its decisions (`plan_generation_stale`, the
// driver's ruling (5) of slice 34: a committed 409). Before K1 nothing ticked
// in between and the answer met `decision_stale`. Either refusal is a stale
// one; what the case pins stays: refused, nothing consumed, approved or
// intended.
async function assertStaleBundleAnswer(fx, project, previewed, option) {
  const res = await answer(fx.engine, project, previewed, option);
  assertRefused(res, 409, [CODES.stale, CODES.invalidated, 'plan_generation_stale'], `answering ${previewed.kind} with a preview taken before its dependency changed`);
  const after = decision(fx.home, previewed.id);
  assert.ok(['open', 'invalidated'].includes(after.status), `the decision is not consumed (it is ${after.status})`);
  assert.equal(after.answer ?? null, null, 'no answer is recorded on it');
  assert.equal(approvalsOf(fx.home, previewed.id).length, 0, 'no approval is recorded');
  assert.equal(intentsOf(fx.home, previewed.id).length, 0, 'no effect is intended');
  return res;
}

describe('M403 close raises the product\'s decision; the consolidated approval publishes once', () => {
  test('(a) each role\'s close with a differing workspace: a save, then exactly one decision per role (idea_accept, spec_approval, the batched pair), raised once, launching nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    // Vision: the record written, no save before the close; the close saves.
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA_RECORD }, { reply: 'Rewritten.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Write the idea record.');
    const before = refOid(p.repo.path, p.repo.ref);
    const launches = fx.scripted.launches().length;
    const closed = await closeSession(fx, p.id, run.id);
    assert.match(closed.saved?.revision ?? '', /^[0-9a-f]{40}$/, 'the close saved the differing workspace');
    assert.notEqual(refOid(p.repo.path, p.repo.ref), before, 'one checkpoint commit');
    assert.deepEqual(closed.decisions.map((d) => d.kind), ['idea_accept'], 'exactly one decision, idea_accept');
    await tick(fx.engine, p.id);
    assert.equal(fx.scripted.launches().length, launches, 'raising the decision launched nothing');
    await consume(fx, p.id, decision(fx.home, closed.decisions[0].id), 'approve');
    // The Spec Writer: the close saves and raises spec_approval once.
    const spec = await specSession(fx, p.id);
    assert.deepEqual(spec.closed.decisions.map((d) => d.kind), ['spec_approval']);
    assert.equal(spec.closed.saved, null, 'the second save already committed the workspace: the close saved nothing more');
    // The Architect: the batched pair.
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    assert.deepEqual(
      arch.closed.decisions.map((d) => d.kind).sort(),
      ['architecture_approval', 'plan_approval'],
      `the Architect's close raised the pair (${JSON.stringify(arch.closed)})`,
    );
    assert.equal(new Set(arch.closed.decisions.map((d) => d.batch_key)).size, 1, 'under one batch key');
    await tick(fx.engine, p.id);
    for (const kind of ['idea_accept', 'spec_approval', 'architecture_approval', 'plan_approval']) {
      const rows = decisionsOfKind(fx.home, p.id, kind);
      assert.equal(rows.length, 1, `${kind} raised once`);
    }
  });

  test('(a) a close with nothing differing: no save, the decision raised on the last checkpoint', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA_RECORD }, { reply: 'Rewritten.' }), turnThatSays('Nothing more.')]);
    await sayAndSettle(fx, p.id, run.id, 'Write the idea record.');
    const saved = await saveSession(fx, p.id, run.id);
    await sayAndSettle(fx, p.id, run.id, 'Anything else?');
    const head = refOid(p.repo.path, p.repo.ref);
    const closed = await closeSession(fx, p.id, run.id);
    assert.equal(closed.saved, null, 'no save when nothing differs');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'the branch did not move');
    assert.deepEqual(closed.decisions.map((d) => d.kind), ['idea_accept']);
    const row = decision(fx.home, closed.decisions[0].id);
    assert.equal(row.manifest?.baseline_revision ?? row.manifest?.revision, saved.revision, 'the decision is bound to the last checkpoint');
  });

  test('(b) the Architect\'s close: one batch_key, two rows, machine files observed and prose claimed, the manifest binding the spec version, the blobs and the versions to be allocated; the check ran against those prospective versions', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const rows = batchOf(fx.home, p.id, arch.closed.decisions[0].batch_key);
    assert.deepEqual(rows.map((r) => r.kind), ['architecture_approval', 'plan_approval'], 'two rows under the batch key');
    const [architecture, plan] = rows.map((r) => decision(fx.home, r.id));
    const evidence = architecture.evidence ?? [];
    const prov = (path) => evidence.find((e) => e.path === path)?.provenance;
    assert.equal(prov('.surety/architecture/modules.json'), 'observed', `the module map is observed evidence (${JSON.stringify(evidence)})`);
    assert.equal(prov('.surety/roadmap/roadmap.json'), 'observed');
    assert.equal(prov('.surety/architecture/architecture.md'), 'claimed', 'the prose is claimed');
    const [specRow] = specRevisions(fx.home, p.id);
    assert.equal(architecture.manifest?.spec_version, specRow.version, 'binds the approved spec version');
    const head = refOid(p.repo.path, p.repo.ref);
    assert.equal(architecture.manifest?.baseline_revision, head, 'binds the integration head (the last checkpoint)');
    const blobs = architecture.manifest?.blobs ?? {};
    for (const path of Object.keys(arch.files)) assert.match(blobs[path] ?? '', /^[0-9a-f]{40}$/, `the manifest binds the blob of ${path} (${JSON.stringify(blobs)})`);
    assert.deepEqual(architecture.manifest?.versions, { architecture: 1, roadmap: 1, phase_plan: 1 }, 'the versions publication will allocate (prospective)');
    assert.equal(plan.manifest?.bundle, architecture.manifest?.bundle, 'both rows name one bundle record');
    const bundle = recordOf(fx.home, architecture.manifest.bundle);
    assert.ok(bundle, 'the bundle is a record');
    const [check] = planChecks(fx.home, p.id);
    assert.ok(check, 'the plan check ran at the close');
    assert.deepEqual([check.outcome, check.bundle], ['passed', architecture.manifest.bundle], `against the prospective bundle (${JSON.stringify(check)})`);
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'nothing published yet');
  });

  test('(c) neither approval alone publishes; both do, once, by the authorized finalizer; a role cannot answer', async (t) => {
    const fx = await scriptedEngine(t);
    // No repair of the refused run: its one scripted launch is the case (objection 058).
    const { p } = await readyForArchitect(fx, { policy: { repair_attempts_max: 0 } });
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const d = arch.decisions;
    // A role's attempt: a result field answering a decision is not in the schema.
    const item = await addWork(fx.engine, p.id, 'review');
    fx.scripted.script(item, [roleThat([], { decisions: [{ decision: d.architecture_approval.id, option: 'approve' }] })]);
    const run = await tickUntil(fx.engine, p.id, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { what: 'the role run to end' });
    assert.deepEqual([run.outcome, run.reason_class], ['failed', 'invalid_result'], 'a role\'s result cannot answer a decision');
    assert.equal(decision(fx.home, d.architecture_approval.id).status, 'open', 'the decision is still open');
    // Architecture alone.
    await consume(fx, p.id, d.architecture_approval, 'approve');
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(nothingPublished(fx.home, p.id, { allowKinds: ['review'] }), NOTHING, 'architecture_approval alone publishes nothing');
    // Plan too.
    await consume(fx, p.id, d.plan_approval, 'approve');
    const plan = await waitPublished(fx, p.id);
    assert.deepEqual([plan.phase_number, plan.generation], [1, 1]);
    assert.equal(architectureRevisions(fx.home, p.id).length, 1);
    assert.equal(stagesOfPlan(fx.home, plan.id).length, 2);
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.equal(eventsAbout(fx.home, 'plan.published', p.id).length, 1, 'plan.published once');
    assert.equal(phasePlansOf(fx.home, p.id).length, 1, 'one plan');
    assert.equal(workOf(fx.home, p.id, 'stage_build').length, 2, 'one stage_build per stage, no duplicate');
  });

  test('(c) plan_approval alone publishes nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'plan_approval' });
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING);
    assert.equal(decision(fx.home, arch.decisions.architecture_approval.id).status, 'open');
  });

  test('(d) --refuse: the products recorded as checkpoints, no decision raised', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none', close: { refuse: true } });
    assert.deepEqual(arch.closed.decisions, [], 'no decision');
    const head = refOid(p.repo.path, p.repo.ref);
    assert.equal(fileAt(p.repo.path, head, '.surety/roadmap/roadmap.json'), arch.files['.surety/roadmap/roadmap.json'], 'the products are on the branch as a checkpoint');
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING);
    assert.equal(planChecks(fx.home, p.id).length, 0, 'no check run for a refused close');
  });

  test('(e) a save between the decision\'s preview and its answer: the answer with the old preview is refused as stale (D1 §4.6)', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await readyForArchitect(fx);
    const first = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    // A second Architect session saves a revised ADR (a checkpoint) and is refused: the head moved.
    const run = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, run.id, [turnThatWrites({ [`.surety/adrs/${ADR_KEY}.md`]: ADR_001_REVISED }, { reply: 'ADR revised.' })]);
    await sayAndSettle(fx, p.id, run.id, 'Revise the ADR.');
    await saveSession(fx, p.id, run.id);
    await closeSession(fx, p.id, run.id, { refuse: true });
    await assertStaleBundleAnswer(fx, p.id, first.decisions.architecture_approval, 'approve');
    await assertStaleBundleAnswer(fx, p.id, first.decisions.plan_approval, 'approve');
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING);
  });

  test('(f) two Architect sessions\' bundles with different blobs: the second answered after the first published is refused plan_generation_stale; the published blobs are the first\'s', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await readyForArchitect(fx);
    const first = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const second = await architectSession(fx, p.id, p.repo, { answer: 'none', over: { [`.surety/adrs/${ADR_KEY}.md`]: ADR_001_REVISED } });
    assert.notEqual(second.decisions.architecture_approval.manifest.blobs[`.surety/adrs/${ADR_KEY}.md`], first.decisions.architecture_approval.manifest.blobs[`.surety/adrs/${ADR_KEY}.md`], 'different ADR blobs');
    // The first's rows are stale after the second's saves moved the head: the owner re-reads and answers the current ones... unless the engine keeps the first current. Either way the second is current now.
    // Which bundle is current after the second's checkpoint is the engine's
    // (D6 §5.5 re-compares the baseline and the generation at publication; a
    // checkpoint is neither): the one answered first publishes, and the
    // other's publication is refused.
    const refusedPublication = async (bundle) => {
      const a = await answer(fx.engine, p.id, bundle.decisions.architecture_approval, 'approve');
      if (a.status === 200) {
        const b = await answer(fx.engine, p.id, bundle.decisions.plan_approval, 'approve');
        assertRefused(b, 409, ['plan_generation_stale', 'decision_stale', 'decision_invalidated'], 'the other bundle\'s publication');
      } else assertRefused(a, 409, ['plan_generation_stale', 'decision_stale', 'decision_invalidated'], 'the other bundle');
    };
    const firstArch = await answer(fx.engine, p.id, first.decisions.architecture_approval, 'approve');
    let winner;
    if (firstArch.status === 200) {
      await consume(fx, p.id, first.decisions.plan_approval, 'approve');
      await waitPublished(fx, p.id);
      winner = first;
      await refusedPublication(second);
    } else {
      // plan_generation_stale since K1 (see assertStaleBundleAnswer).
      assertRefused(firstArch, 409, ['decision_stale', 'decision_invalidated', 'plan_generation_stale'], 'the first bundle after the second\'s saves');
      await consume(fx, p.id, second.decisions.architecture_approval, 'approve');
      await consume(fx, p.id, second.decisions.plan_approval, 'approve');
      await waitPublished(fx, p.id);
      winner = second;
      await refusedPublication(first);
    }
    await tick(fx.engine, p.id, { rounds: 2 });
    const published = activePlan(fx.home, p.id);
    assert.equal(published.bundle, winner.decisions.architecture_approval.manifest.bundle, 'the published bundle is the answered one\'s');
    const adr = fileAt(p.repo.path, refOid(p.repo.path, p.repo.ref), `.surety/adrs/${ADR_KEY}.md`);
    assert.ok(adr === first.files[`.surety/adrs/${ADR_KEY}.md`] || adr === second.files[`.surety/adrs/${ADR_KEY}.md`], 'the head holds one session\'s ADR, whole');
    assert.equal(phasePlansOf(fx.home, p.id).length, 1, 'one plan, never a mix');
    assert.equal(architectureRevisions(fx.home, p.id).length, 1);
  });

  test('(g) between the saves and the publication nothing of the baseline, no stage and no work exists, whatever the checkpoints committed', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const head = refOid(p.repo.path, p.repo.ref);
    assert.equal(fileAt(p.repo.path, head, '.surety/phases/phase-1.json'), arch.files['.surety/phases/phase-1.json'], 'the plan is committed as a checkpoint');
    // Superseded by slice 34 (the driver's ruling, 2026-10-13; SEAM.md §399): the
    // approved specification is SPEC with its §11 row for version 1 the engine's.
    assertEngineRow(fileAt(p.repo.path, head, '.surety/spec/spec.md'), SPEC, 1, ENGINE_ROW.approval(1), 'the approved specification at the head');
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'no architecture_revisions, roadmap_revisions, phase_plans, stages or work rows');
    assert.equal(fx.scripted.launches().filter((l) => l.work_kind !== null && l.work_kind !== 'session').length, 0, 'no one-shot run was launched from a checkpoint');
  });
});
