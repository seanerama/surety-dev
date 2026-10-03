// The egress proxy as the tests drive and read it (M2 slice 12, rows M126
// to M128; D2 §2.4, A.6 P6 to P8, A.7; SEAM.md §140): the harness resolver,
// the echo endpoint's own log, the domain's `egress_log` record, the
// `domain.egress_refused` events, and the host-side listeners whose silence
// is the witness that a role reached nothing.
//
// NETWORK (the Verifier's brief, rule 4). Nothing here reaches the internet.
// The resolver's answers are constructed; where an answer has to be a
// "public" address it is taken from the documentation ranges (192.0.2.0/24,
// 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), which are routed nowhere;
// names are under the reserved `.example` and `.invalid`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';

import { recordFile } from '../records.mjs';
import { withStore } from '../store.mjs';

// The one destination the `probe` profile may reach beside its list (D2
// §2.4, §7.1): the engine's own echo endpoint, under this authority.
export const ECHO_HOST = 'echo.surety.invalid';
export const ECHO_AUTHORITY = `${ECHO_HOST}:443`;

// Documentation addresses: never a real host.
export const DOC = Object.freeze({ a: '192.0.2.10', b: '198.51.100.20', c: '203.0.113.30', v6: '2001:db8::10' });

// The proxy's limits at the smallest values D2 A.7's ranges allow, so that a
// case reaches each in seconds (the tunnel's lifetime is a minute at least).
export const PROXY_LIMITS = Object.freeze({
  egress_resolve_timeout: 1,
  egress_connect_timeout: 1,
  egress_tunnel_max_seconds: 60,
  egress_tunnels_max: 2,
  egress_buffer_max_bytes: 65536,
  egress_log_max_bytes: 262144,
});

// ---- the harness resolver (SEAM.md §140) -------------------------------------------------

// Replace the resolver's map. `names` maps a name to its answer sets, one per
// resolution in order (the last repeats), or to {answers, delay_ms}.
export async function setResolver(engine, names) {
  const body = { names: Object.fromEntries(Object.entries(names).map(([name, v]) => [name, Array.isArray(v) ? { answers: v } : v])) };
  const res = await engine.post('/v1/harness/resolver', body);
  assert.ok(res.status >= 200 && res.status < 300, `POST /v1/harness/resolver (status ${res.status}, body: ${res.text})`);
}

// How often each name was resolved: {name: queries}.
export async function resolverQueries(engine) {
  const res = await engine.get('/v1/harness/resolver');
  assert.equal(res.status, 200, `GET /v1/harness/resolver (body: ${res.text})`);
  assert.ok(res.body?.names && typeof res.body.names === 'object', `the resolver read lists names (body: ${res.text.slice(0, 300)})`);
  return Object.fromEntries(Object.entries(res.body.names).map(([name, v]) => [name, v.queries]));
}

// ---- the echo endpoint's own log (SEAM.md §140) ------------------------------------------

export async function echoConnections(engine, { domain } = {}) {
  const res = await engine.get('/v1/harness/echo');
  assert.equal(res.status, 200, `GET /v1/harness/echo (body: ${res.text})`);
  assert.ok(Array.isArray(res.body?.connections), `the echo read lists connections (body: ${res.text.slice(0, 300)})`);
  return res.body.connections.filter((c) => domain === undefined || c.domain === domain);
}

// ---- the egress log and the refusal events -----------------------------------------------

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// The domain's `egress_log` record of a run (SEAM.md §140): the row, its
// entries (one JSON object per line, in order) and the truncation marker if
// the record ends with one. Throws while the run has no such record.
export function egressLogOf(home, runId) {
  const rows = withStore(home, (db) => db.prepare(`SELECT * FROM "records" WHERE "kind" = 'egress_log' AND "run" = ? ORDER BY rowid`).all(runId));
  assert.equal(rows.length, 1, `one egress_log record for the run's domain (found ${rows.length})`);
  const [row] = rows;
  assert.equal(row.published, 1, 'the egress log is published');
  const text = readFileSync(recordFile(home, row), 'utf8');
  const lines = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  const marker = lines.at(-1)?.truncated === true ? lines.pop() : null;
  return { row, bytes: Buffer.byteLength(text), entries: lines, marker };
}

export const egressLogRows = (home, runId) => withStore(home, (db) => db.prepare(`SELECT * FROM "records" WHERE "kind" = 'egress_log' AND "run" = ?`).all(runId));

// The `domain.egress_refused` events about a domain, oldest first.
export const egressRefusals = (home, domainId) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "events" WHERE "type" = 'domain.egress_refused' ORDER BY "seq"`).all())
    .map((row) => ({ ...row, subject: json(row.subject), payload: json(row.payload) }))
    .filter((row) => row.subject?.domain === domainId);

// One log entry about an authority, required to exist once.
export function entryFor(log, authority) {
  const found = log.entries.filter((e) => e.authority === authority);
  assert.equal(found.length, 1, `one egress_log entry for ${authority} (found ${found.length}; the log has: ${log.entries.map((e) => e.authority).join(', ') || 'nothing'})`);
  return found[0];
}

// An entry has the fields D2 §2.4 names: destination, resolved address,
// byte counts and times.
export function assertEntryForm(e) {
  assert.ok(typeof e.authority === 'string' && e.authority.length > 0, `an entry names its destination (${JSON.stringify(e)})`);
  assert.ok(['accepted', 'refused'].includes(e.decision), `an entry says accepted or refused (${JSON.stringify(e)})`);
  assert.ok(Array.isArray(e.resolved), `an entry lists what the name resolved to, [] when it was not resolved (${JSON.stringify(e)})`);
  assert.ok(e.address === null || typeof e.address === 'string', `an entry names the address connected to, or null (${JSON.stringify(e)})`);
  assert.ok(Number.isInteger(e.bytes_up) && Number.isInteger(e.bytes_down), `an entry counts bytes each way (${JSON.stringify(e)})`);
  for (const key of ['opened_at', 'closed_at']) assert.ok(typeof e[key] === 'string' && !Number.isNaN(Date.parse(e[key])), `an entry has ${key} (${JSON.stringify(e)})`);
  assert.ok(typeof e.ended === 'string' && e.ended.length > 0, `an entry says how the connection ended (${JSON.stringify(e)})`);
  if (e.decision === 'refused') assert.ok(typeof e.reason === 'string' && e.reason.length > 0, `a refused entry says why (${JSON.stringify(e)})`);
}

// ---- host-side witnesses -----------------------------------------------------------------

// Every address of the host's own interfaces that is not loopback.
export function hostAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => ({ address: a.address, family: a.family }));
}

// A TCP listener of the test's own on every address of the host, on a port
// the kernel picks: {port, connections(), close()}. Its count is the
// host-side witness that a role's connection attempts reached nothing.
export async function sentinelListener(t) {
  const seen = [];
  const server = net.createServer((socket) => {
    seen.push({ from: socket.remoteAddress, at: Date.now() });
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::', resolve);
  });
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port, connections: () => seen.length, seen };
}

// One connection from the host itself: the control that a listener is alive.
export function hostConnects(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
