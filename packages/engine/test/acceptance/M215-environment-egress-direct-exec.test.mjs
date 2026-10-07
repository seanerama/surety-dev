// M215, the environment, egress and direct exec (M3 slice 17, the protected
// inputs; sandbox lane). M3 plan §3.3 M215; D3-R02, D3-R03, D3-R04; D3
// §§1.1, 2.2, 2.3, 2.6, A.4; Q6; D2 §2.4; SEAM.md §§140, 169, 195, 201, 202.
//
// One candidate, three checks.
//   `env` (no egress), held: from the host, its process's environment is
//     exactly D3 §2.3's variables, none of the engine's own (the parent-only
//     sentinels the test gave the engine, the API token); no process of the
//     domain is a shell; its network namespace has only loopback; and an
//     argument full of shell metacharacters reached it as one literal
//     argument. Released, its `fetch` finds no HTTPS_PROXY and attempts
//     nothing. Its execution records the resolved program's path and hash,
//     unpinned (Q6).
//   `net`, declaring one host of `egress_allow`, held: HTTPS_PROXY is set.
//     Released, it sends one CONNECT for the declared host and one for a
//     host the governed list allows and the definition does not declare. The
//     declared one goes through the proxy, which connects to its validated
//     address (a documentation address the harness holds unconnected, SEAM
//     §169) and logs it; the undeclared one is refused 403, `not_listed`.
//   `pinned`, whose program's pinned hash differs: `toolchain_missing`, its
//     execution still recording the resolved path and the hash found.
//
// SAFETY (E64; BS3 §4 rule 1): `fetch` is guarded as SEAM.md §198 says,
// and released only after the test reads containment from the host. It
// connects only to the proxy HTTPS_PROXY names, on loopback in its own
// network namespace. The resolver is the harness's; both names resolve to
// documentation addresses, routed nowhere, and the one the proxy may reach
// is held unconnected by the harness fault. Nothing reaches the internet.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { armFault, sha256Hex } from './harness/engine.mjs';
import { effectiveVersion, sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { DOC, PROXY_LIMITS, setResolver } from './harness/sandbox/egress.mjs';
import { members } from './harness/sandbox/procs.mjs';
import { assertContained } from './harness/sandbox/view.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkEgressLogs,
  checkProject,
  defPath,
  executionsOf,
  guardArgs,
  heldExecution,
  holdArgs,
  installCheckProgram,
  interfacesOfPid,
  outputText,
  programLine,
  qualifyRunnerByFixture,
  release,
  resultRow,
  sandboxGoverned,
  smoke,
  terminalExecution,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const DECLARED = 'pkg.example';
const UNDECLARED = 'other.example';
const METACHARS = '$(touch /tmp/pwned) `id` ; echo $HOME | cat && false || true > out * ? ~ \'"\\';
// What the test gives the engine and what must reach no check (D1 §17 item 4).
const PARENT_ONLY = Object.freeze({
  SURETY_TEST_PARENT_SENTINEL: 'parent-only-sentinel-m215',
  ANTHROPIC_API_KEY: 'sk-ant-parent-only-m215',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-parent-only-m215',
});
const RUNNER_ENV = Object.freeze({ RUNNER_LEVEL: 'governed' });
const CHECK_ENV = Object.freeze({ CHECK_LEVEL: 'definition' });
const SHELLS = ['sh', 'bash', 'dash', 'zsh', 'ksh', 'busybox', 'ash'];
const base = (p) => p.split('/').at(-1);

async function exercise(t) {
  const fx = await sandboxEngine(t, { config: { ...PROXY_LIMITS }, env: PARENT_ONLY });
  const prog = installCheckProgram(fx.root);
  await qualifyRunnerByFixture(fx.engine);
  await setResolver(fx.engine, { [DECLARED]: [DOC.c], [UNDECLARED]: [DOC.b] });
  await armFault(fx.engine, { point: 'egress_connect_hang', address: DOC.c });
  await armFault(fx.engine, { point: 'egress_connect_hang', address: DOC.b });

  const governed = sandboxGoverned(prog, {
    check_commands: { probe: { path: prog.program }, pinned: { path: prog.program, sha256: '0'.repeat(64) } },
    runner_config: { direct: { read_paths: prog.readPaths, env: { ...RUNNER_ENV }, egress_allow: [DECLARED, UNDECLARED] } },
  });
  const files = {
    [GOVERNED_FILE]: governed,
    '.surety/checks/expect.txt': 'unused input\n',
    [defPath('env')]: smoke('env', { command: ['probe', '--say', METACHARS, ...holdArgs(prog, 'env'), ...guardArgs(), 'fetch', DECLARED], env: { ...CHECK_ENV }, gates: ['stage'], timeout: 300 }),
    [defPath('net')]: smoke('net', { command: ['probe', ...holdArgs(prog, 'net'), ...guardArgs(), 'fetch', DECLARED, UNDECLARED], egress: [DECLARED], gates: ['stage'], timeout: 300 }),
    [defPath('pinned')]: smoke('pinned', { command: ['pinned', 'exit', '0'], gates: ['stage'], timeout: 300 }),
  };
  const project = await checkProject(fx, { files });
  const version = effectiveVersion(fx.home, project.id);
  const { candidate } = await buildStage(fx, project);

  // The two held checks, in whatever order the engine runs them.
  const seen = {};
  const pending = { env: 'env', net: 'net' };
  while (Object.keys(pending).length > 0) {
    const held = await heldExecution(fx, project.id, candidate.id, pending);
    assertContained(held.domain, held.member, `the ${held.key} check program`);
    seen[held.key] = { held, all: members(held.domain.cgroup_path), interfaces: interfacesOfPid(held.member.pid) };
    delete pending[held.key];
    release(prog, held.key);
    await waitRecorded(fx, project.id, candidate.id, [held.key]);
  }
  const pinned = await terminalExecution(fx, project.id, candidate.id, 'pinned');
  const recorded = Object.fromEntries(executionsOf(fx.home, candidate.id).map((x) => [x.key, x]));
  const token = readFileSync(join(fx.home, 'api.token'), 'utf8').trim();
  return { fx, prog, project, version, candidate, seen, pinned, recorded, token };
}

describe('M215 the environment, egress and direct exec', () => {
  const shared = sharedFixture();
  let X;
  before(async () => {
    X = await exercise(shared.context);
  });
  after(() => shared.cleanup());

  test("(a) the environment is exactly D3 §2.3's, host-read; nothing of the engine's own reaches the domain", () => {
    const { held, all } = X.seen.env;
    const env = held.member.environ;
    assert.ok(env instanceof Map, `host-read: the check's environment can be read (${held.member.environError})`);
    const expected = {
      PATH: '/usr/bin:/bin',
      HOME: '/surety/home',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      CI: 'true',
      ...RUNNER_ENV,
      ...CHECK_ENV,
      SURETY_CHECK: 'env',
      SURETY_CANDIDATE: X.candidate.id,
      SURETY_SOURCE_REVISION: X.candidate.revision,
      SURETY_PROTECTED_VERSION: X.version.id,
      SURETY_DOMAIN: held.domain.id,
    };
    assert.deepEqual(Object.fromEntries([...env].sort(([a], [b]) => (a < b ? -1 : 1))), Object.fromEntries(Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1))), 'host-read: the check process has exactly the constructed environment, and no HTTPS_PROXY without egress');
    // The check's own processes. The domain init is the engine's trusted
    // helper, not dumpable by design (D2 §1.1, §2.3), so the host cannot read
    // its environment; D3 §2.3 is about the check's (SEAM.md §201).
    const checks = all.filter((p) => p.cmdline.some((a) => a.endsWith('/program.mjs')));
    assert.ok(checks.some((p) => p.pid === held.member.pid), 'the fixture is live: the check process is among the domain members read');
    for (const p of checks) {
      assert.ok(p.environ instanceof Map, `host-read: the environment of the check's process ${p.pid} can be read (${p.environError})`);
      for (const [name, value] of Object.entries(PARENT_ONLY)) {
        assert.ok(!p.environ.has(name) && ![...p.environ.values()].includes(value), `member ${p.pid}: the engine's parent-only ${name} is absent, by name and by value`);
      }
      assert.ok(![...p.environ.values()].some((v) => v.includes(X.token)), `member ${p.pid}: no variable holds the API token`);
    }
  });

  test('(b) without egress: only loopback, no proxy, nothing attempted', () => {
    assert.deepEqual(X.seen.env.interfaces, ['lo'], "host-read: the check's network namespace has only loopback");
    const fetch = programLine(outputText(X.fx.home, resultRow(X.fx.home, X.recorded.env.result)), 'SURETY-CHECK-FETCH');
    assert.deepEqual(fetch, { proxy: null, results: [] }, 'the check found no HTTPS_PROXY and attempted nothing');
  });

  test('(b) a declared host goes through the proxy and is logged; a host the definition does not declare is refused 403, not_listed', () => {
    const env = X.seen.net.held.member.environ;
    assert.match(env.get('HTTPS_PROXY') ?? '', /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/, `host-read: with egress, HTTPS_PROXY names the forwarder on loopback (${env.get('HTTPS_PROXY')})`);
    assert.deepEqual(X.seen.net.interfaces, ['lo'], "host-read: still only loopback: the proxy is the way out");
    const fetch = programLine(outputText(X.fx.home, resultRow(X.fx.home, X.recorded.net.result)), 'SURETY-CHECK-FETCH');
    const by = Object.fromEntries(fetch.results.map((r) => [r.host, r]));
    assert.match(by[UNDECLARED]?.status ?? '', /^HTTP\/1\.[01] 403/, `the undeclared host is refused by the list, 403 (${JSON.stringify(by[UNDECLARED])})`);
    assert.doesNotMatch(by[DECLARED]?.status ?? '', /^HTTP\/1\.[01] 403/, `the declared host is not refused by the list (${JSON.stringify(by[DECLARED])})`);

    const logs = X.recorded.net.domain ? checkEgressLogs(X.fx.home, X.project.id) : [];
    assert.equal(logs.length, 1, `one egress_log record of the project with no run: the net check's domain's (SEAM.md §201) (found ${logs.length})`);
    const entries = logs[0].entries;
    const declared = entries.filter((e) => e.authority === `${DECLARED}:443`);
    const undeclared = entries.filter((e) => e.authority === `${UNDECLARED}:443`);
    assert.deepEqual(declared.map((e) => [e.decision, e.address]), [['accepted', DOC.c]], `the declared host passed the list and the proxy connected to its validated address (${JSON.stringify(declared)})`);
    assert.deepEqual(undeclared.map((e) => [e.decision, e.reason]), [['refused', 'not_listed']], `the undeclared host is refused, not_listed (${JSON.stringify(undeclared)})`);
    const refusals = eventsOfType(X.fx.home, 'domain.egress_refused').filter((e) => e.subject?.domain === X.recorded.net.domain);
    assert.deepEqual(refusals.map((e) => [e.payload?.authority, e.payload?.reason]), [[`${UNDECLARED}:443`, 'not_listed']], 'one domain.egress_refused about the net check\'s domain');
  });

  test('(c) shell metacharacters reach the program as one literal argument; no shell in the domain', () => {
    const { held, all } = X.seen.env;
    assert.ok(held.member.cmdline.includes(METACHARS), `host-read: the argument is in the program's argument vector, unchanged (${JSON.stringify(held.member.cmdline)})`);
    const text = outputText(X.fx.home, resultRow(X.fx.home, X.recorded.env.result));
    assert.ok(text.split('\n').includes(METACHARS), 'the program printed it back literally');
    for (const p of all) assert.ok(!SHELLS.includes(base(p.cmdline[0] ?? '')), `host-read: domain member ${p.pid} is no shell (${JSON.stringify(p.cmdline)})`);
  });

  test('(d) a pinned hash that differs: toolchain_missing; every execution records the resolved path and hash, pinned or not', () => {
    const programSha = sha256Hex(readFileSync(X.prog.program));
    assert.equal(X.pinned.status, 'recorded');
    const result = resultRow(X.fx.home, X.pinned.result);
    assert.deepEqual([result.execution_established, result.not_run_reason], [0, 'toolchain_missing'], `the pinned check is not run, toolchain_missing (${JSON.stringify(result)})`);
    assert.deepEqual(X.pinned.toolchain, { name: 'pinned', path: X.prog.program, sha256: programSha }, 'its execution records the resolved path and the hash found');
    for (const key of ['env', 'net']) assert.deepEqual(X.recorded[key].toolchain, { name: 'probe', path: X.prog.program, sha256: programSha }, `${key}, unpinned: the resolved path and hash are recorded (Q6)`);
  });
});
