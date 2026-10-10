// M331, out-of-band changes; an unreadable manager (slice 27; sandbox
// lane). M4 plan §3.5 M331; D4-N03, D4-N04; D4 §§2.6, 4.1, 5.5, 6.3, 9.2;
// J6; BS4 §4.1 rules 2, 4, 8; SEAM.md §§257, 290 to 294, 297, 298.
//
// On the real `local_service` adapter, `identity_observation_every` 1. Each
// change on an environment of its own, deployed with its round's check
// exiting 1, made only after its containment read:
//   (a) a manual stop of the environment's unit; a manual restart (its
//       launcher refused: nothing of the application runs again); a unit of
//       a generation no operation names (the test's own stray, SEAM.md
//       §297); a byte changed in the sealed copy. Each an
//       `out_of_band_changes` row with subject `environment`, expected and
//       found, `environment.out_of_band`, and a decision offering `teardown`
//       and `acknowledge` and no `adopt`;
//   (b) meanwhile a deploy request: its preconditions fail (`out_of_band`);
//       and `alpha_complete` carries `OUT_OF_BAND_CHANGE`;
//   (c) each option: `teardown` (an ordinary teardown, the driver's ruling)
//       and `acknowledge` (the persistent marker); and a change to the
//       resource a decision binds stales it;
//   (d) the adapter's bus address pointed at a missing path: every read
//       `unknown`, the condition `unknown`, no out-of-band fact; the manager
//       `running` before and after, never stopped or reloaded; restored, a
//       read succeeds (the control).
// The byte change is last: every environment of the project shares the
// sealed artifact, and no deploy follows it.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 297). This is the slice's file whose
// test acts on units, and it runs last (rule 9). The test stops one unit and
// restarts another, each the engine's own unit of this test's home's prefix
// named in its store's attempt intents, each by its exact name, each only
// after `assertServiceContained` has read from the host that the unit
// carries this home's prefix and the recorded application is in that
// unit's cgroup and in none of the host's namespaces (`stopOwnUnit`,
// `restartOwnUnit`). It creates one stray unit of its own prefix under an
// exact name it first reads `not-found` and removes it by that name. It
// signals no process; the unreadable case changes only the address the
// adapter's own calls use; the user manager is never stopped, restarted,
// reloaded or re-executed; nothing is cleaned by pattern. Every environment
// is ended in `finally`; the file ends with `operatorGuard`; every engine
// start carries the real-adapter switch (`hostDeployable`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { assertStaleAnswer } from './harness/decisions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { CGROUP_ROOT, procsOf } from './harness/sandbox/cgroup.mjs';
import { deploy, operationsOf } from './harness/deploy/kernel.mjs';
import { completion, reasonCodesOf } from './harness/deploy/rounds.mjs';
import {
  armDeployFault,
  assertServiceContained,
  deployHeld,
  endEnvironment,
  hostDeployable,
  hostEnvironment,
  hostUntil,
  managerState,
  operatorGuard,
  releaseCheck,
  restartOwnUnit,
  stopOwnUnit,
  ticksUntil,
  unitShow,
  verificationOf,
} from './harness/deploy/host.mjs';
import { answerOn } from './harness/deploy/recover.mjs';
import { assertOobRow, changeSealedByte, createStrayUnit, historyOf, observeOnHost, oobDecision, oobRows, removeStrays, removeStrayUnit } from './harness/deploy/observe.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1 });

async function deployed(ctx, env) {
  const { op, svc } = await deployHeld(ctx, env);
  releaseCheck(ctx, svc, { get: ['/hello'], exit: 1 });
  await verificationOf(ctx, op);
  return { op, svc };
}

// The processes in a unit's cgroup running the configured start command (host-read).
function applicationsIn(unit) {
  const show = unitShow(unit, ['LoadState', 'ControlGroup']);
  if (show?.LoadState !== 'loaded' || !show.ControlGroup) return [];
  let pids = [];
  try {
    pids = procsOf(`${CGROUP_ROOT}${show.ControlGroup}`);
  } catch {
    return [];
  }
  return pids.filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('server.js');
    } catch {
      return false;
    }
  });
}

