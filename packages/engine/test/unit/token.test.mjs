// Developer tests for api.token (src/token.ts): an existing file the engine
// cannot trust is refused and left as it was; a new token appears whole.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { createToken, readToken } = await import(join(dist, 'token.js'));

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const refused = (fn) =>
  assert.throws(fn, (err) => err.code === 'token_file_refused' && err.subject?.file === 'api.token' && Boolean(err.reason && err.whatToDo));

test('an absent token file reads as none', (t) => {
  assert.equal(readToken(join(home(t), 'api.token')), null);
});

test('a created token is private, long enough, and read back unchanged', (t) => {
  const file = join(home(t), 'api.token');
  const token = createToken(file);
  assert.ok(token.length >= 32);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readToken(file), token);
  assert.deepEqual(readdirSync(dirname(file)), ['api.token'], 'no temporary file is left behind');
});

test('creation does not overwrite a token that appeared meanwhile, and judges it', (t) => {
  const dir = home(t);
  const file = join(dir, 'api.token');
  writeFileSync(file, `${'a'.repeat(40)}\n`, { mode: 0o600 });
  assert.equal(createToken(file), 'a'.repeat(40));
  writeFileSync(file, 'short\n');
  refused(() => createToken(file));
  assert.equal(readFileSync(file, 'utf8'), 'short\n', 'the file is not replaced');
});

test('a temporary file from an interrupted first start is not the token', (t) => {
  const dir = home(t);
  const file = join(dir, 'api.token');
  writeFileSync(`${file}.tmp`, 'partial');
  assert.equal(readToken(file), null);
  const token = createToken(file);
  assert.equal(readToken(file), token);
  assert.equal(existsSync(`${file}.tmp`), false);
});

test('group or other permission bits are refused and not repaired', (t) => {
  const file = join(home(t), 'api.token');
  writeFileSync(file, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  for (const mode of [0o640, 0o604, 0o601, 0o660]) {
    chmodSync(file, mode);
    refused(() => readToken(file));
    assert.equal(statSync(file).mode & 0o777, mode);
  }
});

test('an empty or too short token is refused, not replaced', (t) => {
  const file = join(home(t), 'api.token');
  for (const text of ['', '\n', '   \n', 'x'.repeat(31), `${'x'.repeat(31)}\n`]) {
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    refused(() => readToken(file));
    assert.equal(readFileSync(file, 'utf8'), text);
  }
  writeFileSync(file, 'x'.repeat(32));
  assert.equal(readToken(file), 'x'.repeat(32));
});

test('a symbolic link or a directory is refused', (t) => {
  const dir = home(t);
  writeFileSync(join(dir, 'real'), 'c'.repeat(64), { mode: 0o600 });
  symlinkSync(join(dir, 'real'), join(dir, 'api.token'));
  refused(() => readToken(join(dir, 'api.token')));

  const other = home(t);
  mkdirSync(join(other, 'api.token'), { mode: 0o700 });
  refused(() => readToken(join(other, 'api.token')));
});
