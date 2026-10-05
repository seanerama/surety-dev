// Developer tests for a known zero by the egress evidence (E85, Sean's rule
// after E84; SEAM.md §174): a real backend's usage is zero, usage complete,
// no unknown allowance, the basis recorded, only when (a) its domain's only
// network path was the engine's proxy as recorded, (b) the egress log is
// complete, (c) no tunnel was accepted and no byte went up, and (d) the
// backend reported nothing but zeros. Each condition failing alone leaves
// the usage as before: unknown, the allowance charged. Against a scratch
// store with the engine's migrations; and the proxy's own account of its
// log, on a proxy that listens in a scratch directory and is never asked
// to connect anywhere.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { chargeInvocation, egressZeroBasis, EGRESS_ZERO_BASIS } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { DomainProxy } = await import(join(dist, 'invoke', 'proxy', 'proxy.js'));

const AT = '2026-10-05T15:24:14.000Z';
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// One real backend's invocation (under a trust entry) with one sandboxed,
// terminated domain and its egress_log record; `change` alters the fixture.
function store(t, change = {}) {
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`, AT);
  run(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, outcome, reason_class, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_1', ?, 'prj_1', 1, 'wi_1', 'builder', 'one_shot', 'finalizing', 'failed', 'infra_error', 'claude', '2.1.289', 'claude-sonnet-5-5', ?, ?, 0)`,
    AT,
    'a'.repeat(40),
    AT,
  );
  run(`INSERT INTO invocation_receipts (id, created_at, project, run, provider, model_requested, "grant", budget_snapshot, trust_entry) VALUES ('inv_1', ?, 'prj_1', 'run_1', 'claude', 'claude-sonnet-5-5', 'grt_1', ?, ?)`, AT, JSON.stringify({ budget_run_billable_tokens: 300000 }), change.scripted ? null : 'te_1');
  run(
    `INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile, cgroup_path, launch_binding, mount_plan_record)
     VALUES ('dom_1', ?, 'prj_1', 'run_1', 'inv_1', ?, ?, '/sys/fs/cgroup/x/dom_1', ?, ?)`,
    AT,
    change.status ?? 'terminated',
    change.profile ?? 'role',
    change.noLaunch ? null : JSON.stringify({ invocation: 'inv_1' }),
    change.noPlan ? null : 'rec_plan',
  );
  run(`INSERT INTO records (id, created_at, project, run, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES ('rec_egress', ?, 'prj_1', 'run_1', 'egress_log', 'rec_egress', 'h', 10, 'r1', 1, 'clean')`, AT);
  return db;
}

const EVIDENCE = { domain: 'dom_1', egress_log: 'rec_egress', complete: true, entries: 23, accepted: 0, bytes_up: 0 };
// The adapter's observation of E84's terminal event: no counts at all.
const ZEROED = { usage_final: false, usage_scope: 'zeroed_failure' };

function observe(db, raws) {
  raws.forEach((raw, i) =>
    db.prepare(`INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES (?, ?, 'prj_1', 'inv_1', ?, 'cumulative', ?, ?)`).run(`uo_${i}`, AT, i + 1, JSON.stringify(raw), AT),
  );
}

function charge(db, evidence) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run_1');
  transact(db, ENGINE_ACTOR, (tx) => chargeInvocation(tx, run, { id: 'inv_1', turn: null }, evidence));
  return db.prepare('SELECT * FROM ledger_rows WHERE invocation = ?').get('inv_1');
}

const isZero = (row) => {
  assert.deepEqual([row.billable_in, row.cached_in, row.out, row.cost_usd, row.cost_status, row.usage_complete, row.unknown_allowance_tokens], [0, 0, 0, 0, 'measured_zero', 1, null]);
  assert.equal(row.normalization_version, EGRESS_ZERO_BASIS);
  assert.match(row.normalization_version, /egress/);
  const basis = JSON.parse(row.raw_usage).zero_basis;
  assert.deepEqual(basis.domains, [{ domain: 'dom_1', egress_log: 'rec_egress', entries: 23, accepted: 0, bytes_up: 0 }]);
};
const isUnknown = (row) => {
  assert.equal(row.usage_complete, 0, 'usage incomplete');
  assert.ok(row.unknown_allowance_tokens > 0, `the unknown allowance charged (${row.unknown_allowance_tokens})`);
  assert.notEqual(row.normalization_version, EGRESS_ZERO_BASIS);
  assert.equal(JSON.parse(row.raw_usage).zero_basis, undefined, 'no egress basis');
};

test('all four hold (E84\'s run: every CONNECT refused, the terminal report with no counts): a known zero, its basis recorded, no allowance', (t) => {
  const db = store(t);
  observe(db, [ZEROED]);
  isZero(charge(db, [EVIDENCE]));
});

test('(d) holds with no observation at all, and with all-zero counts and cost', (t) => {
  isZero(charge(store(t), [EVIDENCE]));
  const db = store(t);
  observe(db, [{ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, total_cost_usd_estimate: 0, usage_final: true, model: 'claude-sonnet-5-5' }]);
  isZero(charge(db, [EVIDENCE]));
});

