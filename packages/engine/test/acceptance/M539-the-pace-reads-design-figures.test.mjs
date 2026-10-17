// M539, the pace read's design figures (M6 slice 46; kernel lane). M6 plan
// §3.8 M539; D7 §13, §8.5, §11; D6 §7.6; BS6 §10; SEAM.md §§355, 442, 489,
// 537, 540.
//
// (a), (b) After a design journey on the kernel lane's scripted roles
//     (Pantry, `design: before_build`: the API stage built while the UI
//     stages are held; a Designer session whose turn records usage; a
//     preview; the batch approved with the logo held; the design criteria
//     applied and the UI stages built; the held logo approved by an
//     asset-only approval and its `asset_updated` work integrated), each
//     figure of BS6 §10 present and derived from the recorded observation it
//     declares (SEAM.md §540): per project the spec-to-design-to-ready
//     intervals, slots by effective source, unbound slots, `not_checkable_yet`
//     by target as the engine recorded the native obligations; per Designer
//     session its turns, time and tokens with `cached_in` apart, its screens
//     per target and the one-shots beside it; per UI stage its hold
//     intervals; per preview its deploy time; per asset approval the time to
//     the integration of its `asset_updated` work.
// (c) Unknown, never zero: a Designer session interrupted by a restart
//     (its tokens); a preview whose `memory.peak` was not read (the kernel
//     lane has no real domain); a review with no evidence (its evidence by
//     provenance).
// (d) The human wait of `design_due` and `design_approval` overlapping: each
//     kind's own wait from its decisions' intervals (a question the engine
//     closed included, never dropped), and their union, the overlap counted
//     once (D6 §7.6's rule).
// (e) What the read does: no backend invocation, no adapter call, no
//     `observed_at` changed; two reads the same.
// Times are compared within ±5 s (SEAM.md §442's clock note). No unit, no
// browser (kernel lane).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { adapterState, qualifyByFixture } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { candidatesOfProject, journeyContext, pump, readPace } from './harness/journey/drive.mjs';
import { observedAtSnapshot } from './harness/exec37/pace.mjs';
import { advanceClockInSteps, scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { waitFor } from './harness/engine.mjs';
import { step } from './harness/scripted.mjs';
import { sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { postSaveRaw } from './harness/session-lane.mjs';
import { withStore } from './harness/store.mjs';
import { KERNEL_KINDS } from './harness/design/check41.mjs';
import { designedPantry } from './harness/design/plan44.mjs';
import { previewEnvRow, previewOnKernel } from './harness/design/preview42.mjs';
import { designReview, driveReview, reviewJson, REVIEW_FILE } from './harness/design/review45.mjs';
import {
  answerWith,
  batchOf,
  builderScript,
  cli,
  designEvents,
  designScripts,
  effectiveAssets,
  openDesigner,
  openOfKind,
  scriptBuilders,
  stageWork,
  toPublished,
  validDesign,
  workItems,
} from './harness/design/drive.mjs';

const POLICY = Object.freeze({ design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 } });
const TOL = 5;
// The Designer turn's usage, in the scripted backend's form: billable and cached apart.
const USAGE = Object.freeze({ input_tokens: 1200, cache_read_tokens: 4000, output_tokens: 700 });
// How long the owner leaves the batch unanswered while design_due is open (the scripted clock).
const APPROVAL_WAIT_S = 600;
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const one = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p));
const parse = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);
const isUnknown = (v) => v !== null && typeof v === 'object' && typeof v.unknown === 'string' && v.unknown.length > 0;
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= TOL;
const show = (v) => JSON.stringify(v)?.slice(0, 1200);
const ms = (s) => Date.parse(s);
const secondsBetween = (a, b) => (ms(b) - ms(a)) / 1000;
const firstEvent = (home, type, project) => designEvents(home, type, project)[0] ?? null;

