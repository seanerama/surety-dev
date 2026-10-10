// The deployment's API commands, prepared on the main thread before their
// transaction (as projects/commands.ts prepares a project's): what needs the
// held secrets, git or the filesystem is done here, with no transaction
// open; the transaction then records it (store/transitions/deploy.ts).

import { gateFacts } from '../gates/prepare.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import type { ConfigContent } from '../store/transitions/deploy.js';
import { BUILDER, sealArtifact } from './artifact.js';
import { configIdentity, homeHash, secretDigests, validateConfig } from './config.js';

// PUT /v1/projects/:p/environments/:e/config (D4 §3.2; Q5): the body is the
// version's content. Validated, its secret references resolved to digests
// of the values the engine holds, its identity computed.
export async function prepareConfig(rt: Runtime, project: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Refusal(422, 'config_invalid', `"${name}" is not an environment name.`, 'Name the environment with lower-case letters, digits, "-" and "_".', { field: 'environment' });
  }
  const content: ConfigContent = validateConfig(body);
  const digests = secretDigests(rt.home, content);
  return { project, name, content, identity: configIdentity(content, digests), secretDigests: digests, homeHash: homeHash(rt.home) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// POST /v1/projects/:p/deployments {candidate, environment} (D4 §4.1; J3):
// nothing else. A digest, an identity or targets from the caller are
// refused, naming the field, and nothing is recorded. The artifact is
// sealed from the candidate's revision under the current configuration
// before the transaction; the gate's facts are read.
export async function prepareDeployment(rt: Runtime, project: string, body: unknown): Promise<Record<string, unknown>> {
  if (!isObject(body)) throw new Refusal(400, 'invalid_value', 'The body must be a JSON object.', 'Send {"candidate", "environment"}.', { field: null });
  for (const key of Object.keys(body)) {
    if (key !== 'candidate' && key !== 'environment') {
      throw new Refusal(400, 'unknown_field', `"${key}" is not a field of a deployment request: the engine derives the authorization's binding itself.`, 'Send only candidate and environment.', { field: key });
    }
  }
  for (const field of ['candidate', 'environment']) {
    if (typeof body[field] !== 'string' || (body[field] as string) === '') throw new Refusal(400, 'invalid_value', `"${field}" must be a non-empty string.`, 'Send {"candidate", "environment"}.', { field });
  }
  const facts = await rt.read<{ candidate: string; revision: string; environment: string; config: { content: ConfigContent }; repo: string }>('deploy.request_facts', {
    project,
    candidate: body.candidate,
    environment: body.environment,
  });
  const exclude = ((facts.config.content.artifact as { exclude?: string[] } | undefined)?.exclude ?? []).slice();
  const sealed = await sealArtifact({ home: rt.home, project, repo: facts.repo, revision: facts.revision, exclude });
  const gate = await gateFacts(rt, project, facts.candidate);
  const { spec, ...artifact } = sealed;
  return { project, candidate: facts.candidate, environment: body.environment, sealed: artifact, specFingerprint: spec, builder: BUILDER, facts: gate };
}
