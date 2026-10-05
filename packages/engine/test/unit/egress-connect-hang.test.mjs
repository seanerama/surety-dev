// Developer tests for the harness fault `egress_connect_hang` (the M128 (b)
// follow-up): the egress proxy's connection to the named, validated address
// never completes, so `egress_connect_timeout` ends it with the timeout's
// own outcome (`connect_timeout`, the limit and its figure), whatever the
// host's router would answer. No SYN is sent. A no-op outside harness mode.
// The proxy here listens in a scratch directory; nothing leaves the host.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const seam = await import(join(dist, 'testing', 'seam.js'));
const { DomainProxy } = await import(join(dist, 'invoke', 'proxy', 'proxy.js'));

const ADDRESS = '198.51.100.20';

test('outside harness mode the fault changes nothing', () => {
  seam.armConnectHang(ADDRESS);
  assert.equal(seam.seamConnectHang(ADDRESS), false);
});

test('its form: a numeric IPv4 or IPv6 address; anything else is invalid_value naming address', () => {
  assert.deepEqual(seam.parseConnectHang({ point: 'egress_connect_hang', address: ADDRESS }), { address: ADDRESS });
  assert.deepEqual(seam.parseConnectHang({ point: 'egress_connect_hang', address: '2001:db8::1' }), { address: '2001:db8::1' });
  for (const bad of [{ point: 'egress_connect_hang' }, { point: 'egress_connect_hang', address: 'named.example' }, { point: 'egress_connect_hang', address: 7 }]) {
    assert.throws(() => seam.parseConnectHang(bad), (e) => e.code === 'invalid_value' && e.subject?.field === 'address', JSON.stringify(bad));
  }
});

test('in harness mode: every attempt to an armed address hangs, arming another adds it, other addresses do not', () => {
  assert.equal(seam.configureHarness(true, []), null);
  seam.armConnectHang('192.0.2.7');
  seam.armConnectHang('203.0.113.30');
  assert.equal(seam.seamConnectHang('203.0.113.9'), false);
  for (let i = 0; i < 3; i++) assert.equal(seam.seamConnectHang('192.0.2.7'), true, 'standing');
  assert.equal(seam.seamConnectHang('203.0.113.30'), true);
});

test("the proxy's connect to the hung address ends at egress_connect_timeout, recorded as connect_timeout with the limit and its figure", async () => {
  assert.equal(seam.configureHarness(true, []), null);
  seam.armConnectHang(ADDRESS);
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-hang-'));
  const proxy = new DomainProxy({
    area: dir,
    domain: 'dom_unit',
    run: null,
    invocation: null,
    profile: 'role',
    allow: ['hang.example'],
    limits: { resolveTimeoutMs: 1000, connectTimeoutMs: 1000, tunnelMaxMs: 60_000, tunnelsMax: 2, bufferMaxBytes: 65536, logMaxBytes: 262144 },
    resolver: { resolve: async () => [ADDRESS] },
    echo: null,
  });
  await proxy.listen();
  try {
    const c = await new Promise((resolve) => {
      const s = net.connect(join(dir, 'egress.sock'), () => resolve(s));
    });
    const answered = new Promise((resolve) => {
      let t = '';
      c.on('data', (d) => (t += d));
      c.on('close', () => resolve(t));
    });
    const started = performance.now();
    c.write('CONNECT hang.example:443 HTTP/1.1\r\n\r\n');
    const text = await answered;
    const elapsed = performance.now() - started;
    assert.match(text, /^HTTP\/1\.1 504/, 'refused at the connect timeout');
    assert.ok(elapsed >= 950, `it waited for egress_connect_timeout (${Math.round(elapsed)} ms), never ended early by the network`);
    const [e] = proxy.entries;
    assert.equal(e.address, ADDRESS, 'the validated address');
    assert.equal(e.decision, 'accepted', 'a connection was attempted');
    assert.equal(e.ended, 'connect_timeout');
    assert.deepEqual(e.limit, { key: 'egress_connect_timeout', value: 1 });
  } finally {
    await proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