// The union of [from, to] intervals in seconds, overlaps counted once.
function unionSeconds(intervals) {
  const xs = intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of xs) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 1000;
}
// A decision's open interval: from raised_at to its answer, its consumption,
// or the event that closed it (`decision.invalidated`, the engine's close of a
// question that no longer stands). null when it is still open; an end it
// never recorded is {unknown}.
function decisionInterval(home, d) {
  if (d.status === 'open') return null;
  const answered = parse(d.answer)?.at ?? d.consumed_at ?? null;
  const closed = answered ?? rows(home, `SELECT "created_at" FROM "events" WHERE "type" = 'decision.invalidated' AND json_extract("subject", '$.decision') = ? ORDER BY "seq" LIMIT 1`, d.id)[0]?.created_at ?? null;
  return closed ? [ms(d.raised_at), ms(closed)] : { unknown: 'no end recorded' };
}
// The expected human wait of `kinds` within a stage's lifetime, from the store.
function expectedWait(home, project, kinds, from) {
  const ds = rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" IN (${kinds.map(() => '?').join(', ')}) ORDER BY "seq"`, project, ...kinds);
  const iv = [];
  for (const d of ds) {
    const i = decisionInterval(home, d);
    if (i === null) return { unknown: `a ${d.kind} is open` };
    if (!Array.isArray(i)) return i;
    iv.push([Math.max(i[0], from), i[1]]);
  }
  return { seconds: unionSeconds(iv), count: ds.length, intervals: iv };
}

