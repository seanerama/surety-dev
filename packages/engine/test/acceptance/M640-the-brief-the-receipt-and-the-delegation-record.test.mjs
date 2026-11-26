// M640, the brief, the receipt and the delegation record (slice 50; kernel
// lane). The owner's M7 plan §3j, row M640; Sean's ruling D7 of 2026-11-26
// ("Record who authorized the action, who performed it, and the scope of the
// delegation. An agent acting on my instruction must be distinguishable from
// my own GUI click. Preserve historical records as written."); S7; R5;
// queue.ts recordApproval; iterations.ts ownerApprovals.
//
// The fixture: one T1 rapid prototype on one engine. The owner configures
// environment alpha (config identity I) before preparation; answers the
// preparation question with a plain answer (no delegation field, as the
// console sends it); the brief is prepared; the brief's spec_approval is
// answered through the API with {"delegation": {"performed_by": "agent",
// "agent": "driver", "instruction": "…"}}; the build is pumped to its Alpha
// (the check correction answered plainly).
//   (a) the brief served at its question (the iteration read's brief while
//       its spec_approval is open): `required_checks` (T1 kinds, one
//       acceptance check per criterion, post_deploy_behavior; which
//       tightening proposals the brief pre-authorizes), `target
//       {environment, config_identity, adapter}`, `repairs` (the repair
//       allowance's meaning: re-dispatch of failed work and verifiable
//       in-scope defect fixes), the plan bounds for iteration 1, and
//       `preparation` stating it was already spent and is not authorized by
//       this approval;
//   (b) every delegated act (here: the plan published, the policy's
//       deployment) recorded with `authorized_by`, `performed_by`
//       (`policy:<name>` or the engine) and `scope`;
//   (c) the delegated answer stored with actor kind human, `performed_by:
//       agent:driver`, `instructed_by: owner`, distinguishable in the
//       decision read, the events and the receipt from the plain answer
//       (`performed_by: owner`);
//   (d) the receipt: `owner_answers` lists every human answer,
//       `delegated_actions` lists (b), `owner_approvals` kept as before;
//   (e) a historical row (pre-0053: its delegation not recorded) served as
//       written: `delegation: null` with `basis: 'not_recorded'`, never
//       inferred as owner or agent.
//
// Readings this file makes (the report says them):
// - "the receipt" is the iteration read (GET …/iterations/:i), where
//   `owner_approvals` is served today; `owner_answers` and
//   `delegated_actions` are read beside it.
// - "the plan bounds" is any key of the brief naming bounds, holding the
//   phase (1) and the stage bound (2).
// - (e) has no route to a pre-0053 row on this engine: the engine is
//   stopped and the preparation answer is made as an earlier row is (what
//   migration 0053 leaves on every earlier row): its `approvals.delegation`
//   set to NULL and `delegation` removed from its `decisions.answer`; then
//   started again. This is the file's only store write, labelled. The
//   receipt must serve it `delegation: null`, `basis: 'not_recorded'`; the
//   decision read (which serves the answer as written) must not infer an
//   owner or an agent for it.
//
// SAFETY (BS6 §4.1; E64): kernel lane; the scripted role program and the
// scripted deployment adapter in the test's own home; nothing signalled but
// the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { entries, holds, one, rows, show, valuesOfKey } from './harness/brief57.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  CHECK_KINDS,
  alphaReady,
  currentIt,
  decisionRead,
  iterationRead,
  newApp,
  ok,
  openDecisionsRead,
  pump,
  statusIs,
} from './harness/prototype.mjs';
import { withStore } from './harness/store.mjs';

const DELEGATION = Object.freeze({ performed_by: 'agent', agent: 'driver', instruction: 'Approve the brief as prepared; it matches what I asked for.' });

const eventsMentioning = (home, id) => rows(home, `SELECT * FROM "events" WHERE "subject" LIKE '%' || ? || '%' OR "payload" LIKE '%' || ? || '%' ORDER BY "seq"`, id, id);
const answerEntry = (list, d) => (Array.isArray(list) ? list.filter((e) => holds(e, d)) : []);
const hasAgent = (v) => entries({ v }).some(([, , x]) => typeof x === 'string' && /^agent:/.test(x));
const performedBy = (v) => valuesOfKey(v, /^performed_by$/);

