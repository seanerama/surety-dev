// M314, the service link under a long engine home (M4 slice 30; sandbox
// lane). Objection 055 and the driver's ruling on it (2026-10-11); M4 plan
// §3.3 M314; D4 §§5.1, 5.2; D4 §11.5 (a refusal says why); SEAM.md §§1, 256
// to 258, 268, 340.
//
// A pathname unix socket's address holds at most 107 bytes (sun_path). On
// main at b9c835b the engine bound a post-deploy check's service link at
// `$SURETY_HOME/run/<env>-g<n>-link-<10>.sock` (59 bytes past the home for
// g1) with no check of its length: Node binds a longer path cut to 107 bytes
// and still reports it listening, the check's mount plan then cannot lstat
// the path the engine recorded, and the check is recorded `interrupted`
// with the reason "the engine restarted before the check's exit report was
// recorded", though no engine restarted. The ruling: the link gets a short
// name; every socket path is length-checked before bind and connect and
// refused loudly, never truncated; the engine refuses to start, in the
// start-refusal form, when its home is too long for its socket paths.
//
//   (a) under a home of LONG_HOME_BYTES (52) bytes, past the old link name's
//       bound (59 + 52 = 111 > 107) but within the start limit, a deploy's
//       post-deploy check reaches the service through the link: the socket
//       the check's mount plan names exists, is a socket, and fits; the
//       report's GET answers 200 through SURETY_TARGET_APP; the link log
//       holds an accepted entry; the round is `verified`;
//   (b) a home longer than a socket address can hold at all (more than 107
//       bytes) is refused at start, in the existing form (exit 6, one
//       refusal line with code, reason, what_to_do and subject, no stack
//       trace), the refusal naming sockets and a byte limit; nothing is
//       bound under the home and no unit of the home's prefix exists;
//   (c) no check of the home is recorded `interrupted` with a reason citing
//       an engine restart: the home has one incarnation, and no
//       `check.interrupted` event cites one (read after (a)).
//
// The exact refusal code is the Builder's to name; SEAM.md §340 pins the
// form and leaves the code to be named once the engine has it.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258, 268). Every unit is the
// engine's, under this test's own home's prefix. The link check runs its
// probing steps only after it reads its own containment and the test reads
// it from the host (`releaseLink`); here its only step is one GET of the
// target. (b)'s engine is this test's own child, spawned by the test; it is
// expected to exit by itself, and is sent TERM, then KILL, only when it did
// not (which is the case's failure), by the handle the spawn returned. The
// file ends with the operator's guard; every engine start carries the
// real-adapter switch. The long directories live under one temporary root
// of this test, removed at the end.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { executionsOf } from './harness/checks/fixtures.mjs';
import { deploy, homeHash } from './harness/deploy/kernel.mjs';
import {
  REAL_ADAPTER,
  RELEASE,
  endEnvironment,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  linkReport,
  listUnits,
  newestOperation,
  operatorGuard,
  postDeployOf,
  releaseLink,
  serviceLinkLogs,
  ticksUntil,
  verificationOf,
} from './harness/deploy/host.mjs';
import { freePort, isRefusalBody, makeTempDir, parseRefusal, removeDir, spawnEngine, within, writeEngineConfig } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { endScopeLeftovers, scopeUnitPrefix } from './harness/sandbox/cgroup.mjs';
import { HOST_CHECKS_RUN, SANDBOX_CONFIG, eventsOf, incarnationsInOrder, sandboxEnv } from './harness/sandbox/lane.mjs';
import { withStore } from './harness/store.mjs';

// sun_path: 108 bytes with its terminator (Linux, `man 7 unix`).
const SUN_PATH_MAX = 107;
// The old link name past the home: `/run/` + `env_` + 26 + `-g1-link-` + 10 + `.sock`.
const OLD_LINK_PAST_HOME = '/run/'.length + 'env_'.length + 26 + '-g1-link-'.length + 10 + '.sock'.length;
// (a)'s home: the old link path would be 111 bytes; the README's real run
// is 43 bytes and the rehearsal that found 055 was 56.
const LONG_HOME_BYTES = 52;
// (b)'s home: longer than any socket address can hold, whatever the name.
const TOO_LONG_HOME_BYTES = 120;
// `scriptedEngine` makes its home at `<tmpdir>/surety-acc-s2-XXXXXX/home`.
const FIXTURE_PAST_TMPDIR = '/surety-acc-s2-XXXXXX/home'.length;
const EXIT_NOT_STARTED = 6;
const LINK = { program: 'link-check.mjs' };
const LINK_TARGET = '/.init/link.sock';

const bytes = (s) => Buffer.byteLength(s);