describe('M539 (a), (b), (d), (e) the design figures after a design journey on the kernel lane (Pantry, before_build)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: POLICY, name: 'pantry-m539' });
    designScripts(fx);
    scriptBuilders(fx, p.id);
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KERNEL_KINDS];
    await qualifyByFixture(fx.engine);
    // The API stage builds while the UI stages are held. Its first build
    // holds until the Designer session is open and its first turn settled,
    // so a one-shot certainly runs beside the session (G12; objection 203).
    const api = stageWork(fx.home, p.id, 1);
    assert.ok(api, 'the API stage\'s work item');
    const build = builderScript(1);
    fx.scripted.script(api.id, [{ steps: [step.hold('gate', { heartbeat_ms: 250 }), ...build.steps] }, builderScript(1), builderScript(1)]);
    const dispatched = pump(fx, ctx, () => (fx.scripted.launches({ work_item: api.id }).length > 0 ? true : undefined), { what: 'the API stage dispatched while the UI stages are held', max: 40 });
    // The pump is awaited below, after the release; until then a failure of it ends the wait for the hold.
    let seenHeld = false;
    const ended = dispatched.then(() => {
      if (!seenHeld) throw new Error('the API stage\'s first build was not seen held before the pump returned');
    });
    ended.catch(() => {});
    await Promise.race([fx.scripted.waitForHolding({ work_item: api.id }, 'gate', { timeoutMs: 120_000 }).then(() => (seenHeld = true)), ended]);
    // One Designer session: a turn that records its usage and writes the design; saved; a preview of the checkpoint; closed.
    const run = await openDesigner(fx, p.id);
    const write = turnThatWrites(validDesign(p), { reply: 'The design is written.', done: true });
    scriptTurns(fx, run.id, [{ steps: [step.usage(USAGE), ...write.steps] }]);
    // The turn waits for the project's runs to end, the held build among them: it
    // is awaited after the release, which comes once the session has started
    // (its run's started_at, set when its first turn launches).
    const turn = sayAndSettle(fx, p.id, run.id, 'Draw Pantry for the web and Android.');
    const turnFailed = turn.then(() => undefined);
    turnFailed.catch(() => {});
    await Promise.race([waitFor(() => one(fx.home, 'SELECT "started_at" FROM "runs" WHERE "id" = ?', run.id)?.started_at ?? undefined, { timeoutMs: 60_000, what: 'the Designer session to start' }), turnFailed]);
    // The session has started: the held build is released and ends beside it.
    fx.scripted.release(api.id, 'gate');
    await turn;
    await dispatched;
    J.save = await postSaveRaw(fx, p.id, run.id);
    J.preview = await previewOnKernel(fx, p.id, { revision: 'checkpoint' });
    const closed = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, {});
    assert.equal(closed.status, 200, `the Designer's close (${closed.text?.slice(0, 600)})`);
    const batch = await pump(fx, ctx, () => {
      const b = batchOf(fx.home, p.id);
      return b?.spec_change ? b : undefined;
    }, { what: 'the batch', max: 40 });
    // The owner takes ten minutes over the batch, design_due still open beside it (D6 §7.6's overlap).
    await waitForIdle(fx.home, p.id);
    await advanceClockInSteps(fx.engine, APPROVAL_WAIT_S, { stepSeconds: 20 });
    const fresh = batchOf(fx.home, p.id);
    const held = await answerWith(fx, p.id, fresh?.design_approval ?? batch.design_approval, 'approve', { assets_held: ['logo'] });
    assert.equal(held.status, 200, `approve with the logo held (${held.text})`);
    await consume(fx, p.id, fresh?.spec_change ?? batch.spec_change, 'approve');
    await pump(fx, ctx, () => (one(fx.home, `SELECT "ready_at" FROM "design_revisions" WHERE "project" = ? AND "ready_at" IS NOT NULL ORDER BY rowid DESC LIMIT 1`, p.id) ? true : undefined), { what: 'the design ready', max: 80 });
    await pump(fx, ctx, () => ([2, 3].every((n) => stageWork(fx.home, p.id, n)?.status === 'complete') ? true : undefined), { what: 'both UI stages built and integrated', max: 160 });
    // The held logo approved by an asset-only approval; its asset_updated work integrated.
    const submit = cli(fx, ['design', 'assets', 'submit', '--project', p.id]);
    assert.equal(submit.status, 0, `surety design assets submit exits 0 (${submit.stdout.slice(0, 300)} ${submit.stderr.slice(0, 300)})`);
    const approval = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').at(-1), { what: 'the asset-only design_approval', max: 40 });
    const ok = await answerWith(fx, p.id, approval, 'approve');
    assert.equal(ok.status, 200, `the asset-only approval (${ok.text})`);
    await pump(fx, ctx, () => (workItems(fx.home, p.id, 'fix').some((w) => w.subject?.cause === 'asset_updated' && w.status === 'complete') ? true : undefined), { what: 'the asset_updated work integrated', max: 160 });
    await waitForIdle(fx.home, p.id);
    // (e): what the read touches, around two reads.
    const env = previewEnvRow(fx.home, p.id);
    const launchesBefore = fx.scripted.launches().length;
    const callsBefore = (await adapterState(fx.engine, env.id)).calls.length;
    const observedBefore = observedAtSnapshot(fx.home);
    J.pace = await readPace(fx, p.id);
    J.again = await readPace(fx, p.id);
    J.read = {
      launches: fx.scripted.launches().length - launchesBefore,
      calls: (await adapterState(fx.engine, env.id)).calls.length - callsBefore,
      observedChanged: JSON.stringify(observedAtSnapshot(fx.home)) !== JSON.stringify(observedBefore),
    };
    Object.assign(J, { fx, p, ctx, run });
  });
  after(shared.cleanup);

  const D = () => J.pace?.design ?? {};

  test('(a) the read has its design figures: every leaf a value or {unknown: <reason>}, never null', () => {
    assert.ok(J.pace?.design, `the read has design (SEAM.md §489) (${Object.keys(J.pace ?? {}).join(', ')})`);
    for (const key of ['project', 'designer_sessions', 'ui_stages', 'previews', 'reviews', 'asset_approvals']) assert.ok(key in D(), `design.${key}`);
    const bad = [];
    const walk = (v, path) => {
      if (v === null || v === undefined) bad.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
      else if (typeof v === 'object' && !('unknown' in v)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(D(), 'design');
    assert.deepEqual(bad, [], 'no null figure');
  });

  test('(b) per project: spec approved to design approved to ready, from the recorded events', () => {
    const { fx, p } = J;
    const spec = firstEvent(fx.home, 'baseline.spec_approved', p.id);
    const approved = firstEvent(fx.home, 'design.approved', p.id);
    const ready = firstEvent(fx.home, 'design.ready', p.id);
    assert.ok(spec && approved && ready, 'the fixture is live: the specification and the design approved, the design ready');
    const f = D().project ?? {};
    assert.ok(near(f.spec_approved_to_design_approved, secondsBetween(spec.created_at, approved.created_at)), `spec_approved_to_design_approved ≈ ${secondsBetween(spec.created_at, approved.created_at)} s (read ${show(f.spec_approved_to_design_approved)})`);
    assert.ok(near(f.design_approved_to_ready, secondsBetween(approved.created_at, ready.created_at)), `design_approved_to_ready ≈ ${secondsBetween(approved.created_at, ready.created_at)} s (read ${show(f.design_approved_to_ready)})`);
  });

  test('(b) per project: slots by effective source, unbound slots, not_checkable_yet by target as the engine recorded the native obligations', () => {
    const { fx, p } = J;
    const f = D().project ?? {};
    const eff = effectiveAssets(fx.home, p.id);
    const bySource = {};
    for (const e of eff) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    assert.deepEqual(f.slots_by_source, bySource, `slots_by_source from design_effective_assets (${show(f.slots_by_source)})`);
    const bound = new Set(rows(fx.home, 'SELECT DISTINCT "slot" FROM "asset_bindings" WHERE "project" = ? AND "superseded_by" IS NULL', p.id).map((r) => r.slot));
    const slots = [...new Set(eff.map((e) => e.slot))];
    assert.equal(f.unbound_slots, slots.filter((s) => !bound.has(s)).length, `unbound_slots from asset_bindings (${show(f.unbound_slots)})`);
    const rev = one(fx.home, `SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`, p.id);
    const obligations = rows(fx.home, 'SELECT "target", COUNT(*) AS n FROM "design_native_obligations" WHERE "design_revision" = ? GROUP BY "target"', rev?.id ?? '');
    assert.ok(obligations.length > 0, 'the fixture is live: the approval recorded native obligations (D7 A.3)');
    assert.deepEqual(f.not_checkable_yet, Object.fromEntries(obligations.map((o) => [o.target, o.n])), `not_checkable_yet by target from design_native_obligations, the engine's record, never the design's own list (${show(f.not_checkable_yet)})`);
  });

  test('(b) per Designer session: turns, time, tokens with cached_in apart, screens per target, the one-shots beside it', () => {
    const { fx, run } = J;
    const s = (D().designer_sessions ?? []).find((x) => x.run === run.id);
    assert.ok(s, `the session is in the read (${show(D().designer_sessions)})`);
    const turns = one(fx.home, 'SELECT COUNT(*) AS n FROM "turns" WHERE "run" = ?', run.id).n;
    assert.equal(s.turns, turns, 'turns from the turn records');
    const r = one(fx.home, 'SELECT "created_at", "started_at", "finished_at" FROM "runs" WHERE "id" = ?', run.id);
    assert.ok(near(s.seconds, secondsBetween(r.started_at ?? r.created_at, r.finished_at)), `seconds from the run's start to its end (read ${show(s.seconds)})`);
    const ledger = rows(fx.home, 'SELECT "billable_in", "cached_in", "out" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL', run.id);
    assert.ok(ledger.length > 0 && ledger.every((l) => l.billable_in !== null && l.cached_in !== null && l.out !== null), `the fixture is live: the turn's usage recorded (${show(ledger)})`);
    const sum = (c) => ledger.reduce((n, l) => n + l[c], 0);
    assert.deepEqual(s.tokens, { billable: sum('billable_in'), cached_in: sum('cached_in'), output: sum('out') }, `tokens from the ledger, cached_in apart (${show(s.tokens)})`);
    assert.ok(sum('cached_in') > 0 && s.tokens.cached_in !== s.tokens.billable, 'cached tokens counted apart from billable');
    assert.deepEqual(s.screens_by_target, { web: 1, android: 1 }, `screens per target of its design (${show(s.screens_by_target)})`);
    const start = ms(r.started_at ?? r.created_at);
    const end = ms(r.finished_at);
    const beside = rows(fx.home, `SELECT "created_at", "finished_at" FROM "runs" WHERE "project" = ? AND "kind" = 'one_shot'`, J.p.id).filter((o) => ms(o.created_at) < end && (o.finished_at === null || ms(o.finished_at) > start)).length;
    assert.ok(beside > 0, 'the fixture is live: one-shot runs of the project ran beside the session (G12)');
    assert.equal(s.one_shots_beside, beside, `one_shots_beside from the runs (${show(s.one_shots_beside)})`);
  });

  test('(b) per UI stage: the design_pending interval from its hold record; per preview: the deploy time', () => {
    const { fx, p } = J;
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      const f = (D().ui_stages ?? []).find((x) => x.work_item === w.id);
      assert.ok(f, `stage ${n} is a UI stage of the read (${show(D().ui_stages)})`);
      const pending = (w.held_intervals ?? []).filter((i) => i.reason === 'design_pending');
      assert.ok(pending.length > 0 && pending.every((i) => i.to), `the fixture is live: stage ${n} was held design_pending and released (${show(w.held_intervals)})`);
      const want = pending.reduce((s, i) => s + secondsBetween(i.from, i.to), 0);
      assert.ok(near(f.design_pending_seconds, want), `stage ${n}: design_pending_seconds ≈ ${want} s (read ${show(f.design_pending_seconds)})`);
      assert.equal(f.design_stale_seconds, 0, `stage ${n}: never held design_stale: 0 s, a recorded absence of intervals`);
    }
    const pv = D().previews ?? [];
    assert.equal(pv.length, 1, `one preview (${show(pv)})`);
    const row = one(fx.home, 'SELECT "created_at", "deployed_at" FROM "design_previews" WHERE "project" = ? ORDER BY rowid LIMIT 1', p.id);
    assert.ok(near(pv[0].deploy_seconds, secondsBetween(row.created_at, row.deployed_at)), `deploy_seconds from the preview's record (read ${show(pv[0].deploy_seconds)})`);
  });

  test('(c) a preview whose memory.peak was not read: unknown with its reason, never zero', () => {
    const pv = (D().previews ?? [])[0];
    assert.ok(isUnknown(pv?.memory_peak), `memory_peak {unknown} on the kernel lane, which has no real domain (read ${show(pv?.memory_peak)})`);
  });

  test('(b) per asset approval: the time from the approval to the integration of its asset_updated work', () => {
    const { fx, p } = J;
    const approvals = designEvents(fx.home, 'design.assets_approved', p.id);
    const fix = workItems(fx.home, p.id, 'fix').find((w) => w.subject?.cause === 'asset_updated');
    assert.ok(fix, 'the fixture is live: asset_updated work registered');
    const integrated = rows(fx.home, `SELECT "created_at" FROM "events" WHERE "type" = 'work.integrated' AND json_extract("subject", '$.work_item') = ? ORDER BY "seq" LIMIT 1`, fix.id)[0];
    assert.ok(integrated, 'and integrated');
    const last = approvals.at(-1);
    const f = (D().asset_approvals ?? []).at(-1);
    assert.ok(f, `the asset approval in the read (${show(D().asset_approvals)})`);
    assert.ok(near(f.approval_to_integration, secondsBetween(last.created_at, integrated.created_at)), `approval_to_integration ≈ ${secondsBetween(last.created_at, integrated.created_at)} s (read ${show(f.approval_to_integration)})`);
  });

  test('(d) the human wait of design_due and design_approval: each kind from its decisions\' intervals, a question the engine closed included; their union with the overlap counted once', () => {
    const { fx, p } = J;
    const w = stageWork(fx.home, p.id, 2);
    const from = ms(w.created_at);
    const due = expectedWait(fx.home, p.id, ['design_due'], from);
    const appr = expectedWait(fx.home, p.id, ['design_approval'], from);
    const both = expectedWait(fx.home, p.id, ['design_due', 'design_approval'], from);
    assert.ok(due.count > 0 && appr.count > 0, `the fixture is live: both kinds were raised (${show({ due, appr })})`);
    assert.ok(typeof both.seconds === 'number' && both.seconds + TOL < due.seconds + appr.seconds, `the fixture is live: the two kinds' waits overlapped (union ${show(both)}; design_due ${show(due)}; design_approval ${show(appr)})`);
    const f = (D().ui_stages ?? []).find((x) => x.work_item === w.id)?.human_wait ?? {};
    assert.ok(near(f.design_due, due.seconds), `human_wait.design_due ≈ ${due.seconds} s, its closed question counted (read ${show(f.design_due)})`);
    assert.ok(near(f.design_approval, appr.seconds), `human_wait.design_approval ≈ ${appr.seconds} s (read ${show(f.design_approval)})`);
    assert.ok(near(f.union, both.seconds), `human_wait.union ≈ ${both.seconds} s, the overlap counted once (read ${show(f.union)})`);
  });

  test('(e) the read calls no backend and no adapter and changes no observed_at; read twice, the figures are the same', () => {
    assert.equal(J.read.launches, 0, 'no backend invocation');
    assert.equal(J.read.calls, 0, 'no adapter call');
    assert.equal(J.read.observedChanged, false, 'no observed_at changed');
    assert.deepEqual(J.again, J.pace, 'the same projection twice');
  });
});

