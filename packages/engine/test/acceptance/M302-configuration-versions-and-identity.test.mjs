// M302, configuration versions and their identity (slice 23). M4 plan §3.1
// M302; D4-I03; D4 §3.2, A.3; Q5; N04; SEAM.md §245.
//
// The owner writes immutable `environment_configs` versions through
// `PUT /v1/projects/:p/environments/:e/config`. Each version's
// `config_identity` is SHA-256 of its canonical content with each secret
// reference replaced by `{ref, digest}`, the digest an HMAC of the secret's
// value under `$SURETY_HOME/secret-digest.key`. The engine holds deployment
// secrets from `--secret-file deploy/<name>=<path>` (SEAM §160, extended in
// §245), and only those: a backend reference is refused (SEAM §255; D4
// §§7.1, 7.4). The values here are synthetic and random, in 0600 files of a
// directory outside the test's root, which is the tree searched.
//
// Not here: the mount plans (the key is under the engine home, which every
// role, check and service mount plan leaves out: M110, M201, M310); no role
// grant names the route (M336, slice 28); `secrets_changed` and its refusals
// (M333).

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { backup } from './harness/backup.mjs';
import { makeTempDir, removeDir } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { filesHolding } from './harness/records.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { openStore, storePath } from './harness/store.mjs';
import { RUNTIME, configContent, configsOf, putConfig } from './harness/deploy/kernel.mjs';

const secret = () => `surety-m302-${randomBytes(24).toString('base64url')}`;
const hex = (v) => createHash('sha256').update(v).digest('hex');

// A 0600 file holding `value`, in a directory outside the fixture's root.
function secretFile(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, `${value}\n`);
  chmodSync(path, 0o600);
  return path;
}

async function engineWithSecrets(t, files) {
  const fx = await scriptedEngine(t, { start: false });
  const args = Object.entries(files).flatMap(([ref, path]) => ['--secret-file', `${ref}=${path}`]);
  await fx.start({ args });
  return { fx, args };
}

