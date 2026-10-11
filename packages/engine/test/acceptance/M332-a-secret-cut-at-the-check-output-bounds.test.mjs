// M332, a delivered secret cut at a check's output bounds (the slice-28
// review, S1 (ii); sandbox lane). M4 plan §3.6 M332 (b), (d); D4-S02; D4
// §§7.2, 7.3; D3 §2.6; SEAM.md §§311, 320.
//
// A check records the first and the last halves of its output bound and
// drops what lies between (D3 §2.6). A secret the engine delivered to the
// check (`SURETY_SECRET_<NAME>`, §311) that the check prints across either
// cut must not be published in part: the redactor removes a whole held value
// or its escaped form, so a fragment would pass it and the screen. The
// project's `result_collection.output_max_bytes` is 1,024, so the head and
// the tail are 512 bytes each. The check (the target-check program, its plan
// read from the release file) writes 492 bytes of padding, the value, its
// report, the value again and 492 bytes of padding: the head ends with the
// value's first 20 bytes and the tail begins with its last 20. The case
// reads the published `check_output`: it begins and ends with the padding
// (the cuts are where the case put them), and holds no prefix and no suffix
// of the value, raw or JSON-escaped, of 8 bytes or more (§320's minimum).
// How the fragments are withheld is not pinned.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). Every unit is the engine's, under
// this test's home's prefix; the test acts on none. The check program
// writes only to its own output. The secret is a disposable random value in
// a 0600 file of the test's own directory, compared in memory. The
// environment is ended in `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { outputText } from './harness/checks/fixtures.mjs';
import { withStore } from './harness/store.mjs';
import { configure, deploy } from './harness/deploy/kernel.mjs';
import {
  endCase,
  heldCheck,
  hostConfig,
  hostDeployable,
  newestOperation,
  operatorGuard,
  releaseCheck,
  secretArgs,
  secretFile,
  serviceOf,
  ticksUntil,
  valueForms,
  verificationOf,
} from './harness/deploy/host.mjs';
import { randomBytes } from 'node:crypto';

const REF = 'deploy/m332_cut';
const VAR = 'SURETY_SECRET_M332_CUT';
const OUTPUT_MAX = 1024;
const PAD = OUTPUT_MAX / 2 - 20;
const MIN = 8;
const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });

const resultOf = (home, execution) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(execution));

// Every prefix and suffix of at least MIN bytes of each of a value's forms,
// reduced to the shortest of each (a longer one holds it), labelled.
const fragments = (value) =>
  valueForms(value).flatMap((form, i) => [
    [`form ${i}'s prefix of ${MIN}`, form.slice(0, MIN)],
    [`form ${i}'s suffix of ${MIN}`, form.slice(-MIN)],
  ]);

describe('M332 a delivered secret cut at a check\'s output bounds is not published in part', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  let dir;
  let value;
  before(async () => {
    guard = operatorGuard();
    dir = guard.root(makeTempDir('m332-cut'));
    // No `p` in it, so the padding cannot be mistaken for it; a quote, so its escaped form differs.
    value = `s1-${randomBytes(20).toString('hex')}"q`;
    ctx = await hostDeployable(shared.context, guard, {
      everyStart: secretArgs({ [REF]: secretFile(dir, 'cut', value) }),
      policy: POLICY,
      governed: { result_collection: { output_max_bytes: OUTPUT_MAX } },
      behavesFields: { secrets: [REF] },
    });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
      removeDir(dir);
    }
  });

  test('the head cut inside the value and the tail beginning inside it: no prefix or suffix of 8 bytes or more is published', async () => {
    const content = await hostConfig({ check_secrets: [REF] });
    const done = await configure(ctx.fx.engine, ctx.project, 'cut', content);
    const env = { ...done.environment, name: 'cut', content };
    ctx.envs.cut = env;
    try {
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env), { timeoutMs: 300_000, what: 'behaves to hold' });
      const op = newestOperation(ctx, env);
      releaseCheck(ctx, serviceOf(ctx, env, op), { get: [], exit: 1, first: [{ pad: PAD }, { env: VAR }], last: [{ env: VAR }, { pad: PAD }] });
      await verificationOf(ctx, op);
      const result = resultOf(ctx.fx.home, held.execution.id);
      assert.ok(result, 'the check has a result');
      assert.deepEqual([result.execution_established, result.exit_status], [1, 1], `the check ran and exited 1 (${JSON.stringify(result)})`);
      const text = outputText(ctx.fx.home, result);
      assert.ok(text.startsWith('p'.repeat(PAD)), 'the fixture is live: the published head begins with the padding, so its cut falls 20 bytes into the value');
      assert.ok(text.endsWith('p'.repeat(PAD)), 'the fixture is live: the published tail ends with the padding, so it begins 20 bytes before the value\'s end');
      assert.ok(!valueForms(value).some((f) => text.includes(f)), 'the whole value is not published (the cuts left none whole)');
      const found = fragments(value).filter(([, f]) => text.includes(f)).map(([label]) => label);
      assert.deepEqual(found, [], `no prefix or suffix of the delivered secret of ${MIN} bytes or more is published (the slice-28 review, S1 (ii); SEAM §320)`);
    } finally {
      await endCase(ctx, env);
    }
  });
});
