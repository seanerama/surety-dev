// M332, secret delivery to the service and to checks (slice 28; sandbox
// lane). M4 plan §3.6 M332; D4-S01, D4-S02; D4 §§7.1, 7.2, 9.2; E116; E127
// item 7 (m3); the driver's rulings on the slice-28 Builder's design;
// SEAM.md §§256 to 259, 268, 310 to 312.
//
// Four disposable deployment secrets, random values the test makes in 0600
// files of a directory of its own, held by the engine from `--secret-file`
// at every start: two the service's configuration maps to variables
// (`secrets`), one the environment allows checks and `behaves` names, one
// the environment allows and no definition names (`check_secrets`).
//   (c) a role run of the project dispatched after the configuration: its
//       capability grant names none of the references, and its context
//       package (read from the host through the role's own root) holds no
//       value;
//   (a) the service's environment (`/proc/<pid>/environ`, host-read) holds
//       exactly the configured variables with their values, and no other
//       held value; the launcher's and the init's command lines and
//       environments hold none;
//   (d) `behaves` (naming the allowed reference) receives it as
//       `SURETY_SECRET_<NAME>` and nothing else held, its execution's
//       `secret_refs` naming it; `nosecret`, naming a reference the
//       environment does not allow checks, is not run, `secret_not_allowed`,
//       reaching nothing through the link; the reference no definition names
//       is delivered to no check; a workspace check (`smoke`, run by the
//       operator after the configuration) receives none;
//   (b) no value, raw or JSON-escaped, in the unit's properties
//       (`systemctl --user show`), its transient unit file, its journal, the
//       engine home (store, records, events, the run directory), the
//       engine's output, or any response the test received;
//   E127's m3: a launch request on the launch socket naming a pid that is
//       not its peer (the held real launcher's pid and cgroup, sent by the
//       test's own process) is refused with nothing delivered (no `spec`,
//       grant, plan or backend; no value); one naming the test's own pid,
//       which is no launcher of the unit, likewise; the launch stays
//       `authorizable`, no grant recorded; the real launcher, released,
//       is granted and its service holds its value (the control).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 312). Every unit is the engine's,
// under this test's home's prefix; the test acts on none. The forged launch
// requests are connections from the test's own process to its own engine's
// socket; they signal nothing. Values are compared in memory, never printed.
// The role run is stopped through the engine. Every environment is ended in
// `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { addItem } from './harness/gitruns.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { requestTick, stopRun, waitForRunState } from './harness/runs.mjs';
import { roleHolding } from './harness/sandbox/lane.mjs';
import { withStore } from './harness/store.mjs';
import { heldExecution, requestChecks } from './harness/checks/fixtures.mjs';
import { armBarrier, attemptIntent, attemptsOf, configure, deploy, releaseBarrier } from './harness/deploy/kernel.mjs';
import { barriersOf, waitingAt } from './harness/deploy/recover.mjs';
import {
  cmdlineOf,
  endCase,
  environOf,
  filesHoldingAny,
  heldCheck,
  holdsAny,
  hostConfig,
  hostDeployable,
  journalOf,
  newestOperation,
  operatorGuard,
  postDeployOf,
  releaseCheck,
  secretArgs,
  secretFile,
  serviceLinkLogs,
  serviceOf,
  testSecret,
  ticksUntil,
  transientUnitText,
  unitShow,
  unitShowAll,
  valueForms,
  verificationOf,
} from './harness/deploy/host.mjs';

const REF = Object.freeze({ a: 'deploy/m332_svc_a', b: 'deploy/m332_svc_b', chk: 'deploy/m332_chk', other: 'deploy/m332_other' });
const CHECK_VAR = 'SURETY_SECRET_M332_CHK';
const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const EXIT_1 = Object.freeze({ get: ['/hello'], exit: 1 });
const WS_HOLD = 'ws';

