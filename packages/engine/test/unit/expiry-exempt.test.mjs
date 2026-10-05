// Developer test for the M118 investigation's case (c): a run whose backend
// exited during a pause, and whose exit the re-grant step has taken
// (`expiryExempt`), is left to its exit's own protocol by the tick's expiry
// reconciliation, as an accepting run is; its lease, never re-granted for an
// exited backend, stays expired meanwhile (D2 §3.5; SEAM.md §130). A run
// without the exemption is still re-grant-checked and, failing that, ended
// for its expired lease. The runtime is a stand-in that records what the
// reconciliation asks of it.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { RunEnder } = await import(join(dist, 'runs', 'end.js'));
const { newHandle } = await import(join(dist, 'runtime.js'));

const CLAIM = { run: 'run_E', generation: 1, invocation: 'inv_E', project: 'prj_E', domain: 'dom_E', work_item: 'wi_E', work_kind: 'verification', role: 'verifier', base_revision: '0'.repeat(40) };

function standIn(handle) {
  const asked = { regrant: 0, expire: [] };
  const rt = {
    handles: new Map([[CLAIM.run, handle]]),
    read: async (name) => {
      assert.equal(name, 'runs.expired_leases');
      return [{ run: CLAIM.run, project: CLAIM.project, state: 'executing' }];
    },
    engine: async (name, args) => {
      assert.equal(name, 'run.expire');
      asked.expire.push(args);
      return null;
    },
    services: {
      regrant: async () => {
        asked.regrant++;
        return false;
      },
    },
  };
  return { ender: new RunEnder(rt), asked };
}

const sandboxed = () => {
  const handle = newHandle(CLAIM);
  handle.sandbox = {};
  return handle;
};

test('an exited run whose exit the re-grant step took is left to its own end; its expired lease does not recover it', async () => {
  const handle = sandboxed();
  handle.expiryExempt = true;
  handle.collecting = true;
  const { ender, asked } = standIn(handle);
  await ender.reconcileExpired(CLAIM.project);
  assert.equal(asked.regrant, 0, 'no second re-grant step');
  assert.deepEqual(asked.expire, [], 'no expiry end');
  assert.equal(handle.ending, false);
  assert.equal(handle.leaseLost, false);
});

test('without the exemption, the expired lease is re-grant-checked and then ended as recovered', async () => {
  const handle = sandboxed();
  const { ender, asked } = standIn(handle);
  await ender.reconcileExpired(CLAIM.project);
  assert.equal(asked.regrant, 1);
  assert.equal(asked.expire.length, 1);
  assert.equal(asked.expire[0].outcome, 'recovered');
  assert.equal(handle.ending, true);
});

test('an exempt run already ending is reconciled as before (the exemption covers only the exit\'s own protocol)', async () => {
  const handle = sandboxed();
  handle.expiryExempt = true;
  handle.ending = true;
  handle.intended = { outcome: 'completed', reason: 'none' };
  const { ender, asked } = standIn(handle);
  await ender.reconcileExpired(CLAIM.project);
  assert.equal(asked.regrant, 0, 'an ending run is not re-granted');
  assert.equal(asked.expire.length, 1, 'its expiry is reconciled through the run-end protocol');
});