describe('M539 (c) a Designer session interrupted by a restart: its tokens unknown, never the sum of the turns that were recorded', () => {
  const shared = sharedFixture();
  const R = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: POLICY, name: 'pantry-m539-restart' });
    designScripts(fx);
    const run = await openDesigner(fx, p.id);
    // Turn 1 records its usage; turn 2 is held and the engine is killed under it.
    scriptTurns(fx, run.id, [{ steps: [step.usage(USAGE), ...turnThatWrites(validDesign(p), { reply: 'The design is written.' }).steps] }, { steps: [step.hold('gate', { heartbeat_ms: 250 })] }]);
    await sayAndSettle(fx, p.id, run.id, 'Draw Pantry.');
    await postSaveRaw(fx, p.id, run.id);
    const said = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/turns`, { text: 'Now refine the Android screen.' });
    assert.equal(said.status, 202, `the second turn admitted (${said.text})`);
    await waitFor(async () => {
      await tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
      return fx.scripted.launches({ run: run.id }).length >= 2;
    }, { timeoutMs: 60_000, what: 'the second turn launched' });
    await fx.engine.kill();
    fx.scripted.release('all', 'gate');
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 }).catch(() => null);
    R.recorded = rows(fx.home, 'SELECT "billable_in" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL AND "billable_in" IS NOT NULL', run.id).length;
    R.pace = await readPace(fx, p.id);
    Object.assign(R, { fx, p, run });
  });
  after(shared.cleanup);

  test('(c) the interrupted session\'s tokens are {unknown} with a reason; its turns are counted', () => {
    const s = (R.pace?.design?.designer_sessions ?? []).find((x) => x.run === R.run.id);
    assert.ok(s, `the session is in the read (${show(R.pace?.design?.designer_sessions)})`);
    assert.ok(R.recorded >= 1, 'the fixture is live: the first turn\'s usage was recorded');
    for (const k of ['billable', 'cached_in', 'output']) assert.ok(isUnknown(s.tokens?.[k]), `tokens.${k} {unknown}: a turn's usage was never recorded (read ${show(s.tokens)})`);
    assert.ok(typeof s.turns === 'number' && s.turns >= 1, `turns counted (${show(s.turns)})`);
  });
});

