// Developer tests for slice 4's pure parts: the scripted provider's
// normalization and the fold of observations, the stream redactor, and which
// git commands are asked about filter drivers first.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { foldObservations, normalize, totalsOf } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { StreamRedactor, holdSecret, redactValue } = await import(join(dist, 'records', 'redact.js'));
const { mayRunFilter } = await import(join(dist, 'git', 'exec.js'));

test('normalization keeps cache reads apart, and an unknown is null, never zero', () => {
  assert.deepEqual(normalize({ input_tokens: 7, output_tokens: 3 }), {
    billable_in: 7,
    cached_in: null,
    out: 3,
    model_observed: null,
    cost_status: 'unknown',
    cost_usd: null,
    normalization_version: 'scripted-1',
  });
  assert.equal(normalize({ cost_usd: 0 }).cost_status, 'measured_zero');
  assert.equal(normalize({ cost_usd: 0.5 }).cost_status, 'reported');
  const estimated = normalize({ input_tokens: 1_000_000, cache_read_tokens: 2_000_000, output_tokens: 500_000, model: 'scripted-priced' });
  assert.deepEqual([estimated.cost_status, estimated.cost_usd, estimated.normalization_version], ['estimated', 7, 'scripted-1+scripted-prices-1']);
  assert.equal(normalize({ input_tokens: 1, output_tokens: 1, model: 'scripted-priced' }).cost_status, 'unknown', 'no estimate without every amount');
});

test('cumulative observations keep the latest value, delta observations sum', () => {
  assert.deepEqual(foldObservations([{ semantics: 'cumulative', raw: { input_tokens: 1 } }, { semantics: 'cumulative', raw: { input_tokens: 5, output_tokens: 2 } }]), { input_tokens: 5, output_tokens: 2 });
  assert.deepEqual(foldObservations([{ semantics: 'delta', raw: { input_tokens: 1 } }, { semantics: 'delta', raw: { input_tokens: 5, output_tokens: 2 } }]), { input_tokens: 6, output_tokens: 2 });
});

test('totals of nothing are null, not zero', () => {
  assert.deepEqual(totalsOf([]), {
    invocations: 0,
    billable_in: null,
    cached_in: null,
    out: null,
    usage_incomplete: 0,
    reported_usd: null,
    estimated_usd: null,
    unknown_cost_invocations: 0,
    unknown_cost_tokens: null,
    unknown_allowance_tokens: null,
  });
});

test('the stream redactor finds a secret however the stream is cut', () => {
  const secret = 'clé-SECRET-ü-42';
  holdSecret('unit', secret);
  const text = Buffer.from(`a ${secret} b ${secret}`);
  for (let cut = 0; cut <= text.length; cut++) {
    for (let cut2 = cut; cut2 <= text.length; cut2 += 3) {
      const r = new StreamRedactor();
      const out = Buffer.concat([r.push(text.subarray(0, cut)), r.push(text.subarray(cut, cut2)), r.push(text.subarray(cut2)), r.end()]).toString('utf8');
      assert.equal(out, 'a [REDACTED] b [REDACTED]', `cut at ${cut} and ${cut2}`);
    }
  }
  assert.deepEqual(redactValue({ summary: `x${secret}y`, [secret]: [secret] }), { summary: 'x[REDACTED]y', '[REDACTED]': ['[REDACTED]'] });
});

test('only a command that cannot run a filter driver skips the query', () => {
  for (const args of [['rev-parse', 'HEAD'], ['cat-file', '-e', 'x'], ['update-ref', 'r', 'x'], ['worktree', 'add', '--no-checkout', '--detach', '--', '/p', 'x'], ['worktree', 'remove', '--force', '--force', '--', '/p'], ['hash-object', '-w', '--stdin']]) {
    assert.equal(mayRunFilter(args), false, args.join(' '));
  }
  for (const args of [['add', '-A'], ['write-tree'], ['read-tree', 'HEAD'], ['status'], ['reset', '--hard'], ['worktree', 'add', '--detach', '--', '/p', 'x'], ['worktree', 'remove', '/p'], ['hash-object', 'a.txt'], ['cat-file', '--filters', 'x'], ['ls-files', '-m'], ['frobnicate']]) {
    assert.equal(mayRunFilter(args), true, args.join(' '));
  }
});

test('C4: the unknown allowance in force is the original row\'s until a correction says the usage is complete', async () => {
  const { fold } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
  const row = (over) => ({
    id: 'led_1', invocation: 'inv_1', role: 'builder', day_utc: '2026-10-03', billable_in: 100, cached_in: null, out: 50, cost_status: 'unknown', cost_usd: null,
    usage_complete: 0, corrects: null, correction_seq: null, unknown_allowance_tokens: 850, ...over,
  });
  // A limit of 1000: 150 observed, 850 unknown.
  assert.equal(fold([row({})]).unknown_allowance_tokens, 850);
  // A correction that does not say the usage is complete leaves the allowance in force.
  const correction = row({ id: 'led_2', corrects: 'led_1', correction_seq: 1, billable_in: 200, out: 100, unknown_allowance_tokens: null });
  assert.equal(fold([row({}), correction]).unknown_allowance_tokens, 850);
  // One that says the usage is complete releases it.
  assert.equal(fold([row({}), { ...correction, usage_complete: 1 }]).unknown_allowance_tokens, 0);
  // An invocation charged no allowance has none.
  assert.equal(fold([row({ unknown_allowance_tokens: null })]).unknown_allowance_tokens, null);
});
