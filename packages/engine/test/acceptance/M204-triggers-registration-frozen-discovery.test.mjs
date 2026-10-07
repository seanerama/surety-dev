// M204, triggers, registration and the frozen discovery (M3 slice 15; kernel
// lane). M3 plan §3.1 M204; D3-R13, D3-P04; L2; T05; D3 §2.5, §1.4, §3.5,
// A.2 CheckTrigger, A.6, A.7; SEAM.md §§67, 68, 177 to 185.
//
// (a) A nomination registers each check of the union of the candidate's
// stage and Alpha required sets, once. (b) A protected application registers
// the new version's checks for every unsuperseded candidate in the finalizer
// that applies it. (c) The operator route: two requests both register, a
// replayed one registers nothing, a key that is not required is refused.
// (d) A role's result carrying a registration or result field is invalid
// and registers and records nothing. (e) Killed before, inside and after the
// nomination's and the application's finalizers, then restarted: the checks
// rows are the discovery, and there is exactly one registration per trigger
// generation and key.
//
// Case (f), a nomination whose required set needs the candidate's module
// facts, is slice 20's: the required set depends on modules only once the
// sensitivity floors exist (COVERAGE.md, "M3 slice 15").
//
// Kernel lane: the runner switch is off (SEAM.md §177), so registrations
// stay `queued` and no check runs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, openDecision, untilKilled } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { capturedProposal, effectiveVersion, humanApplies, protectedVersions, proposalsOf, roleRun, waitApplied } from './harness/gates.mjs';
import { addItem, permittedEdit, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { armBarrier, candidatesOf, changePolicy, eventsOfType } from './harness/journal.mjs';
import { runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import {
  GOVERNED_FILE,
  KERNEL_COMMANDS,
  acceptance,
  allExecutionCount,
  assertOncePerTrigger,
  checkProject,
  checksRowsOf,
  defPath,
  executionsOf,
  governedText,
  installIndexedPlan,
  requestChecks,
  resultCount,
  smoke,
} from './harness/checks/fixtures.mjs';

// The definitions and what each is: in the stage set, the Alpha set, both, or neither.
const DEFS = {
  st: { text: smoke('st', { gates: ['stage'] }), kind: 'smoke', gates: ['stage'] },
  al: { text: smoke('al', { gates: ['alpha_authorize'] }), kind: 'smoke', gates: ['alpha_authorize'] },
  both: { text: acceptance('both', ['R1.1']), kind: 'acceptance', gates: ['stage', 'alpha_authorize'] },
  other: { text: acceptance('other', ['R2.1']), kind: 'acceptance', gates: ['stage', 'alpha_authorize'] },
  beta: { text: smoke('beta', { gates: ['beta_authorize'] }), kind: 'smoke', gates: ['beta_authorize'] },
  optional: { text: smoke('optional', { gates: ['stage'] }), kind: 'smoke', gates: ['stage'] },
};
const REQUIRED = ['st', 'al', 'both', 'other', 'beta'];
// The union of the stage and Alpha required sets of the stage's candidate:
// `other` covers R2, which no stage implements; `beta` lists neither gate;
// `optional` is not in required_checks.
const UNION = ['al', 'both', 'st'];

function files(defs = DEFS, required = REQUIRED) {
  const out = { [GOVERNED_FILE]: governedText({ check_commands: KERNEL_COMMANDS, ...(required === null ? {} : { required_checks: required }) }) };
  for (const [key, d] of Object.entries(defs)) out[defPath(key)] = d.text;
  return out;
}

// A T1 project with the definitions, the index (R1, R2) and one stage implementing R1.
async function project(fx, opts = {}) {
  const p = await checkProject(fx, { files: files(opts.defs, opts.required), tier: 'T1' });
  const plan = await installIndexedPlan(fx.engine, p.id, {
    index: [
      { key: 'R1', criteria: ['R1.1'] },
      { key: 'R2', criteria: ['R2.1'] },
    ],
    stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }],
  });
  return { ...p, plan, stage: plan.stages[0] };
}