const ALONE = [
  ['(a) the domain not terminated', { status: 'quarantined' }, EVIDENCE, [ZEROED]],
  ['(a) the probe profile', { profile: 'probe' }, EVIDENCE, [ZEROED]],
  ['(a) no launch through the launcher recorded', { noLaunch: true }, EVIDENCE, [ZEROED]],
  ['(a) no mount plan recorded', { noPlan: true }, EVIDENCE, [ZEROED]],
  ['(b) no egress account of the domain (another engine closed it)', {}, null, [ZEROED]],
  ['(b) the log not complete (cut, or a tunnel open)', {}, { ...EVIDENCE, complete: false }, [ZEROED]],
  ['(b) the log record not written', {}, { ...EVIDENCE, egress_log: null }, [ZEROED]],
  ['(c) a tunnel accepted', {}, { ...EVIDENCE, accepted: 1 }, [ZEROED]],
  ['(c) a byte up', {}, { ...EVIDENCE, bytes_up: 1 }, [ZEROED]],
  ['(d) the backend reported a non-zero count', {}, EVIDENCE, [{ input_tokens: 12 }]],
  ['(d) the backend reported a non-zero cost', {}, EVIDENCE, [{ ...ZEROED, total_cost_usd_estimate: 0.01 }]],
];

for (const [what, change, evidence, raws] of ALONE) {
  test(`${what}, alone: no known zero; the usage stays as before`, (t) => {
    const db = store(t, change);
    observe(db, raws);
    const row = charge(db, evidence === null ? [] : [evidence]);
    if (raws[0].input_tokens) {
      assert.equal(row.billable_in, null, 'the backend\'s own count is kept as it is (an unknown cache creation leaves billable unknown)');
      assert.notEqual(row.normalization_version, EGRESS_ZERO_BASIS);
    } else isUnknown(row);
    const why = egressZeroBasis(db, 'inv_1', evidence === null ? [] : [evidence], raws.map((raw) => ({ raw })));
    assert.ok('none' in why && why.none.startsWith(what.slice(0, 3)), `the reason is condition ${what.slice(0, 3)}: ${JSON.stringify(why)}`);
  });
}

test('the scripted backend is never a known zero by egress: it has no provider', (t) => {
  const db = store(t, { scripted: true });
  observe(db, [ZEROED]);
  const row = charge(db, [EVIDENCE]);
  assert.notEqual(row.normalization_version, EGRESS_ZERO_BASIS);
});

test("the proxy's account: complete only once closed, with every entry closed and nothing cut; refusals counted, nothing accepted", async (t) => {
  const area = scratch(t);
  const proxy = new DomainProxy({
    area,
    domain: 'dom_1',
    run: 'run_1',
    invocation: 'inv_1',
    profile: 'role',
    allow: ['api.provider.example'],
    limits: { resolveTimeoutMs: 500, connectTimeoutMs: 500, tunnelMaxMs: 5000, tunnelsMax: 4, bufferMaxBytes: 65536, logMaxBytes: 65536 },
    resolver: { resolve: async () => Promise.reject(Object.assign(new Error('no'), { code: 'ENOTFOUND' })) },
    echo: null,
  });
  await proxy.listen();
  assert.equal(proxy.account().complete, false, 'not complete while the proxy is open');
  // One CONNECT, refused at resolution: nothing is connected anywhere.
  await new Promise((resolve) => {
    const c = net.connect(proxy.socketPath);
    c.on('data', () => c.end());
    c.on('close', resolve);
    c.on('error', resolve);
    c.write('CONNECT api.provider.example:443 HTTP/1.1\r\nHost: api.provider.example:443\r\n\r\n');
  });
  await proxy.close();
  assert.deepEqual(proxy.account(), { complete: true, entries: 1, accepted: 0, bytes_up: 0 });
  assert.equal(proxy.entries[0].reason, 'resolve_failed');
});

// A proxy in a scratch directory whose one allowed name resolves to a
// documentation address; its upstream connect is redirected per test, to a
// loopback listener of the test's own or to a socket never connected.
const realConnect = net.connect;
async function inflightProxy(t) {
  const area = scratch(t);
  const proxy = new DomainProxy({
    area,
    domain: 'dom_x',
    run: 'run_x',
    invocation: 'inv_x',
    profile: 'role',
    allow: ['api.provider.example'],
    limits: { resolveTimeoutMs: 2000, connectTimeoutMs: 5000, tunnelMaxMs: 60000, tunnelsMax: 8, bufferMaxBytes: 1 << 20, logMaxBytes: 1 << 20 },
    resolver: { resolve: async () => ['192.0.2.10'] },
    echo: null,
  });
  await proxy.listen();
  // The test's own client, by the real connect (the proxy's is replaced).
  const c = realConnect(proxy.socketPath);
  await new Promise((r) => c.once('connect', r));
  c.on('error', () => {});
  t.after(() => c.destroy());
  // The CONNECT and bytes pipelined behind it, in one write.
  c.write('CONNECT api.provider.example:443 HTTP/1.1\r\nHost: api.provider.example:443\r\n\r\nPIPELINED-BYTES');
  return proxy;
}

