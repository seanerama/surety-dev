// M128, the proxy's limits (M2 slice 12, sandbox lane). M2 plan §3.5 M128;
// D2 §2.4, §3.7, A.7 (D2-I17, D2-I17-OBS); AR B03, B09; E57; SEAM.md
// §§132, 140, 141.
//
// Each limit set low in config.json (the smallest value D2 A.7's range
// allows): a resolution that takes longer than `egress_resolve_timeout`, a
// connection to a validated address that does not answer within
// `egress_connect_timeout`, a tunnel older than `egress_tunnel_max_seconds`,
// one tunnel more than `egress_tunnels_max`, a slow reader past
// `egress_buffer_max_bytes`: each tunnel is refused or closed at its limit,
// the role sees a refusal or the end of its tunnel, the egress log records
// the reason and the figure, and the run goes on to complete (a per-tunnel
// limit ends the tunnel, not the run: SEAM.md §140). The log's own bound,
// `egress_log_max_bytes`, is a bound on evidence: the record stops at it,
// is marked truncated, and the run is cancelled with its evidence
// incomplete, never complete. The observer case reports not_exercised.
//
// NETWORK: names under `.example`, answers constructed by the harness
// resolver; the connect-timeout target is a documentation address, routed
// nowhere. Every tunnel that opens is to the engine's own echo endpoint.
// The role's CONNECTs are guarded probes (SEAM.md §141).
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no egress proxy (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { waitForRunState } from './harness/runs.mjs';
import { DOC, ECHO_AUTHORITY, PROXY_LIMITS, egressLogOf, egressRefusals, entryFor, resolverQueries, setResolver } from './harness/sandbox/egress.mjs';
import { checkOf, hostSection, receiptOf, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { addProfiledWork, approveWidening, armedRole, probedRun } from './harness/sandbox/view.mjs';

const assertLimit = (e, key, ended) => {
  assert.equal(e.ended, ended, `the log records how the tunnel ended: ${ended} (${JSON.stringify(e)})`);
  assert.deepEqual(e.limit, { key, value: PROXY_LIMITS[key] }, `and the limit with its figure (${JSON.stringify(e.limit)})`);
};

async function limitedEngine(t) {
  const fx = await sandboxEngine(t, { config: PROXY_LIMITS });
  const project = (await addGitProject(fx)).id;
  return { fx, project };
}

// The run completed: a per-tunnel limit ended the tunnel only.
const assertRunWentOn = (ended, what) => assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `${what}: the run is not ended by a per-tunnel limit (${ended.reason_text})`);

describe('M128 the proxy\'s limits', () => {
  test('(a) egress_resolve_timeout with a delaying resolver and (b) egress_connect_timeout against a non-routable validated address: each tunnel refused at its limit, the role sees no tunnel, the log records reason and figure, the run goes on', async (t) => {
    const { fx, project } = await limitedEngine(t);
    await approveWidening(fx, project, { egress_allow_extra: ['slow.example', 'nowhere.example'] });
    await setResolver(fx.engine, { 'slow.example': { answers: [[DOC.a]], delay_ms: 3000 }, 'nowhere.example': [DOC.b] });
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, domain, probe, ended } = await probedRun(fx, project, item, {
      acts: (act) => [act.proxyConnect('slow.example:443', { label: 'resolve', timeout_ms: 8000 }), act.proxyConnect('nowhere.example:443', { label: 'connect', timeout_ms: 8000 })],
    });
    const log = egressLogOf(fx.home, run.id);

    const r = probe('proxy_connect', 'resolve');
    assert.ok(r.status !== 200, `(a) no tunnel after a resolution that took too long (${JSON.stringify(r)})`);
    assert.ok(r.elapsed_ms < 2900, `(a) the proxy answered at its 1 s limit, before the resolver's 3 s answer (${r.elapsed_ms} ms, monotonic)`);
    const ea = entryFor(log, 'slow.example:443');
    assertLimit(ea, 'egress_resolve_timeout', 'resolve_timeout');
    assert.equal(ea.address, null, '(a) nothing was connected');
    assert.ok(egressRefusals(fx.home, domain.id).some((e) => e.payload?.authority === 'slow.example:443'), '(a) domain.egress_refused');
    assert.equal((await resolverQueries(fx.engine))['slow.example'], 1, '(a) one resolution, abandoned, not retried by the proxy');

    const c = probe('proxy_connect', 'connect');
    assert.ok(c.status !== 200, `(b) no tunnel to an address that does not answer (${JSON.stringify(c)})`);
    assert.ok(c.elapsed_ms < 5000, `(b) refused at the 1 s limit, not the system's connect timeout (${c.elapsed_ms} ms)`);
    const eb = entryFor(log, 'nowhere.example:443');
    assertLimit(eb, 'egress_connect_timeout', 'connect_timeout');
    assert.deepEqual([eb.decision, eb.address], ['accepted', DOC.b], '(b) the address passed the policy and was the one connected to');
    assertRunWentOn(ended, '(a), (b)');
  });

  test('(c) egress_tunnel_max_seconds: a tunnel to the echo endpoint kept busy is closed at its lifetime; the role sees the end; the run goes on', async (t) => {
    const { fx, project } = await limitedEngine(t);
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, probe, ended } = await probedRun(fx, project, item, {
      acts: (act) => [act.proxyConnect(ECHO_AUTHORITY, { linger_ms: 80_000, keepalive_ms: 1000 })],
      timeoutMs: 150_000,
    });
    const p = probe('proxy_connect');
    assert.equal(p.status, 200, `the tunnel opened (${JSON.stringify(p)})`);
    assert.notEqual(p.closed, 'open', 'the role saw its tunnel end');
    const limitMs = PROXY_LIMITS.egress_tunnel_max_seconds * 1000;
    assert.ok(p.closed_after_ms >= limitMs - 2000 && p.closed_after_ms <= limitMs + 10_000, `closed at the tunnel's lifetime, ${limitMs} ms, measured by the role on the monotonic clock (${p.closed_after_ms} ms)`);
    assertLimit(entryFor(egressLogOf(fx.home, run.id), ECHO_AUTHORITY), 'egress_tunnel_max_seconds', 'tunnel_max_seconds');
    assertRunWentOn(ended, '(c)');
  });

  test('(d) egress_tunnels_max plus one: the tunnels within the limit open, the one beyond it is refused, recorded with the figure; the run goes on', async (t) => {
    const { fx, project } = await limitedEngine(t);
    const max = PROXY_LIMITS.egress_tunnels_max;
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, probe, ended } = await probedRun(fx, project, item, { acts: (act) => [act.proxyConcurrent(ECHO_AUTHORITY, max + 1, { hold_ms: 4000, stagger_ms: 300 })] });
    const results = probe('proxy_concurrent').results;
    assert.equal(results.length, max + 1);
    assert.deepEqual(results.map((r) => r.status === 200), [...Array(max).fill(true), false], `the first ${max} open and the one beyond is refused (${JSON.stringify(results)})`);
    const entries = egressLogOf(fx.home, run.id).entries.filter((e) => e.authority === ECHO_AUTHORITY);
    assert.equal(entries.length, max + 1, 'every attempt is in the log');
    const refused = entries.filter((e) => e.decision === 'refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, 'tunnels_max');
    assert.deepEqual(refused[0].limit, { key: 'egress_tunnels_max', value: max }, 'the log records the limit with its figure');
    assertRunWentOn(ended, '(d)');
  });

  test('(e) egress_buffer_max_bytes with a slow reader: the tunnel is closed at the limit, the role sees its end, the log records reason and figure; the run goes on', async (t) => {
    const { fx, project } = await limitedEngine(t);
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, probe, ended } = await probedRun(fx, project, item, { acts: (act) => [act.proxyConnect(ECHO_AUTHORITY, { flood_bytes: 8 * 1024 * 1024, flood_wait_ms: 3000, linger_ms: 3000 })] });
    const p = probe('proxy_connect');
    assert.equal(p.status, 200, `the tunnel opened (${JSON.stringify(p)})`);
    assert.notEqual(p.closed, 'open', `the role saw its tunnel end (${JSON.stringify(p)})`);
    const e = entryFor(egressLogOf(fx.home, run.id), ECHO_AUTHORITY);
    assertLimit(e, 'egress_buffer_max_bytes', 'buffer_max');
    assert.ok(e.bytes_up < 8 * 1024 * 1024, `the proxy stopped taking the role's bytes (${e.bytes_up})`);
    assertRunWentOn(ended, '(e)');
  });

  test('(f) egress_log_max_bytes: the record stops at the bound and is marked truncated, and the run is cancelled with its evidence incomplete, never complete', async (t) => {
    const { fx, project } = await limitedEngine(t);
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const role = await armedRole(fx, project, item, { acts: (act) => [act.proxyFlood('flood-%n.example:443', 3000, { max_ms: 90_000, timeout_ms: 2000 })], thenHold: true });
    role.release().catch(() => {});
    const ended = await waitForRunState(fx.home, role.run.id, 'ended', { timeoutMs: 150_000 });
    assert.notEqual(ended.outcome, 'completed', 'the run is never completed');
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'infra_error'], `the run is cancelled by the bound (${ended.reason_text})`);
    assert.match(ended.reason_text ?? '', /egress_log_max_bytes/, 'its reason names the bound');
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, role.run.id).id);
    assert.equal(terminal.exit_class, 'engine_signaled', `the engine cancelled it through the boundary (${JSON.stringify(terminal)})`);
    const log = egressLogOf(fx.home, role.run.id);
    assert.ok(log.marker !== null, 'the record is marked truncated');
    assert.deepEqual([log.marker.limit, log.marker.value], ['egress_log_max_bytes', PROXY_LIMITS.egress_log_max_bytes], 'by the bound, with its figure');
    assert.ok(log.bytes <= PROXY_LIMITS.egress_log_max_bytes + 512, `the record stops at the bound (${log.bytes} bytes, the bound ${PROXY_LIMITS.egress_log_max_bytes} and one marker line)`);
    assert.ok(log.entries.length > 100, 'the fixture is live: the role made many connections');
  });

  test('(g) [not_exercised] the observer\'s collection limits: H13 is not exercised on this host, and no observer record exists', async (t) => {
    const fx = await sandboxEngine(t);
    const h13 = checkOf(hostSection(await fx.engine.engineInfo()), 'H13');
    assert.equal(h13.result, 'not_exercised', `the observer is not exercised on this host (${h13.observed})`);
    assert.ok(typeof h13.observed === 'string' && h13.observed.length > 0, 'and the engine says why');
  });
});
