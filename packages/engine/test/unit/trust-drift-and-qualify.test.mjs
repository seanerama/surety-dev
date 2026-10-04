// Developer tests for revocation on change and the qualification request's
// form (D2 §§4.1, 7.2, 7.3; E62): what of an entry's qualification no longer
// holds, and what POST /v1/trust/qualify refuses before anything is written.
// No backend binary is run.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { entryDrift } = await import(join(dist, 'store', 'transitions', 'trust.js'));
const { TEMPLATES } = await import(join(dist, 'invoke', 'adapters', 'templates.js'));
const { prepareQualify } = await import(join(dist, 'trust', 'qualify.js'));

const entry = {
  backend: 'claude',
  host_id: 'host-a',
  template_version: TEMPLATES.claude.version,
  profile_fingerprint: 'profile-1',
  binary_path: '/opt/standin',
  binary_sha256: 'a'.repeat(64),
  host_qualification: 'hq_1',
  egress_hosts: '[]',
  help_sha256: 'h'.repeat(64),
};
const now = { host: 'host-a', profile: 'profile-1' };

test('an entry drifts on its host, its template version, its profile and its binary, and on nothing else', () => {
  assert.equal(entryDrift(entry, now), null);
  assert.equal(entryDrift(entry, { ...now, binary: 'a'.repeat(64) }), null);
  assert.equal(entryDrift(entry, { ...now, host: 'host-b' }), 'host_changed');
  assert.equal(entryDrift(entry, { ...now, host: null }), 'host_changed');
  assert.equal(entryDrift(entry, { ...now, help: 'c'.repeat(64) }), 'help_changed');
  assert.equal(entryDrift({ ...entry, template_version: 'claude-one-shot-0' }, now), 'template_changed');
  assert.equal(entryDrift({ ...entry, egress_hosts: '[]' }, { ...now, profile: 'profile-2' }), 'profile_changed');
  // A profile this start did not establish (the kernel lane) is not judged.
  assert.equal(entryDrift(entry, { ...now, profile: null }), null);
  // Nor is one whose entry names no host qualification of record.
  assert.equal(entryDrift({ ...entry, host_qualification: null }, { ...now, profile: 'profile-2' }), null);
  assert.equal(entryDrift(entry, { ...now, binary: 'b'.repeat(64) }), 'binary_changed');
  assert.equal(entryDrift(entry, { ...now, binary: null }), 'binary_changed');
});

test('a qualification request is refused for its form before anything is written', async () => {
  const ok = { backend: 'claude', model: 'm', fixture_project: 'prj_x', binary: { path: '/nonexistent/standin' } };
  const plain = { backend: 'claude', model: 'm' };
  await assert.rejects(prepareQualify([]), (e) => e.code === 'invalid_value');
  await assert.rejects(prepareQualify({ backend: 'claude', model: 'm', extra: 1 }), (e) => e.code === 'unknown_field' && e.subject.field === 'extra');
  await assert.rejects(prepareQualify({ ...plain, backend: 'scripted-x' }), (e) => e.code === 'invalid_value' && e.subject.field === 'backend');
  await assert.rejects(prepareQualify({ ...plain, mode: 'session_headless' }), (e) => e.code === 'invalid_value' && e.subject.field === 'mode');
  await assert.rejects(prepareQualify({ ...plain, model: '--resume' }), (e) => e.subject.field === 'model');
  await assert.rejects(prepareQualify({ ...plain, candidate_egress: ['echo.surety.invalid'] }), (e) => e.code === 'invalid_value' && e.subject.field === 'candidate_egress');
  await assert.rejects(prepareQualify({ ...plain, candidate_egress: 'api.anthropic.com' }), (e) => e.subject.field === 'candidate_egress');
  // Outside the test mode a stand-in binary and a fixture project are not
  // fields of the request, and nothing is run.
  await assert.rejects(prepareQualify(ok), (e) => e.code === 'unknown_field');
});