test('a CONNECT whose upstream connect is in flight at the close: the account is not complete; the connect ends with the run, no tunnel, no byte up', async (t) => {
  const real = net.connect;
  // A socket that never connects: the connect is in flight until destroyed.
  net.connect = () => new net.Socket();
  t.after(() => {
    net.connect = real;
  });
  const proxy = await inflightProxy(t);
  await new Promise((r) => setTimeout(r, 150));
  await proxy.close();
  // Taken as finishEgressAccount takes it: never a zero's evidence. Either
  // the attempt is still in flight (not complete), or it is logged as made.
  const at = proxy.account();
  assert.ok(!at.complete || at.accepted > 0, `in flight at the close: not complete, or the attempt logged (${JSON.stringify(at)})`);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(proxy.entries.map((e) => [e.decision, e.ended, e.bytes_up]), [['accepted', 'run_ended', 0]], 'logged as an attempt ended with the run');
});

test('an upstream connect that completes after the close (the race the close cannot win) is destroyed and logged; no tunnel, no byte up', async (t) => {
  let upBytes = 0;
  let upConns = 0;
  let upClosed = 0;
  const upstream = net.createServer((s) => {
    upConns++;
    s.on('data', (d) => (upBytes += d.length));
    s.on('close', () => upClosed++);
    s.on('error', () => {});
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => {
    upstream.closeAllConnections?.();
    upstream.close();
  });
  const real = net.connect;
  // The upstream answers 300 ms later, on loopback, and the close's destroy
  // does not reach the socket before then: the connect completes after it.
  net.connect = () => {
    const s = new net.Socket();
    const destroy = s.destroy.bind(s);
    let early = true;
    s.destroy = (...a) => (early ? s : destroy(...a));
    s.once('connect', () => {
      early = false;
    });
    setTimeout(() => s.connect(upstream.address().port, '127.0.0.1'), 300);
    t.after(() => destroy());
    return s;
  };
  t.after(() => {
    net.connect = real;
  });
  const proxy = await inflightProxy(t);
  await new Promise((r) => setTimeout(r, 100));
  await proxy.close();
  assert.equal(proxy.account().complete, false, 'in flight at the close: not complete (the connect has not ended)');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(upConns, 1, 'the fixture is live: the connect completed after the close');
  assert.equal(upBytes, 0, 'no byte reached the upstream: not the pipelined ones');
  assert.equal(upClosed, 1, 'the late connection was destroyed');
  assert.deepEqual(proxy.entries.map((e) => [e.decision, e.ended, e.bytes_up, e.closed_at !== null]), [['accepted', 'run_ended', 0, true]], 'logged, ended with the run');
});

// ---- the budget check on the backend's terminal event (fix 3 of the review) ----

const { budgetCheck } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { projectPolicy } = await import(join(dist, 'store', 'transitions', 'settings.js'));

test('on the terminal event an unknown usage is no stop; mid-run it is, as before', (t) => {
  const db = store(t);
  observe(db, [ZEROED]);
  assert.equal(budgetCheck(db, { run: 'run_1', invocation: 'inv_1', terminal: true }), null);
  assert.equal(budgetCheck(db, { run: 'run_1', invocation: 'inv_1' }), 'budget_usage_unknown');
  assert.equal(budgetCheck(db, { run: 'run_1', invocation: 'inv_1', terminal: false }), 'budget_usage_unknown');
});

test("on the terminal event a limit passed is still a stop: the run's own on what is known", (t) => {
  const db = store(t);
  const over = projectPolicy(db, 'prj_1').budget_run_billable_tokens + 1;
  observe(db, [{ input_tokens: over, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10, usage_final: true }]);
  assert.equal(budgetCheck(db, { run: 'run_1', invocation: 'inv_1', terminal: true }), 'budget_run_billable_tokens');
});

test("on the terminal event a limit passed is still a stop: the day's, with the run's usage unknown", (t) => {
  const db = store(t);
  observe(db, [ZEROED]);
  const day = new Date().toISOString().slice(0, 10);
  const over = projectPolicy(db, 'prj_1').budget_day_unknown_tokens + 1;
  db.prepare(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, role, provider, model_requested, raw_usage, normalization_version, usage_complete, cost_status, day_utc, unknown_allowance_tokens)
     VALUES ('led_0', ?, 'prj_1', 'inv_0', 'run_0', 'builder', 'claude', 'm', '{}', 'n', 0, 'unknown', ?, ?)`,
  ).run(AT, day, over);
  assert.equal(budgetCheck(db, { run: 'run_1', invocation: 'inv_1', terminal: true }), 'budget_day_unknown_tokens');
});
