// M126, the engine's API and its bootstrap route are unreachable (M2 slice
// 12, sandbox lane). M2 plan §3.5 M126; D2 §2.4, §2.6, A.6 P6, P7 (D2-I05,
// D2-I06); E44 item 1; AR B03, P6, P7; SEAM.md §§132, 140, 141.
//
// The engine's API listens on the host's loopback; a role's network
// namespace has only its own, so a connection to 127.0.0.1, ::1 or any
// address of the host at the engine's port reaches nothing, and a CONNECT
// through the egress proxy to loopback or a host address is refused 403
// with `domain.egress_refused`. Reachability evidence only: what the route
// does with headers is M107's.
//
// Witnesses, host-side: the engine's listener answers the host (the
// control); a listener of the test's own on every host address at its own
// port sees no connection; the egress log records each refused CONNECT
// with no address connected and no byte carried.
//
// SAFETY: the role's connection attempts are guarded (SEAM.md §141): the
// role program refuses them outside a network namespace of its own, and
// the role is released into them only after the host has read that it is
// contained. Nothing leaves the host: the targets are loopback and the
// host's own addresses.
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no egress proxy (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { egressLogOf, egressRefusals, entryFor, hostAddresses, hostConnects, sentinelListener } from './harness/sandbox/egress.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { addProfiledWork, probedRun } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';

const bracket = (address) => (address.includes(':') ? `[${address}]` : address);
const FORGED = { Host: 'localhost', Origin: 'http://localhost', Referer: 'http://localhost/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };

describe('M126 the engine\'s API and its bootstrap route are unreachable', () => {
  test("(a) P6: the role connects to 127.0.0.1, ::1 and every host address at the engine's port and at a host listener's: unreachable each; control: the host reaches both, and the role reaches its forwarder", async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addGitProject(fx)).id;
    const listener = await sentinelListener(t);
    assert.equal(await hostConnects('127.0.0.1', fx.port), true, 'the target is seeded: the engine\'s API answers the host at 127.0.0.1');
    assert.equal(await hostConnects('127.0.0.1', listener.port), true, 'the target is seeded: the test\'s listener answers the host');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = listener.connections();
    const addresses = ['127.0.0.1', '::1', ...hostAddresses().map((a) => a.address)];
    assert.ok(addresses.length >= 3, `the host has addresses beside loopback (${addresses.join(', ')})`);
    const targets = addresses.flatMap((host) => [{ host, port: fx.port }, { host, port: listener.port }]);

    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { probe } = await probedRun(fx, project, item, {
      acts: (act) => [act.tcpConnect(targets, { label: 'host' }), act.tcpConnect('proxy', { label: 'forwarder' })],
    });
    for (const r of probe('tcp_connect', 'host').results) assert.notEqual(r.outcome, 'connected', `${bracket(r.host)}:${r.port} is unreachable from the role (${JSON.stringify(r)})`);
    const forwarder = probe('tcp_connect', 'forwarder');
    assert.equal(forwarder.results?.[0]?.outcome, 'connected', `control: the role reaches its forwarder (${JSON.stringify(forwarder)})`);
    assert.equal(listener.connections(), before, 'host-witnessed: the test\'s listener saw no connection from the role');
  });

  test('(b) P7: GET /v1/token/bootstrap with forged positive evidence, directly and by CONNECT through the proxy to loopback and to a host address: no connection; the proxy answers 403 with domain.egress_refused; the egress log carries no byte; no file the role reads holds the token', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addGitProject(fx)).id;
    const host = hostAddresses()[0]?.address;
    assert.ok(host, 'the host has an address beside loopback');
    const authorities = [`127.0.0.1:${fx.port}`, `[::1]:${fx.port}`, `localhost:${fx.port}`, `${bracket(host)}:${fx.port}`];
    const request = { method: 'GET', path: '/v1/token/bootstrap', headers: FORGED };
    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, domain, probe } = await probedRun(fx, project, item, {
      before: [step.probe('context_dump')],
      acts: (act) => [
        act.httpRequest('127.0.0.1', fx.port, request, { label: 'direct' }),
        ...authorities.map((a) => act.proxyConnect(a, { label: a, request })),
      ],
    });
    const direct = probe('http_request', 'direct');
    assert.equal(direct.outcome, 'no_connection', `directly: no connection (${JSON.stringify(direct)})`);
    for (const a of authorities) {
      const p = probe('proxy_connect', a);
      assert.deepEqual([p.outcome, p.status], ['answered', 403], `CONNECT ${a}: the proxy answers 403 (${JSON.stringify(p)})`);
      assert.equal(p.tunnelled_status_line ?? null, null, `CONNECT ${a}: no request reached anything through it`);
    }
    const refusals = egressRefusals(fx.home, domain.id);
    for (const a of authorities) assert.ok(refusals.some((e) => e.payload?.authority === a), `domain.egress_refused for ${a} (events: ${refusals.map((e) => e.payload?.authority).join(', ') || 'none'})`);
    const log = egressLogOf(fx.home, run.id);
    for (const a of authorities) {
      const e = entryFor(log, a);
      assert.deepEqual([e.decision, e.address, e.bytes_up, e.bytes_down], ['refused', null, 0, 0], `the egress log: ${a} refused, nothing connected, no byte carried (${JSON.stringify(e)})`);
    }
    const token = fx.engine.token();
    for (const f of probe('context_dump').files ?? []) assert.ok(!(f.text ?? '').includes(token), `${f.name} of the context package does not hold the token`);
  });
});
