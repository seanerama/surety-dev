// Developer tests for M4 slice 27's pure parts (D4 §§4.6, 6.2, 6.3; J6;
// E121 CD2; the driver's rulings on the slice-27 design): the out-of-band
// changes a read shows, their deduplication, the observed condition's
// precedence, and a teardown's reconcile mapping with the units its frozen
// intent names.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { changesFromIdentity, changesFromInventory, judgeCondition, sameChange } = await import(join(dist, 'deploy', 'environment.js'));
const { judgeReconcile } = await import(join(dist, 'deploy', 'reconcile.js'));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const APP = { pid: 100001, start_time: 1002 };
const G1 = 'p-g1.service';
const expected = (over = {}) => ({ target: 'app', unit: G1, generation: 1, invocation: 'inv1', instance: APP, digest: DIGEST, naturalExit: false, ...over });
const unit = (name, over = {}) => ({ resource: name, kind: 'unit', recorded: true, state: 'active', pendingJob: false, generation: 1, invocation_id: 'inv1', cgroup: `/cg/${name}`, ...over });
const target = (over = {}) => ({ target: 'app', unit: G1, active: true, instance: APP, generation: 1, supervision: 'attached', at: '2026-10-10T00:00:00.000Z', ...over });
const base = (over = {}) => ({ inventory: [unit(G1)], complete: true, targets: [target()], expected: expected(), permitted: [], recorded: [G1], cgroups: { [G1]: `/cg/${G1}` }, ...over });

test('the expected unit as recorded: no change', () => {
  assert.deepEqual(changesFromInventory(base()), []);
});

test('a restart is another invocation; a stop is the unit gone or inactive, unless the init reported a natural exit', () => {
  const restarted = changesFromInventory(base({ inventory: [unit(G1, { invocation_id: 'inv2', state: 'failed' })] }));
  assert.deepEqual(restarted.map((c) => [c.change, c.found.invocation_id]), [['restarted', 'inv2']]);
  assert.deepEqual(changesFromInventory(base({ inventory: [] })).map((c) => c.change), ['stopped']);
  assert.deepEqual(changesFromInventory(base({ inventory: [unit(G1, { state: 'inactive' })] })).map((c) => c.change), ['stopped']);
  assert.deepEqual(changesFromInventory(base({ inventory: [], expected: expected({ naturalExit: true }) })), [], 'a legal ending is no change');
  assert.deepEqual(changesFromInventory(base({ inventory: [], complete: false })), [], 'an absence an incomplete read implies is no change');
  assert.deepEqual(changesFromInventory(base({ inventory: [unit(G1, { state: 'unread' })] })), [], 'an unread state is no change');
});

test("the operation in flight's units are never out of band; a unit the store cannot account for always is", () => {
  assert.deepEqual(changesFromInventory(base({ inventory: [], permitted: [G1] })), []);
  const stray = unit('p-g7.service', { generation: 7, invocation_id: 'x' });
  const found = changesFromInventory(base({ inventory: [unit(G1), stray], permitted: [G1] }));
  assert.deepEqual(found.map((c) => [c.change, c.resource]), [['unexpected_unit', 'p-g7.service']]);
  const other = changesFromInventory(base({ inventory: [unit(G1, { cgroup: '/elsewhere' })] }));
  assert.deepEqual(other.map((c) => [c.change, c.found.why]), [['unexpected_unit', 'other_cgroup']]);
});

test('an identity read that differs on the bytes is a change whoever reads; on the instance, a restart unless the unit is in flight', () => {
  const differs = (over) => ({ target: 'app', method: 'tree_digest', expected: DIGEST, read: DIGEST, match: 'differs', instance: APP, generation: 1, at: 'x', ...over });
  assert.deepEqual(changesFromIdentity({ reads: [differs({ read: `sha256:${'d'.repeat(64)}` })], expected: expected(), permitted: [G1] }).map((c) => c.change), ['identity_differs']);
  assert.deepEqual(changesFromIdentity({ reads: [differs({ instance: { pid: 9, start_time: 9 } })], expected: expected(), permitted: [] }).map((c) => c.change), ['restarted']);
  assert.deepEqual(changesFromIdentity({ reads: [differs({ instance: { pid: 9, start_time: 9 } })], expected: expected(), permitted: [G1] }), []);
  assert.deepEqual(changesFromIdentity({ reads: [differs({ read: 'unread', detail: { field: 'argv' } })], expected: expected(), permitted: [] }).map((c) => c.change), ['identity_differs']);
  assert.deepEqual(changesFromIdentity({ reads: [{ ...differs({}), match: 'unread' }], expected: expected(), permitted: [] }), [], 'an unread read is no change');
});

