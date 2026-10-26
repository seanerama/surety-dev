import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { credentialStatus, registerCredential, loadSavedCredentials } from '../../dist/setup/credentials.js';
import { heldSecret, redactText } from '../../dist/records/redact.js';

const ref = 'backend/claude/api_key';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ui-key-')); const home = join(root, 'home'); mkdirSync(home);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'key'); const value = 'synthetic-onboarding-credential-123456'; writeFileSync(path, value + '\n', { mode: 0o600 });
  return { root, home, path, value };
}
test('credential references survive a restart; no response or manifest contains the value', t => {
  const f = fixture(t);
  const result = registerCredential(f.home, { ref, path: f.path });
  assert.equal(result.credential.loaded, true);
  assert.equal(heldSecret(ref), f.value);
  const manifest = readFileSync(join(f.home, 'provider-credentials.json'), 'utf8');
  assert(!manifest.includes(f.value)); assert(!JSON.stringify(result).includes(f.value));
  loadSavedCredentials(f.home);
  assert.equal(credentialStatus(f.home).find(e => e.ref === ref).path, f.path);
  const next = 'synthetic-replacement-credential-654321'; writeFileSync(f.path, next);
  registerCredential(f.home, { ref, path: f.path, provider_cap_usd: 10 });
  assert(!redactText(f.value + ' ' + next).includes(f.value));
  assert(!redactText(f.value + ' ' + next).includes(next));
});
test('value-shaped input, unsafe permissions, symlinks and keys inside home are refused', t => {
  const f = fixture(t);
  assert.throws(() => registerCredential(f.home, { ref, value: f.value }), e => !JSON.stringify(e.body()).includes(f.value));
  assert.throws(() => registerCredential(f.home, { ref, path: f.value }), e => !JSON.stringify(e.body()).includes(f.value));
  chmodSync(f.path, 0o644); assert.throws(() => registerCredential(f.home, { ref, path: f.path }));
  chmodSync(f.path, 0o600); symlinkSync(f.path, join(f.root, 'linked'));
  assert.throws(() => registerCredential(f.home, { ref, path: join(f.root, 'linked') }));
  const inside = join(f.home, 'key'); writeFileSync(inside, f.value, { mode: 0o600 });
  assert.throws(() => registerCredential(f.home, { ref, path: inside }));
});
