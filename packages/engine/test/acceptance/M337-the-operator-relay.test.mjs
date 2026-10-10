// M337, the operator relay (slice 28; sandbox lane). M4 plan §3.6 M337;
// D4-T10; D4 §5.2; Q7; N04; the driver's rulings on the slice-28 Builder's
// design; SEAM.md §§256 to 259, 268, 277, 310, 317.
//
// `POST …/environments/:e/relay` (`surety env open`) opens a relay on
// `127.0.0.1:<the running generation's configured port>` to that
// generation's service; `DELETE …/relay` (`surety env close`) closes it. In
// order, on one deployed service and its successors:
//   (a) by default nothing listens on the port;
//   (c) with the port held by the test's own listener: 409
//       `relay_port_in_use`, the listener untouched (it still answers);
//   (b) opened: one listener on the port, on 127.0.0.1 only (host-read
//       `/proc/net/tcp` and `tcp6`), the engine's own socket; a request
//       through it is answered by the service; `environment.relay_opened`;
//   (d) the link's limits: `service_link_tunnels_max` 1: a second connection
//       while one is open gets no answer; once the first closes, a third
//       does;
//   (h) it carries application data only: a request for an engine route
//       with the engine's token is answered by the service (its 404), and no
//       answer carries the token; a control message written raw reaches the
//       application's parser, and the service runs on as it was;
//   (f) `DELETE` closes it (`environment.relay_closed`): nothing listens;
//   (e) a redeploy while it is open: the old generation's end closes it,
//       open tunnels included, and it is never retargeted (nothing listens
//       while the new generation runs); opened again it reaches the new
//       generation (another instance's start marker);
//   (f) a teardown closes it;
//   (g) a service whose supervision is lost (`control_channel_dropped`):
//       the open relay answers nothing more, and opening it is 409
//       `redaction_unavailable`.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 277). Every unit is the engine's,
// under this test's home's prefix; the test acts on none. The test's own
// listener is on 127.0.0.1 and closed in `finally`. The relay's connections
// are the test's own; the raw control message it writes reaches only the
// test's own service. Nothing is signalled. Every environment is ended in
// `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { deploy, environmentRead } from './harness/deploy/kernel.mjs';
import {
  armDeployFault,
  endCase,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  newestOperation,
  operatorGuard,
  procInstance,
  releaseCheck,
  serviceOf,
  teardownOnHost,
  ticksUntil,
  verificationOf,
} from './harness/deploy/host.mjs';