// An observation until an out-of-band row of the environment is open; returns it.
async function oobFound(ctx, env, what) {
  for (let i = 0; i < 4; i++) {
    const open = oobRows(ctx.fx.home, env.id).find((r) => r.disposition === null && r.closed_at === null);
    if (open) return open;
    await observeOnHost(ctx, env, ticksUntil);
  }
  assert.fail(`${what}: no out-of-band row was recorded (${JSON.stringify(historyOf(ctx.fx.home, env.id).slice(-3))})`);
}

describe('M331 out-of-band changes on a real unit', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a), (b), (c) a manual stop: recorded out of band; meanwhile a deploy\'s preconditions fail and alpha_complete carries OUT_OF_BAND_CHANGE; teardown requests an ordinary teardown', async () => {
    const env = await hostEnvironment(ctx, 'stopped');
    try {
      const { op, svc } = await deployed(ctx, env);
      assertServiceContained(ctx, svc, 'before the test stops its unit');
      stopOwnUnit(ctx.fx.home, svc.unit);
      const row = await oobFound(ctx, env, 'a manual stop');
      assertOobRow(ctx.fx.home, row, 'a manual stop');
      assert.ok(JSON.stringify(row.found).includes(svc.unit), `found names the unit (${JSON.stringify(row.found)})`);

      const late = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, op.id);
      assert.ok(reasonCodesOf(late).includes('OUT_OF_BAND_CHANGE'), `alpha_complete carries OUT_OF_BAND_CHANGE (J6) (${JSON.stringify(late.reasons)})`);
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const refused = await ticksUntil(ctx.fx, ctx.project, () => operationsOf(ctx.fx.home, ctx.project, 'deploy').find((o) => o.target?.environment === env.id && o.id !== op.id && o.status === 'failed'), { what: 'the deploy requested meanwhile to fail' });
      assert.equal(refused.outcome_detail?.code, 'EFFECT_PRECONDITION_CHANGED', `its preconditions fail (D4 §4.1) (${JSON.stringify(refused.outcome_detail)})`);
      const facts = JSON.parse(readFileSync(recordFile(ctx.fx.home, recordRow(ctx.fx.home, refused.outcome_detail.manifest))).toString('utf8')).facts ?? [];
      assert.ok(facts.some((f) => f.fact === 'out_of_band' && f.held === false), `the manifest records out_of_band not held (${JSON.stringify(facts)})`);

      await answerOn(ctx, oobDecision(ctx.fx.home, row), 'teardown');
      const td = await ticksUntil(ctx.fx, ctx.project, () => operationsOf(ctx.fx.home, ctx.project, 'teardown').find((o) => o.target?.environment === env.id && o.finalized_at), { what: 'the teardown the option asked for' });
      assert.equal(td.linked_prior ?? null, null, 'an ordinary teardown, preempting nothing');
      assert.equal(oobRows(ctx.fx.home, env.id).find((r) => r.id === row.id).disposition, 'teardown');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(a), (c) a manual restart: its launcher refused and nothing of the application running, recorded out of band; acknowledged, the marker stays unresolved', async () => {
    const env = await hostEnvironment(ctx, 'restarted');
    try {
      const { svc } = await deployed(ctx, env);
      const grants = eventsOfType(ctx.fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id).length;
      const invocation = unitShow(svc.unit, ['InvocationID']).InvocationID;
      restartOwnUnit(ctx, svc);
      await hostUntil(() => unitShow(svc.unit, ['InvocationID'])?.InvocationID !== invocation, { timeoutMs: 60_000, what: 'a new invocation of the unit' });
      await hostUntil(() => applicationsIn(svc.unit).length === 0, { timeoutMs: 60_000, what: 'nothing of the application running in the restarted unit' });
      assert.equal(eventsOfType(ctx.fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id).length, grants, 'the launch is single-use: no second grant (D4 §9.2)');
      const row = await oobFound(ctx, env, 'a manual restart');
      assertOobRow(ctx.fx.home, row, 'a manual restart');
      await answerOn(ctx, oobDecision(ctx.fx.home, row), 'acknowledge');
      const acked = oobRows(ctx.fx.home, env.id).find((r) => r.id === row.id);
      assert.deepEqual([acked.disposition, acked.acknowledged?.unresolved_until_replacement, acked.closed_at], ['acknowledge', true, null], `acknowledged, unresolved until a replacement (${JSON.stringify(acked)})`);
      assert.notEqual((await observeOnHost(ctx, env, ticksUntil)).condition, 'healthy', 'the environment is not healthy after an acknowledgment');
      assert.equal(applicationsIn(svc.unit).length, 0, 'host-read: nothing of the application runs');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(a), (c) a unit of a generation no operation names: recorded out of band; the unit changed again stales the decision', async () => {
    const env = await hostEnvironment(ctx, 'stray');
    try {
      await deployed(ctx, env);
      const stray = createStrayUnit(ctx.fx.home, env.id, 90);
      const row = await oobFound(ctx, env, 'a stray unit');
      const previewed = assertOobRow(ctx.fx.home, row, 'a stray unit');
      assert.ok(JSON.stringify(row.found).includes(stray), `found names the stray (${JSON.stringify(row.found)})`);
      assert.ok(previewed.manifest && 'resources' in previewed.manifest && 'observation' in previewed.manifest, `the decision binds the resources it names and the observation it rests on (D4 §6.3) (${JSON.stringify(previewed.manifest)})`);
      assert.equal(removeStrayUnit(ctx.fx.home, stray), 'not-found', 'the stray removed by its exact name');
      await observeOnHost(ctx, env, ticksUntil);
      await assertStaleAnswer(ctx.fx, ctx.project, previewed, 'acknowledge');
    } finally {
      removeStrays(ctx.fx.home);
      await endEnvironment(ctx, env);
    }
  });

  test('(d) the manager unreadable: every read unknown, the condition unknown, no out-of-band fact, the manager running before and after; restored, healthy', async () => {
    const env = await hostEnvironment(ctx, 'unreadable');
    try {
      await deployed(ctx, env);
      assert.equal(managerState(), 'running', 'the manager is running before');
      await armDeployFault(ctx, env, 'bus_address_missing_until_cleared');
      const row = await observeOnHost(ctx, env, ticksUntil);
      assert.equal(row.condition, 'unknown', `the condition is unknown (D4-N04) (${row.condition})`);
      assert.equal(row.facts?.status ?? null, null, `the status read is unread (${JSON.stringify(row.facts)})`);
      assert.ok(row.facts?.identity === null || row.facts.identity.observation !== row.id || row.facts.identity.match === 'unread', 'no identity read made in it reads anything');
      assert.deepEqual(oobRows(ctx.fx.home, env.id), [], 'no out-of-band fact from an unreadable manager');
      assert.equal(managerState(), 'running', 'the manager is running after: never stopped or reloaded');
      await armDeployFault(ctx, env, 'bus_address_cleared');
      assert.equal((await observeOnHost(ctx, env, ticksUntil)).condition, 'healthy', 'restored: healthy (the control)');
    } finally {
      await armDeployFault(ctx, env, 'bus_address_cleared').catch(() => undefined);
      await endEnvironment(ctx, env);
    }
  });

  test('(a) a byte changed in the sealed copy: the identity read differs, recorded out of band (last: no deploy follows)', async () => {
    const env = await hostEnvironment(ctx, 'changed');
    try {
      await deployed(ctx, env);
      changeSealedByte(ctx.fx.home, ctx.project);
      const row = await oobFound(ctx, env, 'a byte changed in the sealed copy');
      assertOobRow(ctx.fx.home, row, 'a byte changed in the sealed copy');
    } finally {
      await endEnvironment(ctx, env);
    }
  });
});