const resultOf = (home, execution) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(execution));
const executionRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every regular file under a directory read from the host, as text (bounded).
function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size <= 4 * 1024 * 1024) out.push({ path: relative(root, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}

// One connection to the engine's launch socket from the test's own process:
// `hello` sent, everything the engine sends read until it closes or
// `timeoutMs` passes. Returns {how, bytes, messages}.
function forgeLaunch(home, hello, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const received = [];
    let done = false;
    const sock = net.createConnection(join(home, 'run', 'launch.sock'));
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      const bytes = Buffer.concat(received);
      const messages = bytes
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { unparsed: true };
          }
        });
      resolve({ how, bytes: bytes.toString('utf8'), messages });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(hello)}\n`));
    sock.on('data', (d) => received.push(d));
    sock.on('end', () => finish('closed'));
    sock.on('close', () => finish('closed'));
    sock.on('error', (e) => finish(`error ${e.code}`));
  });
}

describe('M332 secret delivery to the service and to checks', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  let dir;
  let values;
  const responses = [];
  before(async () => {
    guard = operatorGuard();
    dir = guard.root(makeTempDir('m332-secrets'));
    values = { a: testSecret('m332-a'), b: testSecret('m332-b'), chk: testSecret('m332-chk'), other: testSecret('m332-other') };
    const files = Object.fromEntries(Object.entries(REF).map(([k, ref]) => [ref, secretFile(dir, k, values[k])]));
    ctx = await hostDeployable(shared.context, guard, {
      everyStart: secretArgs(files),
      policy: POLICY,
      behavesFields: { secrets: [REF.chk] },
      extraChecks: { nosecret: { hold: 'nosecret', secrets: [REF.a] } },
      workspaceHold: WS_HOLD,
    });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
      removeDir(dir);
    }
  });

  // An environment configured with the four references; returns {id, name, content}.
  async function secretEnvironment(name) {
    const content = await hostConfig({ secrets: { APP_TOKEN: REF.a, DB_TOKEN: REF.b }, check_secrets: [REF.chk, REF.other] });
    const done = await configure(ctx.fx.engine, ctx.project, name, content);
    responses.push(JSON.stringify(done));
    const env = { ...done.environment, name, content };
    ctx.envs[name] = env;
    return env;
  }

  test('(c) a role run after the configuration: its grant names no reference, its context package holds no value', async () => {
    await secretEnvironment('roles');
    const item = await addItem(ctx.fx, ctx.project, 'fix');
    const role = await roleHolding(ctx.fx, ctx.project, item);
    try {
      const grants = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "capability_grants" WHERE "run" = ?').all(role.run.id));
      assert.ok(grants.length > 0, 'the fixture is live: the run was granted');
      for (const g of grants) {
        const text = `${g.capabilities} ${g.env_allowlist} ${g.secret_refs ?? ''}`;
        for (const ref of Object.values(REF)) assert.ok(!text.includes(ref), `no role grant names a deployment secret (D4 §7.2) (${ref} in grant ${g.id})`);
        assert.deepEqual(holdsAny(text, values), [], 'nor holds a value');
      }
      const pkg = filesUnder(`/proc/${role.member.pid}/root/surety/context`);
      assert.ok(pkg.length > 0, 'the fixture is live: the role\'s context package is read through its own root');
      for (const f of pkg) assert.deepEqual(holdsAny(f.text, values), [], `the context package's ${f.path} holds no secret value (D4 §7.2)`);
    } finally {
      await stopRun(ctx.fx.engine, ctx.project, role.run.id).catch(() => undefined);
      await waitForRunState(ctx.fx.home, role.run.id, 'ended', { timeoutMs: 60_000 }).catch(() => undefined);
    }
  });

  test('(a), (b), (d) the service holds exactly its variables; behaves receives its allowed reference only; nosecret is secret_not_allowed; the unnamed reference reaches no check; a workspace check receives none; no value anywhere but the service and the engine', async () => {
    const env = await secretEnvironment('alpha');
    try {
      const request = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      responses.push(JSON.stringify(request));
      const held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env, { key: 'behaves' }), { timeoutMs: 300_000, what: 'behaves to hold' });
      const op = newestOperation(ctx, env);
      const svc = serviceOf(ctx, env, op);

      // (a) the service's environment, host-read.
      const environ = environOf(svc.app.pid);
      assert.ok(environ, `host-read: the application's environment (pid ${svc.app.pid})`);
      assert.ok(environ.APP_TOKEN === values.a && environ.DB_TOKEN === values.b, '(a) the configured variables hold their values (compared in memory)');
      const others = Object.entries(environ).filter(([k]) => !['APP_TOKEN', 'DB_TOKEN'].includes(k)).map(([k, v]) => `${k}=${v}`).join('\n');
      assert.deepEqual(holdsAny(others, values), [], '(a) no other variable holds a held value: exactly the configured secret variables');
      const launcher = Number(unitShow(svc.unit, ['MainPID'])?.MainPID);
      for (const [who, pid] of [['the launcher', launcher], ['the init', svc.init.pid]]) {
        if (!Number.isInteger(pid) || pid <= 1) continue;
        const env2 = environOf(pid);
        const text = `${(() => { try { return cmdlineOf(pid).join(' '); } catch { return ''; } })()}\n${env2 ? Object.entries(env2).map(([k, v]) => `${k}=${v}`).join('\n') : ''}`;
        assert.deepEqual(holdsAny(text, values), [], `(a) ${who}'s command line and environment hold no value (the value travels on the launch reply only, D4 §7.2)`);
      }

      // (d) behaves: SURETY_SECRET_<NAME> and nothing else held.
      const checkEnv = environOf(held.member.pid);
      assert.ok(checkEnv, 'host-read: the check\'s environment');
      assert.ok(checkEnv[CHECK_VAR] === values.chk, `(d) behaves receives the reference it names and the environment allows, as ${CHECK_VAR}`);
      const rest = Object.entries(checkEnv).filter(([k]) => k !== CHECK_VAR).map(([k, v]) => `${k}=${v}`).join('\n');
      assert.deepEqual(holdsAny(rest, values), [], '(d) and no other held value: not the reference no definition names, not the service\'s');
      const x = executionRow(ctx.fx.home, held.execution.id);
      assert.deepEqual(JSON.parse(x.secret_refs ?? '[]'), [REF.chk], `(d) the execution records the reference delivered, never a value (${x.secret_refs})`);

      // (d) nosecret: not run, secret_not_allowed, nothing through the link.
      const nosecret = await ticksUntil(ctx.fx, ctx.project, () => {
        const n = postDeployOf(ctx, env).find((e) => e.key === 'nosecret' && e.deployment?.operation === op.id);
        return n && resultOf(ctx.fx.home, n.id) ? n : undefined;
      }, { what: 'nosecret\'s result' });
      const nr = resultOf(ctx.fx.home, nosecret.id);
      assert.deepEqual([nr.execution_established, nr.not_run_reason], [0, 'secret_not_allowed'], `(d) a reference the environment does not allow checks: not run, secret_not_allowed (D4 §7.2) (${JSON.stringify(nr)})`);
      assert.ok(!serviceLinkLogs(ctx.fx.home, ctx.project).some((l) => l.entries.some((e) => e.execution === nosecret.id)), '(d) and it reached nothing through the link');

      releaseCheck(ctx, svc, EXIT_1);
      await verificationOf(ctx, op);

      // (d) a workspace check after the configuration receives none.
      rmSync(join(ctx.prog.releaseDir, WS_HOLD), { force: true });
      const asked = await requestChecks(ctx.fx.engine, ctx.project, ctx.candidate.id, { keys: ['smoke'] });
      responses.push(asked.text);
      assert.equal(asked.status, 202, `the operator registers the workspace check (${asked.text})`);
      const ws = await heldExecution(ctx.fx, ctx.project, ctx.candidate.id, { smoke: WS_HOLD });
      try {
        const wsEnv = environOf(ws.member.pid);
        assert.ok(wsEnv, 'host-read: the workspace check\'s environment');
        assert.ok(!Object.keys(wsEnv).some((k) => k.startsWith('SURETY_SECRET_')), '(d) a workspace check receives no deployment secret');
        assert.deepEqual(holdsAny(Object.entries(wsEnv).map(([k, v]) => `${k}=${v}`).join('\n'), values), [], '(d) and no value');
      } finally {
        writeFileSync(join(ctx.prog.releaseDir, WS_HOLD), '');
      }

      // (b) no value anywhere but the service's environment and the engine.
      const forms = Object.values(values).flatMap(valueForms);
      const places = [
        ['the unit\'s properties (systemctl --user show)', unitShowAll(svc.unit)],
        ['its transient unit file', transientUnitText(svc.unit) ?? ''],
        ['its journal', journalOf(svc.unit).text],
        ['the engine\'s output', ctx.fx.engines.map((e) => `${e.output().stdout}${e.output().stderr}`).join('')],
        ['the responses', responses.join('\n')],
      ];
      for (const [what, text] of places) assert.deepEqual(holdsAny(text, values), [], `(b) ${what} hold no value (D4-S01)`);
      assert.deepEqual(filesHoldingAny(ctx.fx.home, forms), [], '(b) no file of the engine home (store, records, events, run directory) holds a value, and every one was read');
    } finally {
      await endCase(ctx, env);
    }
  });

  test('E127 m3: a launch request naming a pid that is not its peer is refused with nothing delivered; the real launcher, released, is granted', async () => {
    const env = await secretEnvironment('peer');
    try {
      await armBarrier(ctx.fx.engine, 'launcher.before_authorization', 'pause');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      for (let i = 0; i < 6 && !(await barriersOf(ctx.fx.engine)).some((b) => b.name === 'launcher.before_authorization' && b.state === 'waiting'); i++) {
        await requestTick(ctx.fx.engine, ctx.project);
        await sleep(2000);
      }
      await waitingAt(ctx.fx.engine, 'launcher.before_authorization');
      const op = newestOperation(ctx, env);
      const [attempt] = attemptsOf(ctx.fx.home, op.id);
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      const show = unitShow(unit, ['MainPID', 'ControlGroup']);
      const launcherPid = Number(show?.MainPID);
      assert.ok(launcherPid > 1, `the fixture is live: the unit's launcher waits (MainPID ${show?.MainPID})`);
      const domain = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "attempt" = ?').get(attempt.id));
      const hello = { t: 'hello', profile: 'service', attempt: attempt.id, domain: domain?.id, incarnation: attempt.incarnation, lease_generation: attempt.capability?.lease_generation, cgroup: join('/sys/fs/cgroup', show.ControlGroup) };

      for (const [what, pid] of [['the held launcher\'s pid, sent by the test\'s own process', launcherPid], ['the test\'s own pid, no launcher of the unit', process.pid]]) {
        const forged = await forgeLaunch(ctx.fx.home, { ...hello, pid });
        const kinds = forged.messages.map((m) => m.t);
        assert.ok(!kinds.some((k) => ['spec', 'granted', 'plan', 'backend', 'start', 'tunnel'].includes(k)), `${what}: nothing is delivered (received ${JSON.stringify(kinds)})`);
        assert.deepEqual(holdsAny(forged.bytes, values), [], `${what}: no value reaches it`);
        assert.ok(kinds.includes('refused') || forged.how !== 'timeout', `${what}: the request is refused (${forged.how}; ${JSON.stringify(kinds)})`);
      }
      assert.equal(attemptsOf(ctx.fx.home, op.id)[0].launch_state, 'authorizable', 'the launch is still authorizable: no forged request spent it');
      assert.deepEqual(eventsOfType(ctx.fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === attempt.id), [], 'no grant recorded');

      // The control: the real launcher, released, is granted, and its service holds its value.
      await releaseBarrier(ctx.fx.engine, 'launcher.before_authorization');
      const granted = await ticksUntil(ctx.fx, ctx.project, () => attemptsOf(ctx.fx.home, op.id)[0]?.app_instance ?? undefined, { what: 'the real launcher\'s grant and the application\'s start' });
      assert.ok(environOf(granted.pid)?.APP_TOKEN === values.a, 'the real launcher passes the same check: its service holds its value');
      await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env, { key: 'behaves' }), { timeoutMs: 300_000, what: 'the round\'s check to hold' });
      releaseCheck(ctx, serviceOf(ctx, env, op), EXIT_1);
      await verificationOf(ctx, op);
    } finally {
      await releaseBarrier(ctx.fx.engine, 'launcher.before_authorization').catch(() => undefined);
      await endCase(ctx, env);
    }
  });
});
