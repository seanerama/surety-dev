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
import { type ConfigContent, DESIGN_PREVIEW_ENV, type SealedArtifact, environmentReserved } from '../store/transitions/deploy.js';
import { seamArtifactFreeBytes } from '../testing/seam.js';
import { ArtifactRefused, BUILDER, type Sealed, homeFreeBytes, removeUnrecorded, sealArtifact } from './artifact.js';
import { configIdentity, homeHash, secretDigests, validateConfig } from './config.js';
import { checkStaticEntry, staticSpec } from './static-site.js';
import { prepareServingProposal } from './serving-install.js';

// PUT /v1/projects/:p/environments/:e/config (D4 §3.2; Q5): the body is the
// version's content. Validated, its secret references resolved to digests
// of the values the engine holds, its identity computed.
export async function prepareConfig(rt: Runtime, project: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Refusal(422, 'config_invalid', `"${name}" is not an environment name.`, 'Name the environment with lower-case letters, digits, "-" and "_".', { field: 'environment' });
  }
  // The design preview's environment is the engine's (D7 §5.7; G4).
  if (name === DESIGN_PREVIEW_ENV) throw environmentReserved(project);
  const content: ConfigContent = validateConfig(body);
  const digests = secretDigests(rt.home, content);
  // A static configuration: the engine's own serving check proposed with it
  // when the project has none (the owner's ruling of 2026-10-29).
  const serving = staticSpec(content) !== null ? await prepareServingProposal(rt, project, name) : null;
  return { project, name, content, identity: configIdentity(content, digests), secretDigests: digests, homeHash: homeHash(rt.home), serving };
}

// POST /v1/projects/:p/environments/:e/config/resolve-secrets (D4 §3.2;
// SEAM.md §313; `surety env config <env> --resolve-secrets`): the current
// version's content written again with the digests of the values the engine
// holds now. Unchanged, the same version answers (200); otherwise a new one.
export async function prepareResolveSecrets(rt: Runtime, project: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  if (name === DESIGN_PREVIEW_ENV) throw environmentReserved(project);
  if (body !== undefined && (!isObject(body) || Object.keys(body).length > 0)) {
    const [extra] = isObject(body) ? Object.keys(body) : [];
    throw new Refusal(400, extra === undefined ? 'invalid_value' : 'unknown_field', 'This command takes no fields.', 'Send {} or no body.', { field: extra ?? null });
  }
  const content = await rt.read<ConfigContent | null>('environment.config_content', { project, name });
  if (content === null) throw new Refusal(404, 'not_found', `No configured environment "${name}".`, 'Write its configuration first (PUT …/config).', { environment: name });
  return prepareConfig(rt, project, name, content);
}

// POST /v1/projects/:p/environments/:e/relay (`surety env open`; D4 §5.2;
// Q7; SEAM.md §317): the relay bound on the main thread, on 127.0.0.1 and the
// running generation's configured port, before its transaction records it;
// a port another listener holds is refused, that listener untouched.
export async function prepareRelayOpen(rt: Runtime, project: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  noBody(body);
  const t = await rt.read<{ environment: string; attempt: string; generation: number | null; port: number }>('environment.relay_target', { project, environment: name });
  const services = rt.deploy?.services ?? null;
  if (services === null) throw new Refusal(409, 'relay_unavailable', 'This engine runs no service host (no real deployment adapter), so it has no relay to open.', 'Open the relay on an engine that deploys with local_service.', { environment: t.environment });
  const v = rt.config.values;
  const bound = await services.openRelay({
    environment: t.environment,
    attempt: t.attempt,
    generation: t.generation,
    port: t.port,
    limits: { connectTimeoutMs: v.service_link_connect_timeout * 1000, tunnelMaxMs: v.service_link_tunnel_max_seconds * 1000, tunnelsMax: v.service_link_tunnels_max, bufferMaxBytes: v.service_link_buffer_max_bytes },
  });
  if (bound === 'in_use') {
    throw new Refusal(409, 'relay_port_in_use', `Port ${t.port} on 127.0.0.1 has another listener; the relay was not opened and that listener was not touched.`, 'Free the port (or configure another), then open the relay again.', { environment: t.environment, port: t.port });
  }
  return { environment: t.environment, attempt: t.attempt, generation: t.generation, port: t.port };
}

// Whatever the transaction did, a listener the store does not record open
// is closed (a failed transaction leaves no relay behind).
export async function settleRelayOpen(rt: Runtime, prepared: unknown): Promise<void> {
  const p = prepared as { environment?: string; attempt?: string } | undefined;
  if (!p?.environment || !p.attempt) return;
  const open = await rt.read<boolean>('deploy.relay_check', { environment: p.environment, attempt: p.attempt }).catch(() => false);
  if (!open) rt.deploy?.services?.dropRelay(p.environment);
}

// DELETE …/relay (`surety env close`): the listener and its tunnels closed
// on the main thread, then recorded.
export async function prepareRelayClose(rt: Runtime, project: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  noBody(body);
  const read = await rt.read<{ environment: { id: string } }>('environment.read', { project, environment: name });
  rt.deploy?.services?.dropRelay(read.environment.id);
  return { environment: read.environment.id, reason: 'command' };
}

function noBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (!isObject(body)) throw new Refusal(400, 'invalid_value', 'The request body must be a JSON object.', 'Send {} or no body.', { field: null });
  const [extra] = Object.keys(body);
  if (extra !== undefined) throw new Refusal(400, 'unknown_field', `"${extra}" is not a field of this command.`, 'Send {} or no body.', { field: extra });
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
  // A static configuration names no start command: the engine's server runs
  // under the runtime (SHAPES.md §2).
  if (staticSpec(content) !== null) return;
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
          inspect: (paths) => {
            const spec = staticSpec(facts.config.content);
            if (spec !== null) checkStaticEntry(spec, paths);
            else checkStart(facts.config.content.start ?? [], paths);
          },
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
