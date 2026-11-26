// M644, the opt-in preparation allowance (slice 50; kernel lane). The
// owner's M7 plan §3j, row M644; Sean's ruling D8 of 2026-11-26 ("Let me
// authorize one bounded preparation run per iteration, with the model and
// limits visible and the allowance revocable. Starting an iteration should
// disclose that it uses this allowance. If the allowance is absent,
// exhausted, or would be exceeded, ask first."); R5; DECISIONS item 45;
// createIteration.
//
// The fixture: on one engine, a rapid prototype per case; its first
// iteration discarded before preparation (an ended iteration is iterable:
// iterate.ts ITERABLE_STATUSES), so Iterate makes iteration 2 at once. The
// scripted provider's Spec Writer requests `opus` on backend `scripted`
// (requestedModelOf: model_spec_writer's default).
//   (a) no allowance in the policy: Iterate raises
//       prototype_preparation_approval as today (M602);
//   (b) the owner grants the allowance (prototype_preparation_allowance:
//       per_iteration, prototype_preparation_model scripted/opus, its run
//       token limit and estimated USD ceiling): a policy_widening decision
//       shows the model, the run token limit and the estimated USD ceiling;
//       once approved, Iterate creates the brief_preparation work at once,
//       no decision, and the Iterate answer and the iteration read disclose
//       `preparation {by: 'allowance', policy_revision, provider, model,
//       run_token_limit, estimated_usd}`; the run's requested model equals
//       the allowance's;
//   (c) the Spec Writer's requested model changed after the grant
//       (model_spec_writer sonnet), or the preparation's estimate exceeds
//       the allowance's ceiling (its run token limit 10,000, below the
//       preparation's effective 1,500,000): Iterate asks first, the
//       question's evidence naming why the allowance does not cover it;
//   (d) the allowance's run failed (exhausted for this iteration):
//       prepare-again asks;
//   (e) revoked (`off`): no decision for the revocation; the next Iterate
//       asks;
//   (f) a restart between Iterate and dispatch (the project paused across
//       it): one preparation run.
//
// Readings this file makes (the report says them):
// - The policy keys and the model's form (`<provider>/<model>`) are the
//   engine's config schema's (contract export); the row names only
//   `prototype_preparation_allowance: per_iteration` "with model and
//   limits".
// - "the iteration read discloses": an object with `by: 'allowance'` under
//   a key `preparation` anywhere in GET …/iterations/:i.
// - "its evidence naming why the allowance does not cover it": the
//   question's read mentions the preparation allowance by name
//   (`prototype_preparation_allowance`, or the words "preparation
//   allowance").
//
// SAFETY (BS6 §4.1; E64): kernel lane; the scripted role program in the
// test's own home; nothing signalled but the test's own engine (the
// harness's verified stop).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { entries, restart, rows, show } from './harness/brief57.mjs';
import { changePolicy } from './harness/journal.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  confirmed,
  currentIt,
  decisionRead,
  idle,
  iterationRead,
  newApp,
  ok,
  openDecisionsRead,
  ownerPolicy,
  protoEngine,
  pump,
  statusIs,
  usage,
} from './harness/prototype.mjs';
import { pauseProject, resumeProject, tick } from './harness/runs.mjs';

const PREP = 'prototype_preparation_approval';
const MODEL = 'scripted/opus';
const GRANT = Object.freeze({ prototype_preparation_allowance: 'per_iteration', prototype_preparation_model: MODEL, prototype_preparation_run_tokens: 1_500_000, prototype_preparation_usd_estimated: 5 });
const NAMES_ALLOWANCE = /prototype_preparation_allowance|preparation allowance/i;

