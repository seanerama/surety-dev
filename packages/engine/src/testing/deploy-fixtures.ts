// The deployment's fixtures (SEAM.md §§246, 248; BS4 §8; J3, J4): labelled
// qualification facts, and caller-supplied authorization bindings for the
// accepted kernel fixtures that need them. Harness mode only: production
// reaches none of this, and its own routes take no caller-supplied digest,
// identity or targets (J3).

import type { Database } from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { type Actor, transact } from '../store/transitions/tx.js';
import { ADAPTERS, lapseQualification, recordAdapterQualification } from '../store/transitions/deploy.js';
import { proposeAuthorization } from '../store/transitions/gates.js';

const FIXTURE_LABEL = { test_fixture: true } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// POST /v1/harness/fixtures/adapter-qualification (SEAM.md §248):
// {adapter, adapter_version} records a current row labelled as the
// harness's, with no case run (E92 item 2's pattern); {adapter_qualification,
// status: "lapsed"} lapses the fixture's row by the engine's own transition.
export function installAdapterQualification(db: Database, actor: Actor, body: unknown): { status: number; body: unknown } {
  if (!isObject(body)) throw new Refusal(400, 'invalid_value', 'The body must be a JSON object.', 'Send {"adapter": "local_service", "adapter_version"}.', { field: null });
  if (body.adapter_qualification !== undefined) {
    for (const k of Object.keys(body)) {
      if (k !== 'adapter_qualification' && k !== 'status') throw new Refusal(400, 'unknown_field', `"${k}" is not a field of a lapse.`, 'Send adapter_qualification and status.', { field: k });
    }
    if (body.status !== 'lapsed') throw new Refusal(400, 'invalid_value', '"status" must be lapsed.', 'Send {"adapter_qualification", "status": "lapsed"}.', { field: 'status' });
    const id = body.adapter_qualification;
    if (typeof id !== 'string') throw new Refusal(400, 'invalid_value', '"adapter_qualification" must name the row.', 'Send its id.', { field: 'adapter_qualification' });
    const made = transact(db, actor, (tx) => {
      tx.stamp = { ...FIXTURE_LABEL };
      return lapseQualification(tx, { id, reason: 'test_fixture' });
    });
    return { status: 200, body: { adapter_qualification: id, status: 'lapsed', lapsed: made.lapsed !== null } };
  }
  for (const k of Object.keys(body)) {
    if (k !== 'adapter' && k !== 'adapter_version') throw new Refusal(400, 'unknown_field', `"${k}" is not a field of this fixture.`, 'Send adapter and adapter_version.', { field: k });
  }
  if (!(ADAPTERS as readonly string[]).includes(body.adapter as string)) throw new Refusal(400, 'invalid_value', `"adapter" must be ${ADAPTERS.join(' or ')}.`, 'Send {"adapter": "local_service"}.', { field: 'adapter' });
  if (typeof body.adapter_version !== 'string' || body.adapter_version === '' || body.adapter_version.length > 64) {
    throw new Refusal(400, 'invalid_value', '"adapter_version" must be a non-empty string of at most 64 characters.', 'Send the adapter version the configuration names.', { field: 'adapter_version' });
  }
  const adapter = body.adapter as string;
  const adapterVersion = body.adapter_version;
  const made = transact(db, actor, (tx) => {
    tx.stamp = { ...FIXTURE_LABEL };
    return recordAdapterQualification(tx, { adapter, adapterVersion, cases: [], label: { ...FIXTURE_LABEL } });
  });
  return { status: 201, body: { adapter_qualification: made.id } };
}

// POST /v1/harness/fixtures/authorization {project, candidate, environment,
// artifact_digest, config_identity, target_set}: the binding SEAM.md §75's
// route took from the caller, now only here (J3), with its answers.
export function installFixtureAuthorization(db: Database, actor: Actor, body: unknown): { status: number; body: unknown } {
  if (!isObject(body) || typeof body.project !== 'string' || typeof body.candidate !== 'string') {
    throw new Refusal(400, 'invalid_value', '"project" and "candidate" must name the candidate.', 'Send project, candidate and the binding.', { field: 'candidate' });
  }
  const { project, candidate, ...binding } = body;
  return transact(db, actor, (tx) => {
    tx.stamp = { ...FIXTURE_LABEL };
    return proposeAuthorization(tx, { project: project as string, candidate: candidate as string, body: binding });
  });
}