// A directory under `root` whose path is `length` bytes long (or the
// shortest longer one when root is already too long for that).
function dirOfLength(root, length) {
  const pad = Math.max(1, length - bytes(root) - 1);
  const dir = join(root, 'x'.repeat(pad));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Every socket under `dir`, by path.
function socketsUnder(dir) {
  const found = [];
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const full = join(d, e.name);
      if (e.isSocket()) found.push(full);
      else if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found;
}

// The source the check's recorded mount plan binds at /.init/link.sock, read
// from the domain's `mount_plan` whatever its line form.
function linkSourceOf(home, domainId) {
  const row = withStore(home, (db) => db.prepare('SELECT "mount_plan" FROM "execution_domains" WHERE "id" = ?').get(domainId));
  assert.ok(row?.mount_plan, `the check domain ${domainId} has a recorded mount plan`);
  const entries = JSON.parse(row.mount_plan);
  for (const e of entries) {
    const [source, target] = typeof e === 'string' ? e.trim().split(/\s+/) : [e.source ?? e.from ?? e.path, e.target ?? e.to];
    if (target === LINK_TARGET) return source;
  }
  assert.fail(`the check's mount plan binds nothing at ${LINK_TARGET} (${JSON.stringify(entries).slice(0, 600)})`);
}

// A post-deploy execution of the environment that ended without running
// (interrupted or cancelled), with the reason its event records, or undefined.
function endedWithoutRunning(ctx, env) {
  const x = postDeployOf(ctx, env).find((e) => ['interrupted', 'cancelled'].includes(e.status));
  if (!x) return undefined;
  const why = eventsOf(ctx.fx.home, 'check_execution', x.id, 'check.%').map((e) => e.payload?.why ?? e.payload?.reason ?? null).filter(Boolean);
  return { ended: { id: x.id, status: x.status, why } };
}

// Every check.interrupted event of the home with its reason.
const interruptions = (home) =>
  withStore(home, (db) => db.prepare(`SELECT "seq", "subject", "payload" FROM "events" WHERE "type" = 'check.interrupted' ORDER BY "seq"`).all()).map((e) => ({
    seq: e.seq,
    execution: JSON.parse(e.subject)?.check_execution ?? null,
    why: JSON.parse(e.payload)?.why ?? null,
  }));

describe('M314 the service link under a long home (objection 055)', () => {
  const shared = sharedFixture();
  let guard;
  let root;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    root = guard.root(makeTempDir('L'));
    shared.context.after(() => removeDir(root));
    // The fixture's home is made under os.tmpdir(); TMPDIR is pointed at a
    // directory of this test's root for the fixture's construction only,
    // so that the home comes out LONG_HOME_BYTES long. The engine's own
    // environment is constructed by the harness (SURETY_HOME, PATH, HOME,
    // LANG, TZ) and never carries TMPDIR.
    const deep = dirOfLength(root, LONG_HOME_BYTES - FIXTURE_PAST_TMPDIR);
    const hadTmp = Object.prototype.hasOwnProperty.call(process.env, 'TMPDIR');
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = deep;
    try {
      ctx = await hostDeployable(shared.context, guard, { behaves: 'link', behavesTimeout: 300 });
    } finally {
      if (hadTmp) process.env.TMPDIR = previous;
      else delete process.env.TMPDIR;
    }
    console.log(`# the long home: ${ctx.fx.home} (${bytes(ctx.fx.home)} bytes; the old link path would be ${bytes(ctx.fx.home) + OLD_LINK_PAST_HOME} bytes)`);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) under a home past the old link name\'s bound, the post-deploy check reaches the service through the link, bound where the plan names it, and the round is verified', async () => {
    const home = ctx.fx.home;
    assert.ok(bytes(home) + OLD_LINK_PAST_HOME > SUN_PATH_MAX, `the home (${bytes(home)} bytes) puts the old link name past ${SUN_PATH_MAX} bytes`);
    const name = 'long';
    const file = join(ctx.prog.releaseDir, RELEASE);
    try {
      const env = await hostEnvironment(ctx, name);
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const got = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env, LINK) ?? endedWithoutRunning(ctx, env), { what: 'the link check to hold under the long home' });
      assert.equal(got.ended, undefined, `the link check ran: it was not ${got.ended?.status} without running (${JSON.stringify(got.ended)})`);
      const held = got;
      // The engine bound the link at the path the check's plan names: a socket, within the address limit.
      const source = linkSourceOf(home, held.domain.id);
      assert.ok(source.startsWith(`${home}/`), `the link is bound under the home (${source})`);
      assert.ok(bytes(source) <= SUN_PATH_MAX, `the link's path fits a socket address (${bytes(source)} bytes: ${source})`);
      assert.ok(lstatSync(source).isSocket(), `the link exists at the path the plan names, as a socket (${source})`);
      const op = newestOperation(ctx, env);
      releaseLink(ctx, held, { steps: [{ do: 'get', path: '/hello' }], exit: 0 });
      const { row } = await verificationOf(ctx, op);
      const { report } = linkReport(ctx, held.execution);
      const get = report.steps.find((s) => s.do === 'get')?.result;
      assert.equal(get?.status, 200, `the target answered through the link (${JSON.stringify(get)})`);
      const entries = serviceLinkLogs(home, ctx.project).flatMap((l) => l.entries).filter((e) => e.execution === held.execution.id);
      assert.ok(entries.some((e) => e.decision === 'accepted'), `the link log holds an accepted connection of the execution (${JSON.stringify(entries.map((e) => e.decision))})`);
      assert.equal(row.outcome, 'verified', `the round is verified (${JSON.stringify({ outcome: row.outcome, missing: row.missing })})`);
    } finally {
      if (!existsSync(file)) writeFileSync(file, JSON.stringify({ steps: [], exit: 1 }));
      try {
        if (ctx.envs[name]) await endEnvironment(ctx, ctx.envs[name]);
      } finally {
        rmSync(file, { force: true });
      }
    }
  });

  test('(c) no check is recorded interrupted by an engine restart that never happened', () => {
    const home = ctx.fx.home;
    assert.equal(incarnationsInOrder(home).length, 1, 'the engine was started once: no restart happened');
    const cited = interruptions(home).filter((i) => /the engine restarted/.test(i.why ?? ''));
    assert.deepEqual(cited, [], 'no check.interrupted event cites an engine restart');
    const interrupted = executionsOf(home, ctx.candidate.id).filter((x) => x.status === 'interrupted').map((x) => x.id);
    assert.deepEqual(interrupted, [], 'no execution of the candidate is interrupted');
  });

  test('(b) a home too long for the engine\'s socket paths is refused at start, in the start-refusal form, naming the limit; nothing bound, no unit', async () => {
    const home = join(dirOfLength(root, TOO_LONG_HOME_BYTES - '/home'.length), 'home');
    mkdirSync(home, { recursive: true });
    assert.ok(bytes(home) > SUN_PATH_MAX, `the home alone (${bytes(home)} bytes) is past a socket address (${SUN_PATH_MAX})`);
    writeEngineConfig(home, { api_port: await freePort(), ...SANDBOX_CONFIG });
    guard.track({ home, root: null });
    const proc = spawnEngine({ home, harness: true, args: [...HOST_CHECKS_RUN, ...REAL_ADAPTER], env: sandboxEnv() });
    // `within` resolves null when the time is up.
    const status = await within(proc.exited, 30_000);
    let stopped = null;
    try {
      if (status !== null) await within(proc.closed, 2000);
      else {
        // It did not exit: it is this test's own child, spawned above; ended
        // by its handle, TERM first, so that it leaves nothing.
        proc.child.kill('SIGTERM');
        stopped = await within(proc.exited, 20_000);
        if (stopped === null) {
          proc.child.kill('SIGKILL');
          stopped = await proc.exited;
        }
      }
    } finally {
      endScopeLeftovers(scopeUnitPrefix(home));
    }
    const sockets = socketsUnder(home);
    const units = (listUnits() ?? []).filter((u) => u.unit.startsWith(`surety-${homeHash(home)}-`) || u.unit.startsWith(scopeUnitPrefix(home)));
    assert.ok(status !== null, `the engine refused to start within 30 s; it ran until the test stopped it (${JSON.stringify(stopped)}; stderr: ${proc.out.stderr.slice(-600)})`);
    assert.ok(!/^\s+at .+:\d+:\d+\)?$/m.test(proc.out.stderr), `no stack trace on stderr:\n${proc.out.stderr.slice(-1500)}`);
    assert.ok(!/Node\.js v\d+/.test(proc.out.stderr), `not Node's report of an uncaught error:\n${proc.out.stderr.slice(-1500)}`);
    assert.equal(status.code, EXIT_NOT_STARTED, `the not-started exit status (signal: ${status.signal}; stderr: ${proc.out.stderr.slice(-600)})`);
    const refusal = parseRefusal(proc.out.stderr);
    assert.ok(isRefusalBody(refusal), `one refusal line with code, reason, what_to_do and subject (stderr: ${proc.out.stderr.slice(-600)})`);
    assert.match(`${refusal.code} ${refusal.reason}`, /socket/i, `the refusal says it is about a socket path (${JSON.stringify(refusal)})`);
    assert.match(`${refusal.reason} ${refusal.what_to_do}`, /\b\d+\b/, `the refusal names the limit in bytes (${JSON.stringify(refusal)})`);
    assert.deepEqual(sockets, [], 'nothing was bound under the home');
    assert.deepEqual(units.map((u) => u.unit), [], 'no unit of the home\'s prefix exists');
  });
});