const prepItems = (home, p) => rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'brief_preparation' ORDER BY "seq"`, p);
const prepDecisionsAbout = (home, it) => rows(home, `SELECT * FROM "decisions" WHERE "kind" = ? AND "subject_id" = ? ORDER BY "seq"`, PREP, it);
const prepRunsOf = (home, it) => rows(home, `SELECT r.* FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? AND w."kind" = 'brief_preparation' ORDER BY r."seq"`, it);
const disclosed = (v) => entries({ v }).filter(([, k, x]) => k === 'preparation' && x && typeof x === 'object' && x.by === 'allowance').map(([, , x]) => x);

// A prototype whose first iteration is discarded: iterable at once.
async function iterable(fx, name) {
  const { id: p } = await newApp(fx, { name });
  const it = await currentIt(fx, p);
  await confirmed(fx, `/v1/projects/${p}/iterations/${it.id}/discard`);
  return { p, one: it.id };
}
const iterate = (fx, p, from) => fx.engine.post(`/v1/projects/${p}/iterations/${from}/iterate`, { change: 'Show the number of open tasks at the top.' });

// The grant, as the owner makes it: a widening confirmed through its decision.
async function grant(fx, p, change = GRANT) {
  const g = await ownerPolicy(fx, p, change, 'the preparation allowance');
  assert.equal(g.status, 409, `granting the allowance is a widening (→ ${g.res.status} ${g.res.text})`);
  await pump(fx, p, async () => ((await fx.engine.get(`/v1/projects/${p}/policy`)).body?.effective?.prototype_preparation_allowance === 'per_iteration' ? true : undefined), { max: 10, what: 'the allowance in effect' });
  return g;
}

describe('M644 the opt-in preparation allowance', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) no allowance in the policy: Iterate raises prototype_preparation_approval as today', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 a');
    const made = await ok(iterate(fx, p, one), 201, 'Iterate');
    const two = made.iteration.id;
    assert.equal(prepDecisionsAbout(fx.home, two).filter((d) => d.status === 'open').length, 1, 'the preparation question raised');
    assert.deepEqual(prepItems(fx.home, p), [], 'no preparation work before the answer');
  });

  test('(b) the allowance granted through a policy_widening showing the model and limits; Iterate creates the preparation at once, no decision, disclosed in the answer and the read; the run requests the allowance\'s model', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 b');
    const g = await grant(fx, p);
    const w = JSON.stringify(g.widening);
    assert.equal(g.widening.kind, 'policy_widening');
    for (const v of [MODEL, '1500000', '5']) assert.ok(w.includes(v), `the widening shows ${v} (the model, the run token limit, the estimated USD ceiling): ${w.slice(0, 1500)}`);
    const res = await iterate(fx, p, one);
    assert.equal(res.status, 201, `Iterate (→ ${res.status} ${res.text})`);
    const two = res.body.iteration.id;
    assert.deepEqual(prepDecisionsAbout(fx.home, two).map((d) => [d.id, d.status]), [], 'no preparation question about iteration 2');
    const items = prepItems(fx.home, p);
    assert.equal(items.length, 1, `the brief_preparation work created at once (${show(items.map((x) => [x.id, x.status, x.subject]))})`);
    const pr = res.body.preparation ?? res.body.iteration?.preparation;
    assert.ok(pr, `the Iterate answer discloses the preparation (${res.text.slice(0, 1500)})`);
    for (const k of ['by', 'policy_revision', 'provider', 'model', 'run_token_limit', 'estimated_usd']) assert.ok(k in pr, `preparation.${k} (${show(pr)})`);
    assert.deepEqual([pr.by, pr.provider, pr.run_token_limit], ['allowance', 'scripted', 1_500_000], `by allowance, provider scripted, its run token limit (${show(pr)})`);
    assert.ok(['opus', MODEL].includes(pr.model), `the allowance's model (${pr.model})`);
    const read = await iterationRead(fx, p, two);
    assert.equal(disclosed(read).length >= 1, true, `the iteration read discloses preparation by allowance (${show(entries(read).filter(([, k]) => k === 'preparation').map(([path, , x]) => [path, x]))})`);
    await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
    const runs = prepRunsOf(fx.home, two);
    assert.equal(runs.length, 1, 'one preparation run');
    assert.equal(runs[0].model_requested, 'opus', `the run requested the allowance's model (${runs[0].model_requested})`);
  });

  test('(c) the Spec Writer\'s requested model changed after the grant: Iterate asks first, its evidence naming the allowance', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 c model');
    await grant(fx, p);
    await changePolicy(fx.engine, p, { model_spec_writer: 'sonnet' });
    const made = await ok(iterate(fx, p, one), 201, 'Iterate');
    const two = made.iteration.id;
    const open = prepDecisionsAbout(fx.home, two).filter((d) => d.status === 'open');
    assert.equal(open.length, 1, `Iterate asks first (${show(prepItems(fx.home, p).map((x) => [x.id, x.status]))})`);
    assert.deepEqual(prepItems(fx.home, p), [], 'no preparation work before the answer');
    const d = await decisionRead(fx, p, open[0].id);
    assert.match(JSON.stringify(d), NAMES_ALLOWANCE, `the question names why the allowance does not cover it (${JSON.stringify(d).slice(0, 2000)})`);
  });

  test('(c) the preparation\'s estimate exceeds the allowance\'s ceiling: Iterate asks first, its evidence naming the allowance', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 c ceiling');
    await grant(fx, p, { ...GRANT, prototype_preparation_run_tokens: 10_000 });
    const made = await ok(iterate(fx, p, one), 201, 'Iterate');
    const two = made.iteration.id;
    const open = prepDecisionsAbout(fx.home, two).filter((d) => d.status === 'open');
    assert.equal(open.length, 1, 'Iterate asks first');
    assert.deepEqual(prepItems(fx.home, p), [], 'no preparation work before the answer');
    const d = await decisionRead(fx, p, open[0].id);
    assert.match(JSON.stringify(d), NAMES_ALLOWANCE, `the question names why the allowance does not cover it (${JSON.stringify(d).slice(0, 2000)})`);
  });

  test('(d) the allowance\'s run failed: prepare-again asks', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 d');
    await grant(fx, p);
    await pauseProject(fx.engine, p);
    const made = await ok(iterate(fx, p, one), 201, 'Iterate');
    const two = made.iteration.id;
    const [item] = prepItems(fx.home, p);
    assert.ok(item, `the preparation work created under the allowance (decisions: ${show(prepDecisionsAbout(fx.home, two).map((d) => d.status))})`);
    fx.scripted.script(item.id, [{ steps: [usage(400, 0, 100), { exit: 3 }] }]);
    await resumeProject(fx.engine, p);
    await pump(fx, p, async () => ((await iterationRead(fx, p, two)).outcome.next_step === 'prepare again or discard' ? true : undefined), { max: 10, what: 'the allowance\'s run failed' });
    assert.equal(prepRunsOf(fx.home, two).length, 1, 'one preparation run, failed');
    const asked = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${two}/prepare`, {}), 201, 'POST …/prepare after the failure');
    assert.equal(asked.decision?.kind, PREP, `prepare-again asks (${show(asked)})`);
    await tick(fx.engine, p);
    assert.equal(prepItems(fx.home, p).length, 1, 'no second preparation without the answer');
  });

  test('(e) revoked (off): no decision for the revocation; the next Iterate asks', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 e');
    await grant(fx, p);
    const res = await fx.engine.post(`/v1/projects/${p}/policy`, { prototype_preparation_allowance: 'off' });
    assert.equal(res.status, 200, `the revocation is taken with no decision (→ ${res.status} ${res.text})`);
    await pump(fx, p, async () => ((await fx.engine.get(`/v1/projects/${p}/policy`)).body?.effective?.prototype_preparation_allowance === 'off' ? true : undefined), { max: 10, what: 'the allowance revoked' });
    assert.deepEqual((await openDecisionsRead(fx, p)).filter((d) => d.kind === 'policy_widening').map((d) => d.id), [], 'no widening asked');
    const made = await ok(iterate(fx, p, one), 201, 'Iterate');
    const two = made.iteration.id;
    assert.equal(prepDecisionsAbout(fx.home, two).filter((d) => d.status === 'open').length, 1, 'the next Iterate asks');
    assert.deepEqual(prepItems(fx.home, p), [], 'no preparation work before the answer');
  });

  test('(f) a restart between Iterate and dispatch: one preparation run', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const { p, one } = await iterable(fx, 'M644 f');
    await grant(fx, p);
    await pauseProject(fx.engine, p);
    const made = await ok(iterate(fx, p, one), 201, 'Iterate');
    const two = made.iteration.id;
    assert.equal(prepItems(fx.home, p).length, 1, 'the preparation work created under the allowance');
    await restart(fx);
    await resumeProject(fx.engine, p);
    await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
    await idle(fx, p);
    assert.equal(prepItems(fx.home, p).length, 1, 'one preparation work item');
    assert.equal(prepRunsOf(fx.home, two).length, 1, 'one preparation run');
    assert.deepEqual(prepDecisionsAbout(fx.home, two).map((d) => d.id), [], 'and no question');
  });
});
