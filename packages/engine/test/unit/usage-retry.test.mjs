// Developer tests for E37 item 3: a usage observation the engine could not
// record is never lost silently. A store failure is retried; after one failed
// write the observation is recorded and the budget checked on it; if it can
// never be recorded, the run is stopped as when the budget cannot be read.
// The choke point is driven with a stand-in runtime that fails the store
// write as asked.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { Launcher } = await import(join(dist, 'invoke', 'choke.js'));
const { newHandle } = await import(join(dist, 'runtime.js'));

const CLAIM = { run: 'run_U', generation: 1, invocation: 'inv_U', project: 'prj_U', domain: 'dom_U', work_item: 'wi_U', work_kind: 'verification', role: 'verifier', base_revision: '0'.repeat(40) };

function standIn(failures, limit = null) {
  const calls = { usage: 0, recorded: [], budget: 0, ends: [] };
  const rt = {
    role: async (name, _run, args) => {
      assert.equal(name, 'run.usage');
      calls.usage++;
      if (calls.usage <= failures) throw Object.assign(new Error('injected store failure'), { code: 'store_error' });
      calls.recorded.push(args.raw);
      return true;
    },
    read: async (name) => {
      assert.equal(name, 'budget.check');
      calls.budget++;
      return limit;
    },
    heartbeat: async () => {},
    requestEnd: (handle, end) => {
      if (handle.ending) return;
      handle.ending = true;
      handle.intended = end;
      calls.ends.push(end);
    },
  };
  const handle = newHandle(CLAIM);
  return { launcher: new Launcher(rt), handle, calls };
}

const usageLine = JSON.stringify({ type: 'usage', semantics: 'delta', raw: { input_tokens: 50000, output_tokens: 10 } });

test('one failed write: the observation is recorded and the budget stop happens', async () => {
  const { launcher, handle, calls } = standIn(1, 'run_billable_tokens');
  await launcher.callback(handle, usageLine);
  assert.equal(calls.usage, 2, 'the write was retried');
  assert.deepEqual(calls.recorded, [{ input_tokens: 50000, output_tokens: 10 }]);
  assert.equal(calls.budget, 1, 'the budget was checked on the recorded observation');
  assert.deepEqual(calls.ends, [{ outcome: 'stopped', reason: 'budget', reasonText: 'run_billable_tokens' }]);
});

test('one failed write under the limit: recorded, and the run goes on', async () => {
  const { launcher, handle, calls } = standIn(1, null);
  await launcher.callback(handle, usageLine);
  assert.equal(calls.recorded.length, 1);
  assert.deepEqual(calls.ends, []);
});

test('a write that never succeeds stops the run as an unreadable budget does', { timeout: 30000 }, async () => {
  const { launcher, handle, calls } = standIn(Number.POSITIVE_INFINITY, null);
  await launcher.callback(handle, usageLine);
  assert.ok(calls.usage > 1, 'the write was retried');
  assert.deepEqual(calls.recorded, []);
  assert.deepEqual(calls.ends, [{ outcome: 'stopped', reason: 'budget', reasonText: 'budget_unreadable' }]);
});

test('no retry once the engine has decided to end the run', async () => {
  const { launcher, handle, calls } = standIn(Number.POSITIVE_INFINITY, null);
  handle.ending = true;
  await launcher.callback(handle, usageLine);
  assert.equal(calls.usage, 0);
  assert.deepEqual(calls.ends, []);
});