describe('M539 (c) a review with no evidence: its evidence by provenance unknown, never zero', () => {
  const shared = sharedFixture();
  const V = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const d = await designedPantry(fx, { name: 'pantry-m539-review' });
    await pump(fx, d.ctx, () => candidatesOfProject(fx.home, d.p.id).at(-1), { what: 'a candidate of the built stages', max: 120 });
    await waitForIdle(fx.home, d.p.id);
    // No --observed-on: it says where evidence was seen, and this review carries none (objection 200).
    const res = designReview(fx, d.p.id, { target: 'android', build: 'pantry 3.0 (60)' });
    assert.equal(res.status, 0, `surety design review with no evidence exits 0 (${res.stdout.slice(0, 400)} ${res.stderr.slice(0, 400)})`);
    const review = res.body?.review?.id ?? res.body?.review;
    const screens = [{ target: 'android', key: 'S2', verdict: 'matches', observed_on: 'device', evidence: [], deltas: [] }];
    await driveReview(fx, d.p.id, res.body.run, [{ files: { [REVIEW_FILE(1)]: reviewJson({ subject: { kind: 'owner_build', target: 'android', build_ref: 'pantry 3.0 (60)' }, screens }) }, say: 'It matches; I have no screenshot.', done: true }]);
    V.pace = await readPace(fx, d.p.id);
    V.review = review;
  });
  after(shared.cleanup);

  test('(c) the review\'s evidence is {unknown} with its reason', () => {
    const r = (V.pace?.design?.reviews ?? []).find((x) => x.review === V.review);
    assert.ok(r, `the review is in the read (${show(V.pace?.design?.reviews)})`);
    assert.ok(isUnknown(r.evidence), `evidence {unknown}: the review recorded no evidence, never {} or zero (read ${show(r.evidence)})`);
    assert.equal(r.subject, 'owner_build', 'its subject: the owner\'s build');
  });
});
