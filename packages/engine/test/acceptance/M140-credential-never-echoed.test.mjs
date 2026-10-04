// M140 (e)'s credential rule at the engine's door: a credential given in
// place of its path is refused and never echoed (M2 slice 14, KERNEL LANE,
// manifest slice 14; no sandbox, no backend). The slice-14 review's S3
// (minor; E74 item 2); D2 §2.5; SEAM.md §§57, 160, 167.
//
// `--secret-file <ref>=<path>` takes the path of a file holding the
// credential. An operator who pastes the credential itself where the path
// belongs must be refused (`secret_file_refused`, the path not absolute),
// and the refusal, which goes to the terminal and may be copied anywhere,
// must not repeat the value: not in its reason, not in its subject, not
// anywhere the engine writes. For both auth modes' references (E74 item 1).
// The values are made up; nothing authenticates.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { makeTempDir, removeDir, startRefused, writeEngineConfig, freePort } from './harness/engine.mjs';

const CASES = [
  ['backend/claude/api_key', 'sk-ant-api03-SURETY-S3-pasted-key-not-a-path-0000000000'],
  ['backend/claude/subscription_token', 'sk-ant-oat01-SURETY-S3-pasted-token-not-a-path-000000'],
];

function filesHolding(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

describe('M140 (e) a credential given in place of its path is refused and never echoed (kernel lane)', () => {
  test('S3 (the slice-14 review): --secret-file <ref>=<the credential itself> is refused secret_file_refused, and neither the refusal nor any file of the engine home repeats the value', async (t) => {
    for (const [ref, value] of CASES) {
      const home = makeTempDir('s3');
      t.after(() => removeDir(home));
      writeEngineConfig(home, { api_port: await freePort() });
      const res = await startRefused({ home, harness: false, args: ['--secret-file', `${ref}=${value}`] });
      // The defect first: the value must not come back.
      assert.ok(!res.stderr.includes(value) && !res.stdout.includes(value), `${ref}: the refusal does not echo the credential (stderr: ${res.stderr.replaceAll(value, '[the value]').slice(0, 400)})`);
      assert.deepEqual(filesHolding(home, value), [], `${ref}: no file of the engine home holds it`);
      assert.notEqual(res.code, 0, `${ref}: the start is refused`);
      assert.equal(res.refusal?.code, 'secret_file_refused', `${ref}: as secret_file_refused (SEAM.md §160)`);
      assert.ok(typeof res.refusal?.reason === 'string' && res.refusal.reason.length > 0, `${ref}: with a reason that says what is wrong without the value`);
    }
  });
});