// The stage's Builder asks for the nomination; tick until the candidate exists.
async function buildAndNominate(fx, p) {
  fx.scripted.script(p.stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
  await tick(fx.engine, p.id);
  const [candidate] = await waitForCandidates(fx, p.id);
  return candidate;
}

// Ask for ticks until the candidate's registrations of `source` cover `keys`.
const registered = (fx, p, candidate, source, keys) =>
  tickUntil(
    fx.engine,
    p.id,
    () => {
      const regs = executionsOf(fx.home, candidate.id).filter((x) => x.trigger?.source === source);
      return keys.every((k) => regs.some((x) => x.key === k)) ? regs : undefined;
    },
    { max: 6, what: `the ${source} registrations of ${keys.join(', ')} for candidate ${candidate.seq}` },
  );

// The candidate's later candidate at T1: a fixture fix whose Builder asks for the nomination.
async function successor(fx, p) {
  const count = candidatesOf(fx.home, p.id).length;
  const fix = await addItem(fx, p.id, 'fix');
  fx.scripted.script(fix, [roleThat([step.write(`src/fix-${count}.js`, 'export const fix = 1;\n')], { nominate: true })]);
  await tickUntil(fx.engine, p.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
  return (await waitForCandidates(fx, p.id, count + 1)).at(-1);
}

// The checks rows of a version are exactly the definitions written in its tree.
function assertChecksAreDiscovery(fx, version, defs, required, what) {
  const rows = checksRowsOf(fx.home, version);
  assert.deepEqual(rows.map((r) => r.key), Object.keys(defs).sort(), `${what}: one checks row per definition of the tree, and no other`);
  for (const r of rows) {
    const d = defs[r.key];
    assert.deepEqual(
      { kind: r.kind, gate_kinds: r.gate_kinds, definition_path: r.definition_path, required: r.required },
      { kind: d.kind, gate_kinds: d.gates, definition_path: defPath(r.key), required: required === null || required.includes(r.key) ? 1 : 0 },
      `${what}: the row of ${r.key} is its definition as discovered`,
    );
  }
}

describe('M204 triggers, registration and the frozen discovery', () => {
  test('(a) nomination: each check of the union of the stage and Alpha required sets is registered once, by the nomination trigger; nothing else is', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await project(fx);
    const candidate = await buildAndNominate(fx, p);
    await registered(fx, p, candidate, 'nomination', UNION);
    await tick(fx.engine, p.id, { rounds: 3 });
    const regs = executionsOf(fx.home, candidate.id);
    assert.deepEqual(regs.map((x) => x.key).sort(), UNION, `exactly the union is registered, once each (registrations: ${JSON.stringify(regs.map((x) => [x.key, x.trigger]))})`);
    for (const x of regs) {
      assert.deepEqual([x.trigger?.source, x.status, x.source_revision], ['nomination', 'queued', candidate.revision], `${x.key}: a nomination registration of the candidate's revision, queued (the kernel lane's runner switch is off)`);
      assert.equal(eventsOfType(fx.home, 'check.registered').filter((e) => e.subject?.check_execution === x.id).length, 1, `${x.key}: one check.registered`);
    }
    assertOncePerTrigger(regs, 'the nomination');
  });

  test('(b) a protected application registers the new version\'s checks for every unsuperseded candidate, in the finalizer that applies it', async (t) => {
    const fx = await scriptedEngine(t);
    const defs = { st: DEFS.st, both: DEFS.both };
    const p = await project(fx, { defs, required: null });
    await buildAndNominate(fx, p);
    await successor(fx, p);
    const extra = smoke('extra', { gates: ['stage'] });
    const proposal = await capturedProposal(fx, p, { changeKind: null, steps: [step.write(defPath('extra'), extra)] });
    const version = await humanApplies(fx, p, proposal, 'tightening');

    const applied = eventsOfType(fx.home, 'protected.applied').filter((e) => e.subject?.proposal === proposal.id);
    assert.equal(applied.length, 1, 'one protected.applied for the proposal');
    const candidates = candidatesOf(fx.home, p.id);
    assert.equal(candidates.length, 2, 'the fixture is live: two candidates when the version was applied');
    for (const c of candidates) {
      const regs = executionsOf(fx.home, c.id).filter((x) => x.trigger?.source === 'protected_application');
      if (c.superseded_by !== null) {
        assert.deepEqual(regs, [], `candidate ${c.seq} is superseded: nothing is registered for it`);
        continue;
      }
      assert.deepEqual(regs.map((x) => x.key).sort(), ['both', 'extra', 'st'], `candidate ${c.seq}: the new version's checks are registered once each`);
      for (const x of regs) {
        assert.equal(x.protected_version, version.id, `candidate ${c.seq}, ${x.key}: bound to the new version`);
        const ev = eventsOfType(fx.home, 'check.registered').filter((e) => e.subject?.check_execution === x.id);
        assert.equal(ev.length, 1, `candidate ${c.seq}, ${x.key}: one check.registered`);
        assert.equal(ev[0].tx, applied[0].tx, `candidate ${c.seq}, ${x.key}: registered in the transaction of the application's finalizer (L2)`);
      }
    }
    assert.ok(candidates.some((c) => c.superseded_by === null), 'at least one candidate was unsuperseded');
  });

  test('(c) the operator route: two requests both register; a replayed one registers nothing; a key that is not required is 400 invalid_value', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await project(fx);
    const candidate = await buildAndNominate(fx, p);
    await registered(fx, p, candidate, 'nomination', UNION);
    const operator = () => executionsOf(fx.home, candidate.id).filter((x) => x.trigger?.source === 'operator_request');

    for (const n of [1, 2]) {
      const res = await requestChecks(fx.engine, p.id, candidate.id, {});
      assert.equal(res.status, 202, `request ${n}: 202 (body: ${res.text})`);
      assert.deepEqual(res.body?.executions?.map((e) => e.key).sort(), UNION, `request ${n}: every required check of the candidate is registered`);
    }
    assert.equal(operator().length, 2 * UNION.length, 'two requests are two triggers: both registered');

    const keyed = await requestChecks(fx.engine, p.id, candidate.id, { keys: ['st'], request_key: 'once' });
    assert.equal(keyed.status, 202, `a keyed request registers (body: ${keyed.text})`);
    const replay = await requestChecks(fx.engine, p.id, candidate.id, { keys: ['st'], request_key: 'once' });
    assert.equal(replay.status, 200, `its replay is answered 200 (body: ${replay.text})`);
    assert.deepEqual(replay.body?.executions?.map((e) => e.id), keyed.body?.executions?.map((e) => e.id), 'with the executions the request registered');
    assert.equal(operator().length, 2 * UNION.length + 1, 'and registers nothing');

    const before = allExecutionCount(fx.home);
    assertRefused(await requestChecks(fx.engine, p.id, candidate.id, { keys: ['optional'] }), 400, 'invalid_value', 'a key that is not required');
    assert.equal(allExecutionCount(fx.home), before, 'the refusal registers nothing');
    assertOncePerTrigger(executionsOf(fx.home, candidate.id), 'the operator requests');
  });

  test("(d) a role's result carrying a registration or result field is invalid, and nothing is registered or recorded", async (t) => {
    const fx = await scriptedEngine(t);
    const p = await project(fx);
    const candidate = await buildAndNominate(fx, p);
    await registered(fx, p, candidate, 'nomination', UNION);
    await changePolicy(fx.engine, p.id, { repair_attempts_max: 0 });
    for (const field of [
      { check_results: [{ check: 'st', exit_status: 0, execution_established: true }] },
      { check_executions: [{ check: 'st', trigger: { source: 'operator_request', id: 'role', generation: 1 } }] },
    ]) {
      const [name] = Object.keys(field);
      const executions = allExecutionCount(fx.home);
      const results = resultCount(fx.home);
      const { run } = await roleRun(fx, p.id, 'verification', { subject: { candidate: candidate.id }, result: field });
      assert.deepEqual([run.outcome, run.reason_class], ['failed', 'invalid_result'], `a result carrying ${name} is invalid (${run.reason_text})`);
      assert.deepEqual([allExecutionCount(fx.home), resultCount(fx.home)], [executions, results], `${name}: nothing registered, nothing recorded`);
    }
  });

  for (const [point, barrier] of [
    ['before', 'nomination.before_finalizer'],
    ['inside', 'checks.registered'],
    ['after', 'nomination.finalized'],
  ]) {
    test(`(e) killed ${point} the nomination's finalizer (${barrier}), then restarted: the checks rows are the discovery; one registration per trigger and key`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await project(fx);
      const version = effectiveVersion(fx.home, p.id);
      await armBarrier(fx.engine, barrier, 'kill');
      fx.scripted.script(p.stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
      await tick(fx.engine, p.id);
      await untilKilled(fx, p.id);
      await fx.start();
      const [candidate] = await waitForCandidates(fx, p.id);
      await registered(fx, p, candidate, 'nomination', UNION);
      await tick(fx.engine, p.id, { rounds: 3 });
      assert.equal(candidatesOf(fx.home, p.id).length, 1, 'one candidate');
      const regs = executionsOf(fx.home, candidate.id);
      assert.deepEqual(regs.map((x) => x.key).sort(), UNION, 'each check of the union registered once');
      assertOncePerTrigger(regs, `killed ${point} the nomination's finalizer`);
      assertChecksAreDiscovery(fx, version.id, DEFS, REQUIRED, 'the effective version');
    });
  }

  for (const [point, barrier] of [
    ['before', 'protected_application.before_finalizer'],
    ['inside', 'checks.registered'],
    ['after', 'protected_application.finalized'],
  ]) {
    test(`(e) killed ${point} the application's finalizer (${barrier}), then restarted: one version, its checks rows the discovery; one registration per trigger and key`, async (t) => {
      const fx = await scriptedEngine(t);
      const defs = { st: DEFS.st, both: DEFS.both };
      const p = await project(fx, { defs, required: null });
      const candidate = await buildAndNominate(fx, p);
      await registered(fx, p, candidate, 'nomination', ['both', 'st']);
      const extra = smoke('extra', { gates: ['stage'] });
      const proposal = await capturedProposal(fx, p, { changeKind: 'tightening', steps: [step.write(defPath('extra'), extra)] });
      const decision = await openDecision(fx, p.id, 'check_correction_tightening', proposal.id);
      await armBarrier(fx.engine, barrier, 'kill');
      await answer(fx.engine, p.id, decision, 'approve').catch(() => null);
      await untilKilled(fx, p.id);
      await fx.start();
      await waitApplied(fx, p, proposal);
      await tick(fx.engine, p.id, { rounds: 3 });
      const versions = protectedVersions(fx.home, p.id).filter((v) => v.proposal === proposal.id);
      assert.equal(versions.length, 1, 'exactly one version results from the proposal');
      assert.equal(effectiveVersion(fx.home, p.id).id, versions[0].id, 'and it is the effective one');
      assert.equal(proposalsOf(fx.home, p.id).find((r) => r.id === proposal.id).status, 'applied');
      assertChecksAreDiscovery(fx, versions[0].id, { ...defs, extra: { kind: 'smoke', gates: ['stage'] } }, null, 'the applied version');
      const regs = executionsOf(fx.home, candidate.id);
      assert.deepEqual(regs.filter((x) => x.trigger?.source === 'protected_application').map((x) => x.key).sort(), ['both', 'extra', 'st'], "the new version's checks registered for the candidate once each");
      assertOncePerTrigger(regs, `killed ${point} the application's finalizer`);
    });
  }
});

