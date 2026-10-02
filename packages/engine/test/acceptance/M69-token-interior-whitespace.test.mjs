// M69, one case carried from the slice-2 seam decisions (listed under slice
// 3). Plan §3.7 M69; D1 §§11.1, 17(2); E23 item 8; E24 item 8; SEAM.md §§1, 6
// and 24. A well-formed token is at least 32 visible ASCII characters. The
// token travels in a request header, where a space or a tab inside it would
// be read as something else: a file whose token has one is refused like any
// other malformed token file, and is never replaced. Slice 2 pinned the
// other malformed forms and left this one unpinned.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { EXIT, freePort, makeTempDir, removeDir, sha256Hex, startRefused, writeEngineConfig } from './harness/engine.mjs';

async function freshHome(t) {
  const home = makeTempDir('m69w');
  t.after(() => removeDir(home));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  return { home, port };
}

// Every entry of the home with its kind, its mode and, for a regular file, its content hash.
function listHome(home) {
  const out = {};
  for (const name of readdirSync(home).sort()) {
    const st = lstatSync(join(home, name));
    out[name] = `${st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'} ${(st.mode & 0o777).toString(8)}${st.isFile() ? ` ${sha256Hex(readFileSync(join(home, name)))}` : ''}`;
  }
  return out;
}

// 64 characters each, every one visible ASCII but the one in the middle.
const INTERIOR = [
  ['a space', `${'a'.repeat(32)} ${'b'.repeat(31)}\n`],
  ['a tab', `${'a'.repeat(32)}\t${'b'.repeat(31)}\n`],
  ['a space after the 32nd character, the rest a second word', `${'a'.repeat(32)} ${'b'.repeat(32)}\n`],
];

describe('M69 a token with white space inside it (E24 item 8)', () => {
  for (const [name, content] of INTERIOR) {
    test(`a token file with ${name} inside the token refuses the start and is never replaced`, async (t) => {
      const { home } = await freshHome(t);
      const tokenPath = join(home, 'api.token');
      writeFileSync(tokenPath, content, { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      const before = listHome(home);
      // A start that has not exited after five seconds is an engine that accepted the file.
      const result = await startRefused({ home, timeoutMs: 5_000 });
      assert.equal(result.code, EXIT.token, `exit status (signal: ${result.signal}; stderr: ${result.stderr})`);
      assert.equal(result.refusal?.code, 'token_file_refused', `refusal code (stderr: ${result.stderr})`);
      assert.equal(result.refusal.subject?.file, 'api.token', 'the refusal names the file');
      assert.ok(result.refusal.reason && result.refusal.what_to_do, 'the refusal explains itself');
      assert.deepEqual(listHome(home), before, 'nothing written, the file left byte for byte');
      assert.equal(existsSync(join(home, 'engine.lock')), false, 'no lock taken');
      assert.equal(existsSync(join(home, 'store.db')), false, 'no store opened');
    });
  }
});
