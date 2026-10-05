// M127, egress is bound to the validated address (M2 slice 12, sandbox
// lane). M2 plan §3.5 M127; D2 §2.4, A.6 P8, A.7 (D2-I07); AR B03, P8;
// SEAM.md §§132, 140, 141.
//
// The proxy accepts a CONNECT only for a listed name on port 443; it
// resolves the name once per attempt (the harness resolver counts), refuses
// the whole answer if any address is loopback, private, link-local,
// unspecified, multicast, an IPv4-mapped form of those, or the host's own,
// and connects only to a validated numeric address of that one answer; a
// retry resolves again. The probe profile's echo endpoint carries bytes
// both ways unchanged (no TLS termination), witnessed by the endpoint's
// own log; the role profile cannot use it, and no qualification attempt
// may list it. An approved `egress_allow_extra` is used under the role
// profile. Every connection, accepted or refused, is in the domain's
// `egress_log` record with its destination, resolved addresses, the
// address connected, byte counts and times.
//
// NETWORK: the names are under `.example`; their answers are constructed
// by the harness resolver; a "public" address is a documentation address
// (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), and
// each one the proxy connects to is held unconnected by the harness fault
// `egress_connect_hang` (SEAM.md §169), so the connect times out, sends
// nothing and reaches no host, whatever the network would have answered. The role's CONNECTs are guarded probes (SEAM.md §141).
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no egress proxy (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';

import { armFault, sha256Hex } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { addWork } from './harness/runs.mjs';
import { DOC, ECHO_AUTHORITY, assertEntryForm, echoConnections, egressLogOf, egressRefusals, entryFor, hostAddresses, resolverQueries, setResolver } from './harness/sandbox/egress.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { addProfiledWork, approveWidening, probedRun } from './harness/sandbox/view.mjs';

const CONFIG = { egress_connect_timeout: 1, egress_resolve_timeout: 1 };
// Forbidden answers (D2 §2.4), each served for a listed name of its own.
const FORBIDDEN = Object.freeze({
  'loopback6.example': ['::1'],
  'ula.example': ['fd00::1'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'linklocal.example': ['fe80::1'],
  'unspecified.example': ['::'],
  'multicast6.example': ['ff02::1'],
  'multicast4.example': ['224.0.0.1'],
  'private.example': ['10.1.2.3'],
  'mixed.example': [DOC.a, '10.0.0.5'],
});

async function listedProject(fx, names) {
  const project = (await addGitProject(fx)).id;
  await approveWidening(fx, project, { egress_allow_extra: names });
  return project;
}

describe('M127 egress is bound to the validated address', () => {
  test('(a) to (e), (i): an unlisted name, a listed name on another port, a private answer, a mixed answer, every forbidden address family and the host\'s own: 403 and domain.egress_refused each, the whole answer refused; rebinding: one resolution per attempt, the connected address the validated one, a retry resolves again; every connection in the egress log', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const host = hostAddresses()[0]?.address;
    assert.ok(host, 'the host has an address beside loopback');
    const names = { ...FORBIDDEN, 'host-own.example': [host], 'rebind.example': { answers: [[DOC.a], ['127.0.0.1']] }, 'listed.example': [DOC.b] };
    const project = await listedProject(fx, Object.keys(names));
    await setResolver(fx.engine, names);
    // Rebinding's first attempt connects to DOC.a: held by the harness (SEAM.md §169).
    await armFault(fx.engine, { point: 'egress_connect_hang', address: DOC.a });
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, domain, probe } = await probedRun(fx, project, item, {
      acts: (act) => [
        act.proxyConnect('unlisted.example:443', { label: 'unlisted' }),
        act.proxyConnect('listed.example:80', { label: 'port' }),
        ...Object.keys(FORBIDDEN).concat('host-own.example').map((n) => act.proxyConnect(`${n}:443`, { label: n })),
        act.proxyConnect('rebind.example:443', { label: 'rebind-1', timeout_ms: 8000 }),
        act.proxyConnect('rebind.example:443', { label: 'rebind-2', timeout_ms: 8000 }),
      ],
    });
    const status = (label) => probe('proxy_connect', label);
    const queries = await resolverQueries(fx.engine);
    const log = egressLogOf(fx.home, run.id);
    const refusals = egressRefusals(fx.home, domain.id);
    const refusedEvent = (authority) => assert.ok(refusals.some((e) => e.payload?.authority === authority && typeof e.payload?.reason === 'string'), `domain.egress_refused for ${authority} with its reason`);

    // (a) an unlisted name, never resolved; a listed name on port 80.
    assert.equal(status('unlisted').status, 403, `(a) an unlisted name: 403 (${JSON.stringify(status('unlisted'))})`);
    assert.equal(queries['unlisted.example'] ?? 0, 0, '(a) an unlisted name is never resolved');
    refusedEvent('unlisted.example:443');
    assert.deepEqual([entryFor(log, 'unlisted.example:443').decision, entryFor(log, 'unlisted.example:443').reason], ['refused', 'not_listed']);
    assert.equal(status('port').status, 403, '(a) a listed name on another port than 443: 403');
    refusedEvent('listed.example:80');

    // (b), (c), (d): each forbidden answer, the whole set refused.
    for (const name of [...Object.keys(FORBIDDEN), 'host-own.example']) {
      const authority = `${name}:443`;
      assert.equal(status(name).status, 403, `${name} answering ${JSON.stringify(names[name])}: 403 (${JSON.stringify(status(name))})`);
      refusedEvent(authority);
      const e = entryFor(log, authority);
      assert.deepEqual([e.decision, e.reason, e.address, e.bytes_up, e.bytes_down], ['refused', 'address_policy', null, 0, 0], `${name}: refused by the address policy, nothing connected (${JSON.stringify(e)})`);
      assert.deepEqual([...e.resolved].sort(), [...names[name]].sort(), `${name}: the log records the whole answer it refused`);
      assert.equal(queries[name], 1, `${name}: resolved once`);
    }

    // (e) rebinding: two attempts, two resolutions, each judged on its own.
    const [first, second] = log.entries.filter((e) => e.authority === 'rebind.example:443');
    assert.ok(first && second, `two log entries for the two attempts (${log.entries.filter((e) => e.authority === 'rebind.example:443').length})`);
    assert.equal(queries['rebind.example'], 2, '(e) one resolution per attempt: two attempts, two queries, never a second query within an attempt');
    assert.deepEqual([first.resolved, first.address], [[DOC.a], DOC.a], '(e) the first attempt connected to the validated numeric address of its own answer');
    assert.notEqual(status('rebind-1').status, 200, `(e) which is routed nowhere: no tunnel (${JSON.stringify(status('rebind-1'))})`);
    assert.deepEqual([second.decision, second.reason, second.address, second.resolved], ['refused', 'address_policy', null, ['127.0.0.1']], '(e) the retry resolved again, got loopback, and was refused');
    assert.equal(status('rebind-2').status, 403);

    // (i) every connection is in the log, in its form.
    const authorities = log.entries.map((e) => e.authority);
    for (const label of ['unlisted.example:443', 'listed.example:80', ...Object.keys(FORBIDDEN).map((n) => `${n}:443`), 'host-own.example:443']) assert.ok(authorities.includes(label), `(i) the log holds ${label}`);
    for (const e of log.entries) assertEntryForm(e);
    assert.equal(log.marker, null, 'the log is whole: not truncated');
  });

  test('(f) the permitted tunnel to the echo endpoint under the probe profile: the bytes pass both ways unchanged (no TLS termination), witnessed by the echo endpoint; (i) the log records it with its byte counts', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addGitProject(fx)).id;
    const payload = randomBytes(4096);
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, domain, probe } = await probedRun(fx, project, item, { acts: (act) => [act.proxyConnect(ECHO_AUTHORITY, { payload_b64: payload.toString('base64'), expect_back: true })] });
    const p = probe('proxy_connect');
    assert.equal(p.status, 200, `the tunnel opens (${JSON.stringify(p)})`);
    assert.deepEqual([p.sent, p.received, p.received_sha256], [payload.length, payload.length, sha256Hex(payload)], 'the role got back exactly the bytes it sent');
    const echoed = await echoConnections(fx.engine, { domain: domain.id });
    assert.equal(echoed.length, 1, `host-witnessed: the echo endpoint received one connection from the domain (${JSON.stringify(echoed)})`);
    assert.deepEqual([echoed[0].bytes_in, echoed[0].sha256_in], [payload.length, sha256Hex(payload)], 'host-witnessed: it received the bytes unchanged: nothing terminated TLS or rewrote them');
    const e = entryFor(egressLogOf(fx.home, run.id), ECHO_AUTHORITY);
    assertEntryForm(e);
    assert.deepEqual([e.decision, e.bytes_up, e.bytes_down], ['accepted', payload.length, payload.length], 'the log counts the bytes each way');
  });

  test('(g) the echo exception is unavailable under the role profile (403) and no qualification attempt may list it; (h) an approved egress_allow_extra is used under the role profile', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addGitProject(fx)).id;
    await setResolver(fx.engine, { 'extra.example': [DOC.c] });
    // The approved name's address: held by the harness (SEAM.md §169).
    await armFault(fx.engine, { point: 'egress_connect_hang', address: DOC.c });

    const before = await probedRun(fx, project, await addWork(fx.engine, project, 'verification'), {
      acts: (act) => [act.proxyConnect(ECHO_AUTHORITY, { label: 'echo' }), act.proxyConnect('extra.example:443', { label: 'extra', timeout_ms: 8000 })],
    });
    assert.equal(before.domain.profile, 'role');
    assert.equal(before.probe('proxy_connect', 'echo').status, 403, `(g) the echo endpoint under the role profile: 403 (${JSON.stringify(before.probe('proxy_connect', 'echo'))})`);
    assert.deepEqual(await echoConnections(fx.engine, { domain: before.domain.id }), [], '(g) host-witnessed: the echo endpoint received nothing from the role profile');
    assert.equal(before.probe('proxy_connect', 'extra').status, 403, '(h) before the approval the name is not listed: 403');
    assert.equal(entryFor(egressLogOf(fx.home, before.run.id), 'extra.example:443').reason, 'not_listed');

    const res = await fx.engine.post('/v1/trust/qualify', { backend: 'claude', mode: 'one_shot_headless', model: 'claude-sonnet-5-5', candidate_egress: ['api.anthropic.com', 'echo.surety.invalid'] });
    assert.equal(res.status, 400, `(g) POST /v1/trust/qualify refuses a candidate list naming the echo endpoint (body: ${res.text})`);
    assert.deepEqual([res.body?.code, res.body?.subject?.field], ['invalid_value', 'candidate_egress'], '(g) as an invalid candidate_egress');

    await approveWidening(fx, project, { egress_allow_extra: ['extra.example'] });
    const after = await probedRun(fx, project, await addWork(fx.engine, project, 'verification'), { acts: (act) => [act.proxyConnect('extra.example:443', { timeout_ms: 8000 })] });
    const e = entryFor(egressLogOf(fx.home, after.run.id), 'extra.example:443');
    assert.deepEqual([e.decision, e.address], ['accepted', DOC.c], `(h) approved, the name passes the list and the address policy and the proxy connects to its validated address (${JSON.stringify(e)})`);
    assert.equal((await resolverQueries(fx.engine))['extra.example'], 1, '(h) resolved once, for the approved attempt only');
  });
});
