// M221 (e), the runner qualification fixture exists only in harness mode
// (M3 slice 18; kernel lane). M3 plan §3.4 M221 (e), question 2; E92 item
// 2; D3 §2.8; SEAM.md §§7, 181, 208. The sandbox-lane cases of the row are
// `M221-the-runner-self-test-and-the-binding.test.mjs`; that the journey
// passes without the fixture is M201 (f),
// `M201-the-journey-qualified-by-the-self-test.test.mjs`.
//
// Outside harness mode the runner qualification fixture's route is 404
// `not_found` and changes nothing: no host qualification's `check_runner`
// carries the fixture's label. The harness flags of slice 18 (the self-test switch, the
// forcing of a case, the profile variant, the check domain limits) are
// each a usage error without `--harness` (SEAM.md §1, exit 2).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXIT, engineFixture, makeTempDir, removeDir, startRefused, writeEngineConfig, freePort } from './harness/engine.mjs';
import { withStore } from './harness/store.mjs';

// Host qualification rows whose check_runner carries the fixture's label.
const fixtureLabelled = (home) =>
  withStore(home, (db) => db.prepare('SELECT "id", "check_runner" FROM "host_qualifications" WHERE "check_runner" IS NOT NULL').all()).filter((r) => JSON.parse(r.check_runner)?.test_fixture === true);

describe('M221 (e) the runner qualification fixture exists only in harness mode', () => {
  test('outside harness mode the fixture route is 404 not_found and sets no check_runner', async (t) => {
    const fx = await engineFixture(t, { harness: false });
    const info = await fx.engine.engineInfo();
    assert.notEqual(info.harness, true, 'the fixture is live: the engine is not in harness mode');
    const res = await fx.engine.post('/v1/harness/fixtures/runner-qualification', { runner_class: 'direct' });
    assert.deepEqual([res.status, res.body?.code], [404, 'not_found'], `the route does not exist outside harness mode (SEAM.md §7) (body: ${res.text})`);
    assert.deepEqual(fixtureLabelled(fx.home), [], "and no host qualification's check_runner carries the fixture's label");
  });

  test("slice 18's harness flags are each a usage error without --harness", async (t) => {
    const home = makeTempDir('m221e');
    t.after(() => removeDir(home));
    writeEngineConfig(home, { api_port: await freePort() });
    for (const args of [
      ['--harness-runner-self-test', 'run'],
      ['--harness-runner-self-test-case', 'exit_zero=failed'],
      ['--harness-check-profile-variant', 'b'],
      ['--harness-check-domain-limits', 'memory_max=67108864'],
    ]) {
      const refused = await startRefused({ home, harness: false, args });
      assert.equal(refused.code, EXIT.usage, `${args[0]} without --harness is a usage error, exit ${EXIT.usage} (exit ${refused.code}; stderr ${refused.stderr.slice(-300)})`);
    }
  });
});