test('the same change read again is the one recorded; what one read cannot see is not a difference', () => {
  const c = { change: 'restarted', resource: G1, expected: {}, found: { unit: G1, invocation_id: 'inv2' } };
  assert.equal(sameChange({ change: 'restarted', resource: G1, found: { invocation_id: 'inv2' } }, c), true);
  assert.equal(sameChange({ change: 'restarted', resource: G1, found: { invocation_id: 'inv3' } }, c), false);
  assert.equal(sameChange({ change: 'restarted', resource: G1, found: { instance: APP } }, c), true);
  assert.equal(sameChange({ change: 'identity_differs', resource: G1, found: { digest: 'a', field: 'tree' } }, { ...c, change: 'identity_differs', found: { digest: 'b', field: 'tree' } }), false);
});

test("D4 §6.2's precedence with CD2", () => {
  const read = { complete: true, inventory: [unit(G1)], targets: [target()] };
  const j = (over = {}) => judgeCondition({ read, identityUnread: false, expected: expected(), supervision: 'attached', newestIdentity: null, unexpectedActive: false, drift: 0, ...over });
  assert.equal(j().condition, 'healthy');
  assert.equal(j({ read: null }).condition, 'unknown');
  assert.equal(j({ read: { ...read, complete: false } }).condition, 'unknown');
  assert.equal(j({ identityUnread: true }).condition, 'unknown');
  assert.equal(j({ read: { complete: true, inventory: [], targets: [] } }).condition, 'down');
  assert.deepEqual(j({ read: { complete: true, inventory: [], targets: [] }, drift: 1 }), { condition: 'down', detail: { code: 'out_of_band' } }, 'the drift beside down');
  assert.equal(j({ read: { ...read, targets: [target({ instance: null })] } }).condition, 'down', 'the unit active with its application exited is never healthy');
  assert.equal(j({ drift: 1 }).condition, 'degraded');
  assert.equal(j({ unexpectedActive: true }).condition, 'degraded');
  assert.deepEqual(j({ supervision: 'unknown' }), { condition: 'degraded', detail: { code: 'supervision_unknown' } }, 'CD2');
  assert.equal(j({ newestIdentity: { match: 'differs' } }).condition, 'degraded');
});

test("a teardown's read: an owned survivor it does not name is partial; a unit it cannot own is conflicting; an empty stop list is never absent", () => {
  const read = (inventory) => ({ ok: { outcome: 'unknown', complete: true, inventory, reads: [], identity: [] } });
  const teardown = (over = {}) => ({ kind: 'teardown', prefix: 'p-', digest: null, create_units: [], prior: [], stop_units: [], recorded: [G1], recorded_cgroups: { [G1]: `/cg/${G1}` }, launch_granted: false, app_instance: null, ...over });
  const dir = { resource: '/run/env-g1', kind: 'directory', recorded: true, state: 'present', pendingJob: false, generation: 1 };
  assert.equal(judgeReconcile(read([dir]), teardown()).outcome, 'partial');
  assert.equal(judgeReconcile(read([unit('p-g7.service', { generation: 7 })]), teardown()).outcome, 'conflicting');
  assert.equal(judgeReconcile(read([unit(G1)]), teardown({ stop_units: [G1] })).outcome, 'absent');
  assert.equal(judgeReconcile(read([]), teardown({ stop_units: [G1] })).outcome, 'applied');
});

// The slice-27 review, S2: a target read active whose application was not
// read is unread, whatever is expected.
test('an active target whose application was not read is unknown, expected or not', () => {
  const read = { complete: true, inventory: [unit(G1)], targets: [target({ instance: 'unread' })] };
  for (const exp of [expected(), null]) {
    assert.equal(judgeCondition({ read, identityUnread: false, expected: exp, supervision: null, newestIdentity: null, unexpectedActive: false, drift: 0 }).condition, 'unknown');
  }
});

// The slice-27 review, S1: only a row with no disposition counts in a
// round's interval; one answered teardown or acknowledge is settled.
test("a round's interval counts only rows with no disposition", async (t) => {
  const { default: Database } = await import('better-sqlite3');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { migrate } = await import(join(dist, 'store', 'migrate.js'));
  const { changesInInterval } = await import(join(dist, 'store', 'transitions', 'observe.js'));
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  const row = (id, detected, disposition, closed = null) =>
    db
      .prepare(
        `INSERT INTO out_of_band_changes (id, created_at, project, subject_kind, expected, found, detected_at, disposition, decision, closed_at, environment, resource, change)
         VALUES (?, ?, 'prj_1', 'environment', '{}', '{}', ?, ?, 'dec_x', ?, 'env_1', 'u', 'stopped')`,
      )
      .run(id, detected, detected, disposition, closed);
  row('oob_open_before', '2026-10-10T00:00:00.000Z', null);
  row('oob_in', '2026-10-10T00:05:00.000Z', null);
  row('oob_teardown', '2026-10-10T00:05:00.000Z', 'teardown');
  row('oob_ack', '2026-10-10T00:05:00.000Z', 'acknowledge');
  row('oob_closed_before', '2026-10-10T00:00:00.000Z', null, '2026-10-10T00:01:00.000Z');
  assert.deepEqual(changesInInterval(db, { environment: 'env_1', from: '2026-10-10T00:02:00.000Z', to: '2026-10-10T00:10:00.000Z' }).sort(), ['oob_in', 'oob_open_before']);
});