describe('M302 configuration versions and their identity', () => {
  test('(a), (b) each field, a secret reference, a secret value across a restart, the adapter version and the target set each make a new version with a different identity; equal content gives equal identity', async (t) => {
    const dir = makeTempDir('m302-secrets');
    t.after(() => removeDir(dir));
    const files = { 'deploy/app_token': secretFile(dir, 'app', secret()), 'deploy/other_token': secretFile(dir, 'other', secret()) };
    const { fx, args } = await engineWithSecrets(t, files);
    const project = (await addGitProject(fx, { tier: 'T1' })).id;
    const base = configContent({ secrets: { APP_TOKEN: 'deploy/app_token' } });
    const put = async (content, what) => {
      const res = await putConfig(fx.engine, project, 'alpha', content);
      assert.ok([200, 201].includes(res.status), `${what}: written (→ ${res.status} ${res.text})`);
      assert.match(res.body?.config?.config_identity ?? '', /^sha256:[0-9a-f]{64}$/, `${what}: the answer carries the identity`);
      return res.body;
    };

    const first = await put(base, 'version 1');
    const variants = [
      ['the start command', { ...base, start: [RUNTIME.path, 'lib/greeting.js'] }],
      ['the port', { ...base, port: 8081 }],
      ['an environment variable', { ...base, env: { GREETING: 'hello' } }],
      ['the runtime', { ...base, runtime: { path: RUNTIME.path, sha256: 'f'.repeat(64) } }],
      ['the artifact excludes', { ...base, artifact: { exclude: ['docs/'] } }],
      ['the checks\' secret references', { ...base, check_secrets: ['deploy/app_token'] }],
      ['a secret reference', { ...base, secrets: { APP_TOKEN: 'deploy/other_token' } }],
      ['the adapter version', { ...base, adapter_version: '2' }],
      ['the target set', { ...base, targets: ['web'] }],
    ];
    const seen = [[ 'version 1', first.config.config_identity ]];
    for (const [what, content] of variants) seen.push([what, (await put(content, what)).config.config_identity]);

    // (b) The same content as version 1 again: the same identity.
    assert.equal((await put(base, 'version 1 again')).config.config_identity, first.config.config_identity, 'equal content written twice gives equal identity');

    // A secret value changed, across a restart: the same content now has another identity.
    writeFileSync(files['deploy/app_token'], `${secret()}\n`);
    await fx.engine.stop();
    await fx.start({ args });
    seen.push(['a secret value, across a restart', (await put(base, 'version 1 after the value changed')).config.config_identity]);

    const identities = seen.map(([, id]) => id);
    assert.equal(new Set(identities).size, identities.length, `each change gives another identity: ${JSON.stringify(seen)}`);
    const env = configsOf(fx.home, first.environment.id);
    const versions = env.map((c) => c.version);
    assert.deepEqual(versions, versions.map((_, i) => i + 1), 'versions are numbered from 1 without a gap');
    for (const [what, id] of seen) assert.ok(env.some((c) => c.config_identity === id), `${what}: a version with that identity is stored`);
  });

  test('(c), (f) no secret value and no unkeyed SHA-256 of one in the store, records, events, responses, backups or logs; the HMAC key is $SURETY_HOME/secret-digest.key, 0600', async (t) => {
    const dir = makeTempDir('m302-secrets');
    t.after(() => removeDir(dir));
    const values = [secret(), secret()];
    const path = secretFile(dir, 'app', values[0]);
    const { fx, args } = await engineWithSecrets(t, { 'deploy/app_token': path });
    const project = (await addGitProject(fx, { tier: 'T1' })).id;
    const responses = [];
    const content = configContent({ secrets: { APP_TOKEN: 'deploy/app_token' }, check_secrets: ['deploy/app_token'] });
    responses.push((await putConfig(fx.engine, project, 'alpha', content)).text);
    writeFileSync(path, `${values[1]}\n`);
    await fx.engine.stop();
    await fx.start({ args });
    responses.push((await putConfig(fx.engine, project, 'alpha', content)).text);
    responses.push((await fx.engine.get(`/v1/projects/${project}/environments`)).text);
    for (const r of responses) assert.doesNotMatch(r, /"code"/, `each write and read was answered, not refused: ${r.slice(0, 300)}`);

    const key = join(fx.home, 'secret-digest.key');
    assert.ok(existsSync(key), 'the HMAC key is at $SURETY_HOME/secret-digest.key');
    const st = lstatSync(key);
    assert.ok(st.isFile() && st.size > 0, 'a non-empty regular file');
    assert.equal(st.mode & 0o777, 0o600, 'mode 0600');

    const [v1] = configsOf(fx.home, JSON.parse(responses[0]).environment.id);
    assert.deepEqual(v1.secret_digests.map((d) => d.ref), ['deploy/app_token'], 'the version records a digest per reference');
    assert.notEqual(v1.secret_digests[0].digest.replace(/^[a-z0-9-]+:/, ''), hex(values[0]), 'the digest is not the unkeyed SHA-256 of the value');

    const logs = fx.engines.map((e) => `${e.output().stdout}${e.output().stderr}`).join('');
    await fx.engine.stop();
    const saved = backup(fx.home);
    for (const value of values) {
      for (const [what, needle] of [['the value', value], ['its unkeyed SHA-256', hex(value)]]) {
        assert.deepEqual(filesHolding(fx.root, needle), [], `${what}: no file of the engine home, its store, records or the scripted directory holds it`);
        assert.deepEqual(filesHolding(saved.dir, needle), [], `${what}: the backup does not hold it`);
        for (const r of responses) assert.ok(!r.includes(needle), `${what}: no response holds it`);
        assert.ok(!logs.includes(needle), `${what}: the engine's output does not hold it`);
      }
    }
  });

  test('(d) a reference outside the deployment and backend namespaces, and a deployment reference the engine does not hold, are refused config_invalid naming the field; no version is written', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addGitProject(fx, { tier: 'T1' })).id;
    for (const [what, content, field] of [
      ['a reference in no namespace', configContent({ secrets: { APP_TOKEN: 'vault/app_token' } }), 'secrets.APP_TOKEN'],
      ['a deployment reference not held', configContent({ secrets: { APP_TOKEN: 'deploy/never_held' } }), 'secrets.APP_TOKEN'],
      ['a check reference in no namespace', configContent({ check_secrets: ['vault/app_token'] }), 'check_secrets.0'],
    ]) {
      const res = await putConfig(fx.engine, project, 'alpha', content);
      assertRefused(res, 422, 'config_invalid', what);
      assert.equal(res.body.subject?.field, field, `${what}: the refusal names ${field}`);
    }
    const db = openStore(storePath(fx.home), { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "environment_configs"').get().n, 0, 'no version was written');
    } finally {
      db.close();
    }
  });

  test('(d) only the deployment namespace: a backend reference the engine holds, in secrets or in check_secrets, is refused config_invalid naming the field and nothing is written; a held deployment reference is accepted (the slice-23 review, S4; D4 §§7.1, 7.4; SEAM §§245, 255)', async (t) => {
    const dir = makeTempDir('m302-backend');
    t.after(() => removeDir(dir));
    // Both held, so neither refusal can be "not held": the backend one is refused for its namespace alone.
    const { fx } = await engineWithSecrets(t, { 'backend/codex/api_key': secretFile(dir, 'codex', secret()), 'deploy/app_token': secretFile(dir, 'app', secret()) });
    const project = (await addGitProject(fx, { tier: 'T1' })).id;
    for (const [what, content, field] of [
      ['a held backend reference in secrets', configContent({ secrets: { APP_TOKEN: 'deploy/app_token', BACKEND_KEY: 'backend/codex/api_key' } }), 'secrets.BACKEND_KEY'],
      ['a held backend reference in check_secrets', configContent({ secrets: { APP_TOKEN: 'deploy/app_token' }, check_secrets: ['deploy/app_token', 'backend/codex/api_key'] }), 'check_secrets.1'],
    ]) {
      const res = await putConfig(fx.engine, project, 'alpha', content);
      assertRefused(res, 422, 'config_invalid', `${what} (D4 §7.1: a deployment configuration's <ref> is in the deployment namespace)`);
      assert.equal(res.body.subject?.field, field, `${what}: the refusal names ${field}`);
    }
    const db = openStore(storePath(fx.home), { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "environment_configs"').get().n, 0, 'no version was written');
    } finally {
      db.close();
    }
    const control = await putConfig(fx.engine, project, 'alpha', configContent({ secrets: { APP_TOKEN: 'deploy/app_token' }, check_secrets: ['deploy/app_token'] }));
    assert.equal(control.status, 201, `the control: the same configuration naming only the held deployment reference is written (→ ${control.status} ${control.text})`);
  });

  test('(e) a version row is never changed or deleted; the route is refused without the owner\'s token', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addGitProject(fx, { tier: 'T1' })).id;
    const res = await putConfig(fx.engine, project, 'alpha', configContent());
    assert.ok([200, 201].includes(res.status), `version 1 written (→ ${res.status} ${res.text})`);
    const id = res.body.config.id;
    const db = openStore(storePath(fx.home));
    try {
      db.pragma('busy_timeout = 5000');
      for (const [what, sql] of [
        ['its content', `UPDATE "environment_configs" SET "content" = '{}' WHERE "id" = ?`],
        ['its identity', `UPDATE "environment_configs" SET "config_identity" = 'sha256:${'0'.repeat(64)}' WHERE "id" = ?`],
        ['its secret digests', `UPDATE "environment_configs" SET "secret_digests" = '[]' WHERE "id" = ?`],
        ['its version number', `UPDATE "environment_configs" SET "version" = 9 WHERE "id" = ?`],
        ['the row', `DELETE FROM "environment_configs" WHERE "id" = ?`],
      ]) {
        assert.throws(() => db.prepare(sql).run(id), (err) => String(err.code).startsWith('SQLITE_CONSTRAINT'), `changing ${what} is refused by the store`);
      }
    } finally {
      db.close();
    }
    assertRefused(await putConfig(fx.engine, project, 'alpha', configContent({ port: 9000 }), { token: null }), 401, 'token_required', 'the route without a token');
    assert.equal(configsOf(fx.home, res.body.environment.id).length, 1, 'still one version');
  });
});