describe('M640 the brief, the receipt and the delegation record', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const { protoEngine } = await import('./harness/prototype.mjs');
    S.fx = await protoEngine(shared.context, { config: { lease_ttl: 600 } });
    const { fx } = S;
    const { id: p } = await newApp(fx, { name: 'M640' });
    S.p = p;
    S.env = await alphaReady(fx, p, { port: 18640 });
    S.identity = one(fx.home, 'SELECT c."config_identity" FROM "environments" e JOIN "environment_configs" c ON c."id" = e."current_config" WHERE e."id" = ?', S.env.id)?.config_identity;
    const it = await currentIt(fx, p);
    S.it = it.id;
    const prep = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'prototype_preparation_approval');
    S.prep = prep.id;
    await ok(fx.engine.post(`/v1/projects/${p}/decisions/${prep.id}/answer`, { option: 'approve', preview_hash: prep.preview_hash }), 200, 'the plain answer to the preparation question');
    await pump(fx, p, statusIs(fx, p, it.id, 'awaiting_brief_approval'), { what: 'the brief' });
    S.atQuestion = await iterationRead(fx, p, it.id);
    S.spec = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'spec_approval');
  });
  after(() => shared.cleanup());

  test('(a) the brief served at its question: required_checks, target {environment, config_identity, adapter}, repairs, the plan bounds, preparation already spent and not authorized by this approval', { timeout: 600_000 }, async () => {
    const brief = S.atQuestion.brief;
    assert.ok(S.spec, 'the fixture is live: the brief\'s spec_approval is open');
    assert.ok(brief && typeof brief === 'object', `the brief is served (${show(brief)})`);
    for (const k of ['required_checks', 'target', 'repairs', 'preparation']) assert.ok(k in brief, `the brief serves ${k} (keys: ${show(Object.keys(brief))})`);
    const rc = brief.required_checks;
    for (const k of ['acceptance', 'post_deploy_behavior', 'R1.1', 'R2.1', 'R3.1']) assert.ok(holds(rc, k), `required_checks names ${k} (${show(rc)})`);
    assert.match(JSON.stringify(rc), /tighten/i, 'required_checks says which tightening proposals the brief pre-authorizes');
    const tg = brief.target;
    assert.deepEqual([tg?.environment, tg?.config_identity, tg?.adapter], ['alpha', S.identity, 'local_service'], `target {environment, config_identity, adapter} (${show(tg)})`);
    const rp = brief.repairs;
    assert.ok(rp !== null && rp !== undefined, 'repairs served');
    assert.match(JSON.stringify(rp), /fail/i, `repairs: re-dispatch of failed work (${show(rp)})`);
    assert.match(JSON.stringify(rp), /defect|fix/i, 'repairs: verifiable in-scope defect fixes');
    const bounds = entries(brief).filter(([, k]) => /bound/i.test(k)).map(([, , v]) => v);
    assert.ok(bounds.some((b) => holds(b, 2) && holds(b, 1)), `the plan bounds for iteration 1 (phase 1, at most 2 stages) (${show(bounds)})`);
    const pr = brief.preparation;
    assert.ok(pr && typeof pr === 'object', `preparation served (${show(pr)})`);
    assert.ok(valuesOfKey(pr, /^spent$/).includes(true) || /already/i.test(JSON.stringify(pr)), `preparation states it was already spent (${show(pr)})`);
    assert.match(JSON.stringify(pr), /not authori[sz]|does not authori[sz]|authori[sz]ed_by/i, `preparation states it is not authorized by this approval (${show(pr)})`);
  });

  test('(c) the delegated answer: actor human, performed_by agent:driver, instructed_by owner; distinguishable from the plain answer in the decision read, the events and the receipt', { timeout: 600_000 }, async () => {
    const { fx, p } = S;
    const res = await fx.engine.post(`/v1/projects/${p}/decisions/${S.spec.id}/answer`, { option: 'approve', preview_hash: S.spec.preview_hash, delegation: { ...DELEGATION } });
    // Refused, the brief is answered plainly so the journey (and (b), (d), (e)) still reads what the engine records.
    if (res.status !== 200) await ok(fx.engine.post(`/v1/projects/${p}/decisions/${S.spec.id}/answer`, { option: 'approve', preview_hash: S.spec.preview_hash }), 200, 'the plain answer after the refusal');
    await pump(fx, p, statusIs(fx, p, S.it, 'alpha_ready'), { answer: CHECK_KINDS, max: 100, what: 'alpha_ready' });
    S.read = await iterationRead(fx, p, S.it);
    assert.equal(res.status, 200, `the answer with a delegation field is taken (→ ${res.status} ${res.text})`);
    // Stored.
    const appr = rows(fx.home, 'SELECT * FROM "approvals" WHERE "decision" = ?', S.spec.id);
    assert.equal(appr.length, 1, 'one approval row');
    assert.equal(appr[0].actor, 'human', 'actor kind human');
    const stored = appr[0].delegation === undefined ? undefined : JSON.parse(appr[0].delegation ?? 'null');
    assert.ok(stored, `the delegation stored on the approval (${show(appr[0])})`);
    assert.deepEqual([stored.performed_by, stored.instructed_by], ['agent:driver', 'owner'], `performed_by agent:driver, instructed_by owner (${show(stored)})`);
    const plainStored = JSON.parse(rows(fx.home, 'SELECT "delegation" FROM "approvals" WHERE "decision" = ?', S.prep)[0]?.delegation ?? 'null');
    assert.equal(plainStored?.performed_by, 'owner', `the plain answer stored performed_by owner (${show(plainStored)})`);
    // The decision read.
    const dd = await decisionRead(fx, p, S.spec.id);
    const dp = await decisionRead(fx, p, S.prep);
    assert.ok(performedBy(dd).includes('agent:driver') && valuesOfKey(dd, /^instructed_by$/).includes('owner'), `the decision read serves performed_by agent:driver, instructed_by owner (${show(valuesOfKey(dd, /delegation|performed_by|instructed_by/))})`);
    assert.ok(performedBy(dp).includes('owner') && !hasAgent(dp), `the plain answer's decision read serves performed_by owner (${show(valuesOfKey(dp, /delegation|performed_by/))})`);
    // The events.
    const evD = eventsMentioning(fx.home, S.spec.id).filter((e) => e.actor_kind === 'human');
    assert.ok(evD.length > 0, 'the delegated answer\'s events are recorded with actor kind human');
    assert.ok(evD.some((e) => e.actor_id === 'agent:driver' || holds(JSON.parse(e.payload ?? 'null'), 'agent:driver')), `its events name agent:driver (${show(evD.map((e) => [e.type, e.actor_id]))})`);
    const evP = eventsMentioning(fx.home, S.prep).filter((e) => e.actor_kind === 'human');
    assert.ok(evP.length > 0 && evP.every((e) => e.actor_id !== 'agent:driver' && !holds(JSON.parse(e.payload ?? 'null'), 'agent:driver')), `the plain answer's events name no agent (${show(evP.map((e) => [e.type, e.actor_id]))})`);
    // The receipt.
    const ea = answerEntry(S.read.owner_answers, S.spec.id);
    const ep = answerEntry(S.read.owner_answers, S.prep);
    assert.equal(ea.length, 1, `the receipt's owner_answers lists the delegated answer once (${show(S.read.owner_answers)})`);
    assert.ok(performedBy(ea[0]).includes('agent:driver'), `as performed_by agent:driver (${show(ea[0])})`);
    assert.equal(ep.length, 1, 'and the plain answer once');
    assert.ok(performedBy(ep[0]).includes('owner') && !hasAgent(ep[0]), `as performed_by owner (${show(ep[0])})`);
  });

  test('(b) every delegated act recorded with authorized_by, performed_by and scope: the plan published by policy, the policy\'s deployment', { timeout: 600_000 }, async () => {
    assert.ok(S.read, 'the fixture of (c) reached the Alpha');
    const acts = S.read.delegated_actions;
    assert.ok(Array.isArray(acts) && acts.length > 0, `delegated_actions served (${show(acts)})`);
    for (const a of acts) {
      for (const k of ['authorized_by', 'performed_by', 'scope']) assert.ok(a && k in a && a[k] !== undefined, `each delegated act carries ${k} (${show(a)})`);
      assert.ok(performedBy(a).every((v) => typeof v === 'string' && (/^policy:/.test(v) || /^engine/.test(v))), `performed_by policy:<name> or the engine (${show(a.performed_by)})`);
    }
    const brief = S.spec.id;
    const plan = acts.filter((a) => /plan/i.test(JSON.stringify(a)) && holds(a.authorized_by, brief));
    assert.ok(plan.length >= 1, `the plan's publication recorded, authorized by the brief decision ${brief} (${show(acts)})`);
    const deployed = acts.filter((a) => /deploy/i.test(JSON.stringify(a)));
    assert.ok(deployed.length >= 1, `the policy's deployment recorded (${show(acts)})`);
  });

  test('(d) the receipt: owner_answers lists every human answer, delegated_actions lists (b), owner_approvals kept as before', { timeout: 600_000 }, async () => {
    const { fx, p } = S;
    assert.ok(S.read, 'the fixture of (c) reached the Alpha');
    const human = rows(fx.home, `SELECT a."decision", d."kind" FROM "approvals" a JOIN "decisions" d ON d."id" = a."decision" WHERE d."project" = ? AND a."actor" = 'human' ORDER BY a.rowid`, p);
    assert.ok(human.length >= 3, `the fixture is live: preparation, brief and check answered (${show(human)})`);
    const answers = S.read.owner_answers;
    assert.ok(Array.isArray(answers), `owner_answers served (${show(answers)})`);
    for (const h of human) assert.equal(answerEntry(answers, h.decision).length, 1, `owner_answers lists ${h.kind} ${h.decision} once (${show(answers)})`);
    assert.equal(answers.length, human.length, 'and nothing else');
    assert.ok(Array.isArray(S.read.delegated_actions), 'delegated_actions served');
    const oa = S.read.owner_approvals;
    assert.ok(oa && typeof oa.count === 'number' && oa.by_kind, `owner_approvals kept (${show(oa)})`);
    assert.equal(oa.count, human.length, `owner_approvals counted as before (${show(oa)})`);
  });

  test('(e) a historical row (pre-0053) served as written: delegation null with basis not_recorded, never inferred as owner or agent', { timeout: 600_000 }, async () => {
    const { fx, p } = S;
    assert.ok(S.read, 'the fixture of (c) reached the Alpha');
    await fx.engine.stop();
    let wrote;
    try {
      // The file's one store write (labelled above): what migration 0053 leaves on an earlier row.
      wrote = withStore(
        fx.home,
        (db) => db.prepare('UPDATE "approvals" SET "delegation" = NULL WHERE "decision" = ?').run(S.prep).changes * db.prepare(`UPDATE "decisions" SET "answer" = json_remove("answer", '$.delegation') WHERE "id" = ?`).run(S.prep).changes,
        { readonly: false },
      );
    } catch (e) {
      wrote = `refused: ${e.message}`;
    }
    await fx.start();
    assert.equal(wrote, 1, `the fixture is live: the preparation answer made as a pre-0053 row: one approvals row, one decision (${wrote})`);
        const d = await decisionRead(fx, p, S.prep);
    assert.ok(!performedBy(d).some((v) => v === 'owner' || /^agent:/.test(String(v))), `never inferred as owner or agent in the decision read (${show(valuesOfKey(d, /delegation|basis|performed_by/))})`);
    const read = await iterationRead(fx, p, S.it);
    const [e] = answerEntry(read.owner_answers, S.prep);
    assert.ok(e, `the receipt still lists the historical answer (${show(read.owner_answers)})`);
    assert.ok(e.delegation === null && e.basis === 'not_recorded', `the receipt serves it delegation null, basis not_recorded (${show(e)})`);
    assert.ok(!performedBy(e).some((v) => v === 'owner' || /^agent:/.test(String(v))), `never inferred as owner or agent (${show(e)})`);
  });
});
