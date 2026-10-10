// M311, identity from the target (slice 24; sandbox lane). M4 plan §3.2
// M311 (a) to (g); D4 §3.4, D4-I05; RV1; E110; BS4 §11.1 CD4 (confirmed,
// E121 item 2); SEAM.md §§256 to 259, 262. Case (h), the read's duration at
// the artifact bounds, is `M311-the-identity-reads-duration.test.mjs`.
//
// One engine and one project; each case deploys to an environment of its
// own, acts while the round's post-deploy check holds between the two
// identity reads (or at the barrier between a read's snapshot halves), and
// reads the round's verification row:
//   (a) the chain: the launcher and the init are never the application; the
//       init's report and the host read agree; an altered report (the fault
//       `init_report_altered`) is `conflicting` and binds nothing;
//   (b) the application exits while a descendant keeps its port with its
//       output closed: the domain terminal, no descendant bound in its place;
//   (c) the recorded start time no longer matching (the fault
//       `identity_start_time`); an `exec` into another program; an `exec`
//       with other arguments; an exited application; a restarted unit (the
//       test's own, by exact name): each `differs` or `unread`, never `match`;
//   (d) the unit restarted between a read's snapshot halves: `unread` or
//       `differs`, never a mixed `match`;
//   (e) a forged version string changes nothing; a byte changed in the
//       sealed copy `differs`; an unreadable process (the fault
//       `identity_proc_unreadable`) `unread`;
//   (f) a re-exec of the same runtime with identical arguments: `match`, which
//       D4 §3.4 and §11 class C do not claim to detect (labelled, not evidence);
//   (g) CD4: the service sets `process.title`: `differs`, the detail naming
//       `argv`, the verification `failed`; and the Builder's package for a
//       project with an environment states that the service must not change
//       its process title or arguments.
// Not here: "another generation" of (e), whose sandbox form needs a second
// generation running between one round's reads; it is slice 25's (M316 (d),
// M318 (a); COVERAGE.md).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258). Every unit is the engine's,
// under this test's home's prefix. The fixture service's acts (`detach`,
// `exec-program`, `exec-args`, `exit`, `reexec-same`, `title`) are released
// only after `assertServiceContained` has read the service's containment
// from the host (the test's half) and run only when the service reads
// itself contained (its half); none signals anything. The test restarts a
// unit only by its exact name, after the same read, and stops a unit only by
// its exact name when the engine cannot tear it down (an ambiguous attempt
// holds the lease). Nothing is signalled. The file ends with the operator's
// guard (row M313). Its first engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';
import { CGROUP_ROOT } from './harness/sandbox/cgroup.mjs';
import { hostProcess } from './harness/sandbox/procs.mjs';
import { armBarrier, artifactsOf, attemptsOf, deploy, releaseBarrier, roundsOf, tickToBarrier } from './harness/deploy/kernel.mjs';
import {
  RUNTIME,
  armDeployFault,
  cmdlineOf,
  endEnvironment,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  newestOperation,
  operatorGuard,
  ppidOf,
  procInstance,
  releaseCheck,
  restartOwnUnit,
  serviceDomainOf,
  serviceOf,
  settleRound,
  targetReport,
  ticksUntil,
  unitShow,
  verificationOf,
} from './harness/deploy/host.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readOf = (row, bracket) => row.identity_reads.find((r) => r.bracket === bracket);
const neverMatch = (read, what) => {
  assert.ok(read, `${what}: the read is recorded`);
  assert.ok(['differs', 'unread'].includes(read.match), `${what}: differs or unread, never match (${JSON.stringify(read)})`);
};

// Host processes whose command line carries `marker` and whose cgroup lies under the unit's.
function survivorsOf(unit, marker) {
  const out = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (!argv.includes(marker)) continue;
      const cg = readFileSync(`/proc/${name}/cgroup`, 'utf8');
      if (cg.includes(`/${unit}`)) out.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
}

