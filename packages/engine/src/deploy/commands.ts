// The deployment's API commands, prepared on the main thread before their
// transaction (as projects/commands.ts prepares a project's): what needs the
// held secrets, git or the filesystem is done here, with no transaction
// open; the transaction then records it (store/transitions/deploy.ts).

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

import { nowMs } from '../clock.js';
import { gateFacts } from '../gates/prepare.js';
import { log } from '../runtime.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import type { ConfigContent, SealedArtifact } from '../store/transitions/deploy.js';
import { seamArtifactFreeBytes } from '../testing/seam.js';
import { ArtifactRefused, BUILDER, type Sealed, homeFreeBytes, removeUnrecorded, sealArtifact } from './artifact.js';
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

const invalid = (field: string, why: string): Refusal =>
  new Refusal(422, 'config_invalid', `The configuration's ${field} ${why}.`, 'Write a configuration version that the host can run, then request the deployment again; nothing was authorized.', { field });

// The runtime's bytes hashed, cached by its identity on disk.
const hashed = new Map<string, string>();
function sha256File(path: string): Promise<string> {
  const st = statSync(path);
  const key = `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  const known = hashed.get(key);
  if (known) return Promise.resolve(known);
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => {
        const hex = h.digest('hex');
        hashed.set(key, hex);
        resolve(hex);
      });
  });
}

// What M4 can run on this host (D4 §§3.2, 9.2, Appendix B; SEAM.md §261),
// checked before anything is sealed or authorized: the runtime present and
// of the pinned hash, the start command's program the runtime.
async function checkRuntime(content: ConfigContent): Promise<void> {
  const runtime = content.runtime;
  if (!runtime) throw invalid('runtime', 'is missing');
  let regular = false;
  try {
    regular = statSync(runtime.path).isFile();
  } catch {
    regular = false;
  }
  if (!regular) throw invalid('runtime.path', `names ${runtime.path}, which is not a file on this host`);
  let digest: string;
  try {
    digest = await sha256File(runtime.path);
  } catch {
    throw invalid('runtime.path', `names ${runtime.path}, which cannot be read`);
  }
  if (digest !== runtime.sha256) throw invalid('runtime.sha256', `is not the SHA-256 of ${runtime.path} on this host`);
  const start = content.start ?? [];
  if (start[0] !== runtime.path) throw invalid('start.0', `must be the configured runtime ${runtime.path}, not ${JSON.stringify(start[0])}`);
}

// The start command's arguments against the projection's paths (SEAM.md
// §§259, 261): the entry point, `start[1]`, is a path in the artifact,
// relative to /surety/app (or under it); no argument names an absolute path
// outside /surety/app.
export function checkStart(start: string[], paths: Set<string>): void {
  const entry = start[1];
  const rel = typeof entry === 'string' && entry.startsWith('/surety/app/') ? entry.slice('/surety/app/'.length) : entry;
  if (typeof rel !== 'string' || rel.startsWith('/') || !paths.has(rel)) throw invalid('start.1', `names ${JSON.stringify(entry)}, which is not a file of the sealed artifact`);
  start.forEach((arg, i) => {
    if (i === 0) return;
    for (const m of arg.matchAll(/(?:^|[=:,])(\/[^\s=:,]*)/g)) {
      const p = m[1]!;
      if (p !== '/surety/app' && !p.startsWith('/surety/app/')) throw invalid(`start.${i}`, `names the host path ${p}: the service runs only from its artifact`);
    }
  });
}

// One request per project at a time, from its preparation to its cleanup
// (the slice-23 review's m5): what a request seals and does not record is
// removed before another request can reuse it.
const locks = new Map<string, Promise<void>>();
async function lock(project: string): Promise<() => void> {
  const before = locks.get(project) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const chained = before.then(() => mine);
  locks.set(project, chained);
  await before;
  return () => {
    release();
    if (locks.get(project) === chained) locks.delete(project);
  };
}

interface Prepared {
  project: string;
  sealed: SealedArtifact | null;
  [key: string]: unknown;
}
const pendingCleanup = new WeakMap<object, { release: () => void; sealed: Sealed | null }>();

// POST /v1/projects/:p/deployments {candidate, environment} (D4 §4.1; J3):
// nothing else. A digest, an identity or targets from the caller are
// refused, naming the field, and nothing is recorded. Before anything is
// sealed: a request that would coalesce seals nothing; one whose
// configuration is `secrets_changed`, or names a runtime or start command
// the host cannot run (M312), is refused. Then the artifact is sealed from
// the candidate's revision under the current configuration, within its
// bounds; the gate's facts are read.
export async function prepareDeployment(rt: Runtime, project: string, body: unknown): Promise<Prepared> {
  if (!isObject(body)) throw new Refusal(400, 'invalid_value', 'The body must be a JSON object.', 'Send {"candidate", "environment"}.', { field: null });
  for (const key of Object.keys(body)) {
    if (key !== 'candidate' && key !== 'environment') {
      throw new Refusal(400, 'unknown_field', `"${key}" is not a field of a deployment request: the engine derives the authorization's binding itself.`, 'Send only candidate and environment.', { field: key });
    }
  }
  for (const field of ['candidate', 'environment']) {
    if (typeof body[field] !== 'string' || (body[field] as string) === '') throw new Refusal(400, 'invalid_value', `"${field}" must be a non-empty string.`, 'Send {"candidate", "environment"}.', { field });
  }
  const startedMs = nowMs();
  const release = await lock(project);
  let sealed: Sealed | null = null;
  try {
    const facts = await rt.read<{ candidate: string; revision: string; environment: string; name: string; config: { status: string; content: ConfigContent }; repo: string; pending: boolean }>('deploy.request_facts', {
      project,
      candidate: body.candidate,
      environment: body.environment,
    });
    const gate = await gateFacts(rt, project, facts.candidate);
    const base = { project, candidate: facts.candidate, environment: body.environment, builder: BUILDER, facts: gate };
    if (facts.pending) {
      const prepared: Prepared = { ...base, sealed: null, specFingerprint: '' };
      pendingCleanup.set(prepared, { release, sealed: null });
      return prepared;
    }
    if (facts.config.status === 'secrets_changed') {
      throw new Refusal(409, 'config_secrets_changed', `A secret the current configuration of ${facts.name} names has a value other than its version records.`, 'Write a new configuration version, then request the deployment again.', {
        environment: facts.environment,
      });
    }
    await checkRuntime(facts.config.content);
    const exclude = ((facts.config.content.artifact as { exclude?: string[] } | undefined)?.exclude ?? []).slice();
    const v = rt.config.values as unknown as Record<string, number>;
    try {
      sealed = await sealArtifact({
        home: rt.home,
        project,
        repo: facts.repo,
        revision: facts.revision,
        exclude,
        bounds: {
          maxEntries: v.artifact_max_entries!,
          maxBytes: v.artifact_max_bytes!,
          totalMax: v.artifacts_max_bytes!,
          reserveDisk: v.host_reserve_disk!,
          deadlineSeconds: v.artifact_prepare_deadline!,
          startedMs,
          freeBytes: () => seamArtifactFreeBytes() ?? homeFreeBytes(rt.home),
          admission: (digest) => rt.read('deploy.artifact_admission', { project, digest }),
          inspect: (paths) => checkStart(facts.config.content.start ?? [], paths),
        },
      });
    } catch (err) {
      if (err instanceof ArtifactRefused) {
        const { refusal, ...detail } = err.subject as { refusal: string };
        await rt.engine('deploy.artifact_refused', { project, refusal, detail, candidate: facts.candidate, environment: facts.environment });
      }
      throw err;
    }
    if (sealed.reused === 'corrupt') {
      // The sealed copy no longer rehashes (D4 §3.1): the artifact `failed`
      // and its finding recorded, then the request refused.
      await rt.engine('deploy.artifact_corrupt', { project, digest: sealed.digest, where: 'reuse' });
      throw new Refusal(409, 'artifact_corrupt', `The sealed artifact ${sealed.digest} failed its rehash and is not deployed.`, 'Nothing was authorized. Read the security finding; the sealed copy must be replaced by hand.', {
        artifact_digest: sealed.digest,
      });
    }
    const { spec, created: _created, ...artifact } = sealed;
    const prepared: Prepared = { ...base, sealed: artifact, specFingerprint: spec };
    pendingCleanup.set(prepared, { release, sealed });
    return prepared;
  } catch (err) {
    await cleanup(rt, project, sealed).catch((e) => log('deployment request', e, { what: 'cleanup' }));
    release();
    throw err;
  }
}

// After the request's transaction, whatever its answer: a sealed directory
// this request made and no row records is removed, then the project's lock
// released.
export async function settleDeployment(rt: Runtime, prepared: unknown): Promise<void> {
  const held = typeof prepared === 'object' && prepared !== null ? pendingCleanup.get(prepared) : undefined;
  if (!held) return;
  pendingCleanup.delete(prepared as object);
  try {
    await cleanup(rt, (prepared as Prepared).project, held.sealed);
  } catch (err) {
    log('deployment request', err, { what: 'cleanup' });
  } finally {
    held.release();
  }
}

async function cleanup(rt: Runtime, project: string, sealed: Sealed | null): Promise<void> {
  if (sealed === null || !sealed.created) return;
  // Recorded by its project and digest, whatever the spelling of its path.
  const rows = await rt.read<{ project: string; digest: string; path: string }[]>('deploy.artifact_rows');
  if (rows.some((r) => r.project === project && r.digest === sealed.digest)) return;
  removeUnrecorded(rt.home, sealed.path, rows.some((r) => r.project === project));
}
