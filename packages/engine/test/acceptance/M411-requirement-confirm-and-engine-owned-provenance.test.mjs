// M411, `requirement_confirm`, engine-owned provenance (slice 32; kernel
// lane). M5 plan §3.2 M411; D6-R03; D6 §8.1 step 2, §8.3; K10; E6; B10; D1
// §10.3 (one batch, each row consumed separately); SEAM.md §379.
//   (a) a retrofit Spec Writer close with three `observed` requirements, one
//       `intended`, and one the engine binds to the idea brief's approved text
//       (its statement is a "First version" item of the idea given at
//       adoption, §379 †): `spec_approval` consolidated with four
//       `requirement_confirm` rows (the `intended` one included, the bound one
//       excluded), each bound to the exact proposed text and criteria;
//   (b) `confirm`, `defect`, `withdraw`, each consumed separately: `pending`;
//       `pending` with `defect` true; `withdrawn`;
//   (c) a role's attempt to confirm (its reply carrying confirmations) and a
//       product written to suppress the rows (every row `intended`): the rows
//       exist regardless of the role's labels, none answered;
//   (d) a save changing a requirement's text between the preview and the
//       answer: that row stale, its next generation bound to the new text;
//   (e) the project, spec and plan reads show the mark and `pending`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, approvalsOf, decision, decisionsOfKind } from './harness/decisions.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { readPlan, readProjectRaw, readSpec, requirementsOf } from './harness/journey/drive.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { adoptProject, chooseMode, confirmAndApprove, retrofitEngine, retrofitSpecSession, toConformancePublished } from './harness/retrofit/drive.mjs';
import { KEYS, REQUIREMENTS, retrofitSpecText } from './harness/retrofit/products.mjs';

// R5: the idea given at adoption lists its statement as a "First version" item.
const R5 = { key: 'R5', title: 'Answer in JSON', phase: 1, module: 'service', origin: 'observed', statement: 'Every answer of the service is JSON.', criteria: [{ id: 'R5.1', text: 'Given the service is running, when a client requests GET /health, then the answer has content type application/json.' }] };
const IDEA = `# Idea: Sums\n\n## The idea in one paragraph\n\nKeep the adopted service and make it refuse what is not a number.\n\n## First version\n\n- ${R5.statement}\n`;
const textOf = (r) => r.statement;