describe('M311 identity from the target', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  // Deploy to a new environment `name`; held between the round's reads. Returns {env, op, svc, held}.
  async function heldDeploy(name, over = {}) {
    const env = await hostEnvironment(ctx, name, over);
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    const held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env), { what: `the round of ${name} to hold its check` });
    const op = newestOperation(ctx, env);
    return { env, op, svc: serviceOf(ctx, env, op), held };
  }

  // Release the held check with `paths` (acts released after the containment read), then the row.
  async function actThenRow(h, paths, exit = 0) {
    releaseCheck(ctx, h.svc, { get: paths, exit });
    const { row } = await verificationOf(ctx, h.op);
    return row;
  }

  test('(a), (e) the chain: the launcher and the init are never the application, the init\'s report and the host read agree; a forged version string changes nothing (both reads match)', async () => {
    const h = await heldDeploy('chain');
    const { svc } = h;
    const main = Number(unitShow(svc.unit, ['MainPID']).MainPID);
    assert.ok(![main, svc.init.pid].includes(svc.app.pid), 'the application is neither MainPID (the launcher) nor the init');
    assert.equal(ppidOf(svc.init.pid), main, 'the init is the launcher\'s child');
    assert.equal(hostProcess(svc.init.pid)?.innerPid, 1, 'with innermost NSpid 1');
    assert.equal(ppidOf(svc.app.pid), svc.init.pid, 'the application is the init\'s child');
    assert.deepEqual([svc.app.pid, svc.app.start_time], [procInstance(svc.app.pid).pid, procInstance(svc.app.pid).start_time], 'the recorded instance is the host read');
    assert.deepEqual(cmdlineOf(svc.app.pid), h.env.content.start, 'running the start command');
    // The check fails on purpose (exit 1), so the candidate stays developing for the cases after this one.
    const row = await actThenRow(h, ['/version', '/hello'], 1);
    const version = targetReport(ctx, h.held.execution).report.results.find((r) => r.path === '/version');
    assert.match(version?.body ?? '', /forged-/, 'the service answered a made-up version');
    assert.deepEqual([readOf(row, 'first')?.match, readOf(row, 'second')?.match], ['match', 'match'], 'the string changed nothing: both reads match the sealed digest');
    await endEnvironment(ctx, h.env);
  });

  test('(a) an altered init report (fault init_report_altered): conflicting; no application instance bound; nothing verified', async () => {
    const env = await hostEnvironment(ctx, 'altered');
    await armDeployFault(ctx, env, 'init_report_altered');
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    const attempt = await ticksUntil(ctx.fx, ctx.project, () => {
      const op = newestOperation(ctx, env);
      const a = op ? attemptsOf(ctx.fx.home, op.id).at(-1) : undefined;
      return a && (a.reconciliation_reads ?? []).length > 0 ? a : undefined;
    }, { what: 'the attempt to be reconciled' });
    assert.equal(attempt.reconciliation_reads.at(-1)?.result, 'conflicting', `the disagreeing report is conflicting (${JSON.stringify(attempt.reconciliation_reads.at(-1))})`);
    assert.notEqual(attempt.status, 'succeeded', 'the attempt is not succeeded');
    assert.equal(attempt.app_instance ?? null, null, 'no application instance is bound');
    assert.deepEqual(roundsOf(ctx.fx.home, newestOperation(ctx, env).id), [], 'no round: nothing verified');
    await endEnvironment(ctx, env, { engineTeardown: false });
  });

  test('(b) the application exits while a descendant keeps its port with its output closed: never match; the domain terminal; no descendant bound in its place, none left', async () => {
    const h = await heldDeploy('detach');
    const before = { ...h.svc.app };
    const row = await actThenRow(h, ['/act/detach']);
    neverMatch(readOf(row, 'second'), 'the second read');
    assert.notEqual(row.outcome, 'verified');
    const domain = await ticksUntil(ctx.fx, ctx.project, () => {
      const d = serviceDomainOf(ctx.fx.home, h.svc.attempt.id);
      return d?.state === 'terminated' ? d : undefined;
    }, { timeoutMs: 120_000, what: 'the service domain to be terminated' });
    assert.equal(domain.state, 'terminated');
    const after = attemptsOf(ctx.fx.home, h.op.id).at(-1).app_instance;
    assert.deepEqual([after?.pid, after?.start_time], [before.pid, before.start_time], 'the original instance stays recorded: no descendant bound in its place');
    let left = survivorsOf(h.svc.unit, '--detached-child');
    for (let i = 0; i < 40 && left.length > 0; i++) {
      await sleep(500);
      left = survivorsOf(h.svc.unit, '--detached-child');
    }
    assert.deepEqual(left, [], 'the descendant ended with the domain');
    await endEnvironment(ctx, h.env);
  });

  test('(c) the recorded start time no longer matching the pid (fault identity_start_time on the second read): never match', async () => {
    const h = await heldDeploy('skew');
    await armDeployFault(ctx, h.env, 'identity_start_time');
    const row = await actThenRow(h, ['/hello']);
    neverMatch(readOf(row, 'second'), 'the second read');
    assert.notEqual(row.outcome, 'verified');
    await endEnvironment(ctx, h.env);
  });

  for (const [name, act, what] of [
    ['exec-program', '/act/exec-program', 'an exec into another program'],
    ['exec-args', '/act/exec-args', 'an exec of the runtime with other arguments'],
    ['exit', '/act/exit', 'the application exited'],
  ]) {
    test(`(c) ${what}: never match`, async () => {
      const h = await heldDeploy(name);
      const row = await actThenRow(h, [act]);
      neverMatch(readOf(row, 'second'), `${what}, the second read`);
      assert.notEqual(row.outcome, 'verified');
      await endEnvironment(ctx, h.env);
    });
  }

  test('(c) the unit restarted by the test (exact name): the launch is spent, nothing of the application runs; never match', async () => {
    const h = await heldDeploy('restart');
    restartOwnUnit(ctx, h.svc);
    await sleep(3000);
    assert.equal(procInstance(h.svc.app.pid)?.start_time === h.svc.app.start_time, false, 'the original application is gone');
    const cg = unitShow(h.svc.unit, ['ControlGroup'])?.ControlGroup;
    if (cg) {
      let pids = [];
      try {
        pids = readFileSync(join(CGROUP_ROOT, cg, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number);
      } catch {
        pids = [];
      }
      assert.deepEqual(pids.filter((p) => {
        try {
          return JSON.stringify(cmdlineOf(p)) === JSON.stringify(h.env.content.start);
        } catch {
          return false;
        }
      }), [], 'no process of the restarted unit runs the start command: the second launch was refused');
    }
    const row = await actThenRow(h, ['/hello']);
    neverMatch(readOf(row, 'second'), 'after the restart, the second read');
    assert.notEqual(row.outcome, 'verified');
    await endEnvironment(ctx, h.env);
  });

  test('(d) the unit restarted between the snapshot halves of the first read: unread or differs, never a mixed match', async () => {
    const env = await hostEnvironment(ctx, 'halves');
    const { fx, project } = ctx;
    await armBarrier(fx.engine, 'deploy.round_registered', 'pause');
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    await tickToBarrier(fx, project, 'deploy.round_registered', { attempts: 40 });
    await armBarrier(fx.engine, 'identity.between_halves', 'pause');
    await releaseBarrier(fx.engine, 'deploy.round_registered');
    await tickToBarrier(fx, project, 'identity.between_halves', { attempts: 20 });
    const op = newestOperation(ctx, env);
    const svc = serviceOf(ctx, env, op);
    restartOwnUnit(ctx, svc);
    await releaseBarrier(fx.engine, 'identity.between_halves');
    const { row } = await settleRound(ctx, env, op);
    neverMatch(readOf(row, 'first'), 'the first read, changed between its halves');
    assert.notEqual(row.outcome, 'verified');
    await endEnvironment(ctx, env);
  });

  test('(e) an unreadable application process (fault identity_proc_unreadable on the second read): unread; not verified', async () => {
    const h = await heldDeploy('unreadable');
    await armDeployFault(ctx, h.env, 'identity_proc_unreadable');
    const row = await actThenRow(h, ['/hello']);
    assert.equal(readOf(row, 'second')?.match, 'unread', `the second read is unread (${JSON.stringify(readOf(row, 'second'))})`);
    assert.equal(row.outcome, 'unknown', 'unread is unknown, never failed or verified');
    await endEnvironment(ctx, h.env);
  });

  test('(f) a re-exec of the same runtime with identical arguments: match, the same instance; labelled not claimed (D4 §3.4, §11 class C), never evidence', async () => {
    const h = await heldDeploy('reexec');
    const row = await actThenRow(h, ['/act/reexec-same'], 1);
    await sleep(500);
    const second = readOf(row, 'second');
    assert.equal(second?.match, 'match', 'the read does not tell a same-runtime, same-argument re-exec apart: not claimed');
    assert.deepEqual([second.instance?.pid, second.instance?.start_time], [h.svc.app.pid, h.svc.app.start_time], 'the pid and start time are unchanged');
    await endEnvironment(ctx, h.env);
  });

  test('(g) CD4: the service sets process.title: the second read differs, its detail naming argv; the verification failed', async () => {
    const h = await heldDeploy('title');
    const row = await actThenRow(h, ['/act/title']);
    const second = readOf(row, 'second');
    assert.equal(second?.match, 'differs', `the changed title reads differs (${JSON.stringify(second)})`);
    assert.equal(second.detail?.field, 'argv', `the detail names the arguments (SEAM.md §259 †) (${JSON.stringify(second.detail)})`);
    assert.equal(row.outcome, 'failed', 'the verification failed');
    await endEnvironment(ctx, h.env);
  });

  test('(e) a byte changed in the sealed copy between the reads: differs; failed (an artifact of its own, so no other case reads the changed copy)', async () => {
    const h = await heldDeploy('byte', { artifact: { exclude: ['README.md'] } });
    const artifact = artifactsOf(ctx.fx.home, ctx.project).find((a) => a.digest === h.op.subject?.artifact_digest);
    const path = join(artifact.path, 'server.js');
    chmodSync(path, 0o644);
    appendFileSync(path, '// changed between the reads\n');
    chmodSync(path, 0o444);
    const row = await actThenRow(h, ['/hello']);
    assert.equal(readOf(row, 'second')?.match, 'differs', 'the second read differs');
    assert.equal(row.outcome, 'failed');
    await endEnvironment(ctx, h.env);
  });

  test("(g) CD4: the Builder's package for a project with an environment states what the configuration fixes and that the service must not change its process title or arguments", async () => {
    await hostEnvironment(ctx, 'package', { artifact: { exclude: ['docs/'] } });
    const item = await addItem(ctx.fx, ctx.project, 'fix');
    ctx.fx.scripted.script(item, [roleThat([step.probe('context_dump')])]);
    await runToEnd(ctx.fx, ctx.project, item, { timeoutMs: 120_000 });
    const launch = ctx.fx.scripted.launches({ work_item: item })[0];
    const [dump] = ctx.fx.scripted.probes(launch.invocation, 'context_dump');
    assert.equal(dump?.outcome, 'dumped', `the Builder read its package (${dump?.error})`);
    const told = dump.files.filter((f) => !['result-schema.json', 'manifest.json'].includes(f.name) && typeof f.text === 'string').map((f) => f.text).join('\n');
    const sentences = told.split(/\n|(?<=[.;:])\s+/).map((x) => x.trim()).filter(Boolean);
    const missing = [];
    const need = (what, ok) => {
      if (!ok) missing.push(what);
    };
    need('the runtime the configuration pins', told.includes(RUNTIME.path));
    need("the start command's entry point (server.js)", told.includes('server.js'));
    need('the port variable (PORT)', /\bPORT\b/.test(told));
    need('the excludes (docs/)', told.includes('docs/'));
    need('that the service must not change its process title or arguments (CD4)', sentences.some((x) => /\b(process title|title|arguments|argv)\b/i.test(x) && /\b(must not|never|do not|does not|should not|may not)\b/i.test(x) && /\b(chang|rewrit|set|modif)/i.test(x)));
    assert.deepEqual(missing, [], `the Builder's package is missing what a project with an environment requires (files: ${dump.files.map((f) => f.name).join(', ')})`);
  });
});
