// The deployment's fixtures (BS4 §8; M4 plan §2.3; J3, J4): labelled
// qualification facts, and caller-supplied authorization bindings for the
// accepted kernel fixtures that need them. Harness mode only: production
// reaches none of this, and its own routes take no caller-supplied digest,
// identity or targets (J3).

import type { Database } from 'better-sqlite3';

import { ENGINE_VERSION } from '../index.js';
import { Refusal } from '../refusal.js';
import { type Actor, transact } from '../store/transitions/tx.js';
import { lapseQualification, recordAdapterQualification } from '../store/transitions/deploy.js';
import { proposeAuthorization } from '../store/transitions/gates.js';

const FIXTURE_LABEL = { test_fixture: true } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// POST /v1/harness/fixtures/adapter-qualification {adapter, adapter_version?}:
// a current `adapter_qualifications` row labelled as the harness's (E92
// item 2's pattern): no qualification case ran.
export function parseAdapterQualification(body: unknown): { adapter: string; adapterVersion: string } {
  if (!isObject(body)) throw new Refusal(400, 'invalid_value', 'The body must be a JSON object.', 'Send {"adapter": "local_service"}.', { field: null });
  for (const k of Object.keys(body)) {
    if (k !== 'adapter' && k !== 'adapter_version') throw new Refusal(400, 'unknown_field', `"${k}" is not a field of this fixture.`, 'Send adapter and, if you like, adapter_version.', { field: k });
  }
  if (typeof body.adapter !== 'string' || body.adapter === '') throw new Refusal(400, 'invalid_value', '"adapter" must name an adapter.', 'Send {"adapter": "local_service"}.', { field: 'adapter' });
  if (body.adapter_version !== undefined && typeof body.adapter_version !== 'string') {
    throw new Refusal(400, 'invalid_value', '"adapter_version" must be a string.', 'Send the adapter version as a string.', { field: 'adapter_version' });
  }
  return { adapter: body.adapter, adapterVersion: (body.adapter_version as string | undefined) ?? '1' };
}

export function installAdapterQualification(db: Database, actor: Actor, body: unknown) {
  const { adapter, adapterVersion } = parseAdapterQualification(body);
  return transact(db, actor, (tx) => {
    tx.stamp = { ...FIXTURE_LABEL };
    return recordAdapterQualification(tx, { adapter, adapterVersion, engineBuild: ENGINE_VERSION, profileFingerprint: 'test_fixture', cases: [], label: { ...FIXTURE_LABEL } });
  });
}

// POST /v1/harness/fixtures/adapter-qualification/lapse {adapter}: the row
// lapsed, as a changed build, host qualification or profile would lapse it.
export function lapseAdapterQualification(db: Database, actor: Actor, body: unknown) {
  if (!isObject(body) || typeof body.adapter !== 'string') throw new Refusal(400, 'invalid_value', '"adapter" must name an adapter.', 'Send {"adapter": "local_service"}.', { field: 'adapter' });
  const adapter = body.adapter;
  return transact(db, actor, (tx) => {
    tx.stamp = { ...FIXTURE_LABEL };
    return lapseQualification(tx, { adapter, reason: 'test_fixture' });
  });
}

// POST /v1/harness/fixtures/authorization {project, candidate, environment,
// artifact_digest, config_identity, target_set}: the binding SEAM.md §75's
// route took from the caller, now only here (J3).
export function installFixtureAuthorization(db: Database, actor: Actor, body: unknown) {
  if (!isObject(body) || typeof body.project !== 'string' || typeof body.candidate !== 'string') {
    throw new Refusal(400, 'invalid_value', '"project" and "candidate" must name the candidate.', 'Send project, candidate and the binding.', { field: 'candidate' });
  }
  const { project, candidate, ...binding } = body;
  return transact(db, actor, (tx) => {
    tx.stamp = { ...FIXTURE_LABEL };
    const made = proposeAuthorization(tx, { project: project as string, candidate: candidate as string, body: binding });
    return made.body;
  });
}