describe('M411 requirement_confirm: engine-owned provenance', () => {
  test('(a) one requirement_confirm per produced requirement, the intended one included, the one bound to the idea excluded; each bound to its exact text and criteria; (b) confirm, defect and withdraw, each consumed separately', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx, { idea: IDEA });
    await chooseMode(fx, p.id, 'full');
    const requirements = [...REQUIREMENTS, R5];
    const s = await retrofitSpecSession(fx, p.id, { spec: retrofitSpecText({ requirements }) });
    assert.ok(s.approval, `spec_approval raised (${JSON.stringify(s.closed)})`);
    assert.deepEqual(Object.keys(s.confirms).sort(), [...KEYS], `four rows, R1 to R4 (R4 intended among them), R5 bound to the idea and excluded (${JSON.stringify(Object.keys(s.confirms))})`);
    for (const r of REQUIREMENTS) {
      const row = s.confirms[r.key];
      assert.equal(row.batch_key, s.approval.batch_key, `${r.key}: consolidated with spec_approval under one batch key`);
      assert.equal(row.subject_type, 'requirement', `${r.key}: about a requirement`);
      assert.deepEqual(row.options.map((o) => o.key).sort(), ['confirm', 'defect', 'withdraw'], `${r.key}: confirm, defect, withdraw`);
      assert.equal(row.manifest?.text, textOf(r), `${r.key}: bound to its exact text`);
      assert.deepEqual(row.manifest?.criteria, r.criteria, `${r.key}: bound to its exact criteria`);
    }
    // (b) each answered on its own row.
    const done = await confirmAndApprove(fx, p.id, { R1: 'confirm', R2: 'confirm', R3: 'withdraw', R4: 'defect' });
    const ids = Object.values(done.answers).map((d) => d.id);
    assert.equal(new Set(ids).size, 4, 'four decisions');
    for (const id of ids) assert.equal(approvalsOf(fx.home, id).length, 1, `${id} consumed by its own approval`);
    const by = Object.fromEntries(requirementsOf(fx.home, p.id).map((r) => [r.key, r]));
    assert.deepEqual([by.R1.status, Boolean(by.R1.defect), Boolean(by.R1.reverse_engineered)], ['pending', false, true], 'confirm: pending');
    assert.deepEqual([by.R4.status, Boolean(by.R4.defect)], ['pending', true], 'defect: pending with defect true');
    assert.ok((by.R4.assigned_phase ?? 2) > 1, 'scheduled to a later phase');
    assert.equal(by.R3.status, 'withdrawn', 'withdraw: withdrawn');
    assert.ok(by.R3.withdrawn_at, 'with its time');
    assert.equal(by.R5.status, 'pending', 'R5, bound to the approved idea, pending without a confirmation');
    assert.ok(eventsOfType(fx.home, 'requirement.confirmed').filter((e) => e.subject?.project === p.id).length >= 2, 'requirement.confirmed for the confirmed ones');
  });

  test('(c) a reply carrying confirmations and a product labelling every row intended: the rows exist regardless, none answered', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    const s = await retrofitSpecSession(fx, p.id, {
      spec: retrofitSpecText({ origins: Object.fromEntries(KEYS.map((k) => [k, 'intended'])) }),
      result: { requirement_confirmations: KEYS.map((key) => ({ key, option: 'confirm' })) },
    });
    assert.deepEqual(Object.keys(s.confirms).sort(), [...KEYS], 'a row for every produced requirement');
    assert.ok(Object.values(s.confirms).every((d) => d.status === 'open'), 'each open: no role confirms');
    assert.ok(requirementsOf(fx.home, p.id).every((r) => r.status !== 'pending' || !r.confirmed_at), 'nothing confirmed');
  });

  test('(d) a save changing a requirement\'s text between the preview and the answer: that row stale, its next generation bound to the new text', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    const s = await retrofitSpecSession(fx, p.id);
    const old = s.confirms.R2;
    const changed = REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, statement: 'A client sums two numbers through the service over HTTP, answered as JSON.' } : r));
    const run = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/spec/spec.md': retrofitSpecText({ requirements: changed }) }, { reply: 'R2 reworded.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Say that R2 answers JSON.');
    await saveSession(fx, p.id, run.id);
    await closeSession(fx, p.id, run.id);
    const res = await answer(fx.engine, p.id, old, 'confirm');
    assert.equal(res.status, 409, `the answer with the old preview is refused (→ ${res.status} ${res.text})`);
    assert.ok(['decision_stale', 'decision_invalidated'].includes(res.body?.code), `stale (${res.body?.code})`);
    assert.notEqual(decision(fx.home, old.id).status, 'consumed', 'and not consumed');
    const next = decisionsOfKind(fx.home, p.id, 'requirement_confirm').find((d) => d.status === 'open' && d.manifest?.key === 'R2');
    assert.ok(next && next.id !== old.id, 'a next generation for R2');
    assert.equal(next.manifest?.text, changed.find((r) => r.key === 'R2').statement, 'bound to the new text');
  });

  test('(e) the project, spec and plan reads show the mark and pending', async (t) => {
    const fx = await retrofitEngine(t);
    const J = await toConformancePublished(fx);
    const project = await readProjectRaw(fx, J.p.id);
    assert.equal(project.project?.adoption?.pinned_revision ?? project.adoption?.pinned_revision, J.p.A, 'the project read shows A');
    const spec = await readSpec(fx, J.p.id);
    const by = Object.fromEntries((spec.requirements ?? []).map((r) => [r.key, r]));
    for (const key of KEYS) assert.deepEqual([by[key]?.reverse_engineered, by[key]?.status], [true, 'pending'], `spec read: ${key} reverse-engineered and pending (${JSON.stringify(by[key])})`);
    assert.equal(by.R4.defect, true, 'spec read: R4 marked defect');
    assert.deepEqual(KEYS.map((k) => by[k].origin), REQUIREMENTS.map((r) => r.origin), 'spec read: origin per requirement');
    const plan = await readPlan(fx, J.p.id);
    const planned = Object.fromEntries((plan.requirements ?? []).map((r) => [r.key, r]));
    for (const key of KEYS) assert.deepEqual([planned[key]?.reverse_engineered, planned[key]?.status], [true, 'pending'], `plan read: ${key} (${JSON.stringify(planned[key])})`);
    assert.equal(planned.R4?.defect, true, 'plan read: R4 marked defect');
  });
});