const ENGINE = Object.freeze({ service_link_tunnels_max: 1 });
const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const EXIT_1 = Object.freeze({ get: ['/hello'], exit: 1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One TCP exchange with 127.0.0.1:<port>: connect, write `data`, read until
// the peer closes or `timeoutMs`. {connected, text, closed}.
function exchange(port, data, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let connected = false;
    let done = false;
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const finish = (closed) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ connected, text: Buffer.concat(chunks).toString('utf8'), closed });
    };
    sock.on('connect', () => {
      connected = true;
      if (data !== null) sock.write(data);
    });
    sock.on('data', (d) => chunks.push(d));
    sock.on('close', () => finish(true));
    sock.on('error', () => finish(true));
    setTimeout(() => finish(false), timeoutMs).unref();
  });
}
const get = (port, path, headers = '') => exchange(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${headers}\r\n`);
const bodyOf = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4));
  } catch {
    return null;
  }
};

// A connection held open: connected, a request's head begun and not ended.
function holdOpen(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.on('connect', () => {
      sock.write('GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      resolve(sock);
    });
    sock.on('error', reject);
  });
}

// The listening sockets on `port` in the host's network namespace, read from
// /proc/net/tcp and tcp6: [{family, local, inode}].
function hostListeners(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out = [];
  for (const [family, path] of [['tcp', '/proc/net/tcp'], ['tcp6', '/proc/net/tcp6']]) {
    let lines = [];
    try {
      lines = readFileSync(path, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const l of lines) {
      const f = l.trim().split(/\s+/);
      if (f.length > 9 && f[1].endsWith(`:${hex}`) && f[3] === '0A') out.push({ family, local: f[1], inode: f[9] });
    }
  }
  return out;
}
const socketInodesOf = (pid) =>
  readdirSync(`/proc/${pid}/fd`)
    .map((fd) => {
      try {
        return /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);

describe('M337 the operator relay', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  let env;
  let port;
  let svc;
  const relayPath = () => `/v1/projects/${ctx.project}/environments/${env.name}/relay`;
  const open = () => ctx.fx.engine.post(relayPath(), {});
  const close = () => ctx.fx.engine.request('DELETE', relayPath());
  const relayEvents = (type) => eventsOfType(ctx.fx.home, type).filter((e) => e.subject?.environment === env.id);

  // The environment's current service deployed, its round settled (exit 1).
  async function deployed() {
    const known = newestOperation(ctx, env)?.id ?? null;
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    const op = await ticksUntil(ctx.fx, ctx.project, () => {
      const o = newestOperation(ctx, env);
      return o && o.id !== known && heldCheck(ctx, env) ? o : undefined;
    }, { timeoutMs: 300_000, what: `the deploy of ${env.name} to reach its round's check` });
    const s = serviceOf(ctx, env, op);
    releaseCheck(ctx, s, EXIT_1);
    await verificationOf(ctx, op);
    return s;
  }

  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { engineConfig: ENGINE, policy: POLICY });
    env = await hostEnvironment(ctx, 'relay');
    port = env.content.port;
    svc = await deployed();
  });
  after(async () => {
    try {
      if (env) await endCase(ctx, env);
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) closed by default: nothing listens on the configured port', async () => {
    assert.deepEqual(hostListeners(port), [], 'host-read: no listener on the port');
    assert.equal((await get(port, '/hello')).connected, false, 'a connection is refused');
  });

  test('(c) the port held by the test\'s own listener: relay_port_in_use, the listener untouched', async () => {
    const own = net.createServer((s) => s.end('test-own-listener\n'));
    await new Promise((resolve, reject) => {
      own.once('error', reject);
      own.listen(port, '127.0.0.1', resolve);
    });
    try {
      const res = await open();
      assert.deepEqual([res.status, res.body?.code], [409, 'relay_port_in_use'], `refused relay_port_in_use (D4 §5.2) (${res.text})`);
      const still = await exchange(port, null);
      assert.ok(still.text.includes('test-own-listener'), 'the test\'s listener still answers: untouched');
    } finally {
      await new Promise((resolve) => own.close(resolve));
    }
  });

  test('(b), (d), (h) opened: on 127.0.0.1 only, the engine\'s socket, answered by the service; the link\'s tunnel limit; application data only', async () => {
    const res = await open();
    assert.ok(res.status >= 200 && res.status < 300, `the relay opens (${res.text})`);
    assert.equal(relayEvents('environment.relay_opened').length, 1, 'environment.relay_opened');
    const listeners = hostListeners(port);
    assert.equal(listeners.length, 1, `(b) exactly one listener on the port (${JSON.stringify(listeners)})`);
    assert.deepEqual([listeners[0].family, listeners[0].local.split(':')[0]], ['tcp', '0100007F'], '(b) bound on 127.0.0.1 only');
    assert.ok(socketInodesOf(ctx.fx.engine.pid).includes(listeners[0].inode), '(b) the engine\'s own socket');
    const hello = bodyOf((await get(port, '/hello')).text);
    assert.equal(hello?.mark, env.content.env.MARK, `(b) answered by the service (${JSON.stringify(hello)})`);

    // (d) service_link_tunnels_max 1.
    const first = await holdOpen(port);
    try {
      await sleep(500);
      const second = await get(port, '/hello');
      assert.ok(!second.text.includes('HTTP/1.1 200'), `(d) a second connection while one is open gets no answer (${JSON.stringify(second.text.slice(0, 100))})`);
    } finally {
      first.destroy();
    }
    await sleep(500);
    assert.ok((await get(port, '/hello')).text.includes('HTTP/1.1 200'), '(d) once the first closes, another is answered');

    // (h) no engine token, no control endpoint.
    const token = ctx.fx.engine.token();
    const engineRoute = await get(port, `/v1/projects/${ctx.project}/environments/${env.name}`, `x-surety-token: ${token}\r\n`);
    assert.equal(bodyOf(engineRoute.text)?.error, 'no such route', `(h) an engine route through the relay is answered by the service, not the engine (${engineRoute.text.slice(0, 200)})`);
    assert.ok(!engineRoute.text.includes(token), '(h) no answer carries the engine\'s token');
    const before = procInstance(svc.app.pid);
    await exchange(port, `${JSON.stringify({ t: 'term' })}\n`, { timeoutMs: 3000 });
    await sleep(1000);
    assert.deepEqual(procInstance(svc.app.pid), before, '(h) a control message written raw reaches the application\'s parser only: the service runs on as it was');
    assert.equal((await environmentRead(ctx.fx.engine, ctx.project, env.name)).supervision, 'attached', '(h) and its supervision is untouched');
  });

  test('(f) closed by command: nothing listens; environment.relay_closed', async () => {
    const res = await close();
    assert.ok(res.status >= 200 && res.status < 300, `the relay closes (${res.text})`);
    assert.deepEqual(hostListeners(port), [], 'nothing listens on the port');
    assert.ok(relayEvents('environment.relay_closed').length >= 1, 'environment.relay_closed');
  });

  test('(e) a redeploy while open: the old generation\'s end closes it, its tunnel included; never retargeted; opened again it reaches the new generation', async () => {
    assert.ok((await open()).status < 300, 'the relay opens on the first generation');
    const marker1 = bodyOf((await get(port, '/probe')).text)?.tmp_marker;
    assert.ok(marker1, 'the first generation\'s start marker');
    const tunnel = await holdOpen(port);
    let tunnelClosed = false;
    tunnel.on('close', () => {
      tunnelClosed = true;
    });
    const closedBefore = relayEvents('environment.relay_closed').length;
    svc = await deployed();
    assert.ok(tunnelClosed, '(e) the tunnel open at the old generation\'s end was closed');
    assert.deepEqual(hostListeners(port), [], '(e) the relay closed with its generation: nothing listens while the new one runs (never retargeted)');
    assert.ok(relayEvents('environment.relay_closed').length > closedBefore, '(e) environment.relay_closed');
    assert.ok((await open()).status < 300, 'opened again');
    const marker2 = bodyOf((await get(port, '/probe')).text)?.tmp_marker;
    assert.ok(marker2 && marker2 !== marker1, `(e) it reaches the new generation (${marker1} → ${marker2})`);
  });

  test('(f) a teardown closes it', async () => {
    const down = await teardownOnHost(ctx, env);
    assert.ok(down, 'the teardown is applied');
    assert.deepEqual(hostListeners(port), [], 'nothing listens on the port after the teardown');
  });

  test('(g) supervision lost: the open relay answers nothing more; opening it is redaction_unavailable', async () => {
    svc = await deployed();
    assert.ok((await open()).status < 300, 'the fixture is live: the relay opens');
    await armDeployFault(ctx, env, 'control_channel_dropped');
    await ticksUntil(ctx.fx, ctx.project, async () => ((await environmentRead(ctx.fx.engine, ctx.project, env.name)).supervision === 'unknown' ? true : undefined), { what: 'supervision to read unknown' });
    assert.ok(!(await get(port, '/hello')).text.includes('HTTP/1.1 200'), 'the open relay answers nothing more (D4 §§5.2, 7.3)');
    const res = await open();
    assert.deepEqual([res.status, res.body?.code], [409, 'redaction_unavailable'], `opening it is refused (${res.text})`);
  });
});
