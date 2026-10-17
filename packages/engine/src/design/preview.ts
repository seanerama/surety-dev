// The design preview (D7 §5.7, A.7; SEAM.md §§488, 499, 500): `surety design
// preview --project <p> [--revision checkpoint|approved|<sha>]`, `POST
// …/design/preview`. The engine seals the design tree at the revision with
// its own static server, index and frames, and deploys it on the project's
// reserved environment `design-preview` through the same attempt, frozen
// intent, capability check, launch and reconcile reads as any deployment,
// verified by two identity reads. It is not a release: no deployment
// authorization, no candidate, no alpha_authorize. Its unit is named as D4
// §9.3 names every unit, from the reserved environment's id (objection 135):
// `surety-<h>-env_<ULID>-g<n>.service`. `--stop` (`DELETE …/design/preview`)
// tears it down; so does its time running out (`design_preview_ttl`).
//
// SAFETY: every unit is created and stopped only by the adapter's own effect
// from a capability minted for a recorded attempt intent of the reserved
// environment; nothing of the design is run by the engine (the server it
// writes reads files and answers bytes); the relay is the operator's.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

import { nowIso, nowMs } from '../clock.js';
import { git, repoContext } from '../git/exec.js';
import { Refusal } from '../refusal.js';
import { type Runtime, log } from '../runtime.js';
import type { DeployDetail, PreconditionFacts, Verdict } from '../store/transitions/deploy.js';
import { pausePoint } from '../testing/seam.js';
import { type Capability, type IdentityRead, adapterFor, effectCall, readCall } from '../deploy/adapter.js';
import { homeFreeBytes, sealArtifact } from '../deploy/artifact.js';
import { configIdentity, homeHash, validateConfig } from '../deploy/config.js';
import { checkStart } from '../deploy/commands.js';
import { adapterVersion } from '../deploy/qualification.js';
import type { ReleaseOperator } from '../deploy/release-operator.js';
import type { PreviewFacts } from './preview-facts.js';
import { previewSite } from './preview-site.js';
import { designTreeAt } from './tree.js';

const ADAPTER = 'local_service';
const IDENTITY = { GIT_AUTHOR_NAME: 'Surety Engine', GIT_AUTHOR_EMAIL: 'engine@surety.invalid', GIT_COMMITTER_NAME: 'Surety Engine', GIT_COMMITTER_EMAIL: 'engine@surety.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mono = (): number => performance.now();

let runtimeHash: { key: string; sha256: string } | null = null;
function nodeSha256(): string {
  const key = process.execPath;
  if (runtimeHash?.key !== key) runtimeHash = { key, sha256: createHash('sha256').update(readFileSync(key)).digest('hex') };
  return runtimeHash.sha256;
}

// A port on 127.0.0.1 nothing listens on now: the relay's, and so the URL's.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export class DesignPreviewer {
  private readonly driving = new Map<string, Promise<void>>();

  constructor(private readonly rt: Runtime) {}

  private get ro(): ReleaseOperator {
    if (!this.rt.deploy) throw new Refusal(503, 'engine_starting', 'The deployment subsystem is not running yet.', 'Wait for startup to finish, then ask again.', {});
    return this.rt.deploy;
  }

  // POST …/design/preview {revision}: sealed and recorded now, deployed in
  // the background; the answer names the URL the relay will serve.
  async request(project: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b !== 'object' || Array.isArray(b)) throw new Refusal(400, 'invalid_value', 'The request body must be a JSON object.', 'Send {"revision": "checkpoint"}.', { field: null });
    for (const k of Object.keys(b)) if (k !== 'revision') throw new Refusal(400, 'unknown_field', `"${k}" is not a field of this command.`, 'Send {"revision": "checkpoint"}.', { field: k });
    if (b.revision !== undefined && typeof b.revision !== 'string') throw new Refusal(400, 'invalid_value', 'revision must be a string.', 'Send {"revision": "checkpoint"}.', { field: 'revision' });
    void this.ro;
    if (this.driving.has(project)) throw new Refusal(409, 'environment_busy', 'A preview of this project is being deployed or torn down.', 'Wait for it to end, then ask again.', { project });
    const facts = await this.rt.read<PreviewFacts>('design.preview_facts', { project, revision: (b.revision as string | undefined) ?? 'checkpoint' });
    const tree = await designTreeAt(facts.repo, facts.revision);
    if (tree === null || tree.files.size === 0) throw new Refusal(404, 'not_found', `The design tree at ${facts.revision} could not be read.`, 'Name another revision.', { revision: facts.revision });
    const site = previewSite(tree.files, { targets: facts.targets, design_preview: facts.design_preview, revision: facts.revision });
    const version = adapterVersion(ADAPTER);
    if (version === null) throw new Refusal(409, 'adapter_unqualified', 'No local_service adapter is known to this engine.', 'Qualify the adapter first.', {});
    const port = await freePort();
    const content = validateConfig({
      adapter: ADAPTER,
      adapter_version: version,
      targets: ['app'],
      runtime: { path: process.execPath, sha256: nodeSha256() },
      start: [process.execPath, 'server.js'],
      port,
      identity_method: 'tree_digest',
    });
    const mockups = site.mockups.map((m) => ({ path: m.path, target: m.target, capability: m.capability }));
    const begun = await this.rt.engine<{ preview: string; environment: string; prefix: string; generation: number; port: number }>('design.preview_begin', {
      project,
      revision: facts.revision,
      tree_digest: site.tree_digest,
      server_digest: site.server_digest,
      mockups,
      homeHash: homeHash(this.rt.home),
      content,
      identity: configIdentity(content, []),
    });
    let artifact: { digest: string; path: string };
    try {
      const commit = await this.commit(project, site.files, begun.preview);
      artifact = await this.seal(project, begun.preview, commit);
    } catch (err) {
      await this.rt.engine('design.preview_failed', { preview: begun.preview, reason: (err as Error).message }).catch(() => undefined);
      throw err;
    }
    const p = this.deploy(project, begun.preview, artifact.digest)
      .catch((err) => log('design preview', err, { project }))
      .finally(() => {
        this.driving.delete(project);
        this.rt.services?.requestTick();
      });
    this.driving.set(project, p);
    return {
      status: 202,
      body: { preview: { design_preview: begun.preview, environment: 'design-preview', environment_id: begun.environment, generation: begun.generation, revision: facts.revision, url: `http://127.0.0.1:${begun.port}/`, mockups } },
    };
  }

  // DELETE …/design/preview: the reserved environment torn down, in the background.
  async stop(project: string, reason = 'command'): Promise<{ status: number; body: Record<string, unknown> }> {
    void this.ro;
    const state = await this.rt.read<{ environment: { id: string; prefix: string } | null; busy: boolean }>('design.preview_state', { project });
    if (state.environment === null) throw new Refusal(404, 'not_found', 'This project has no design preview.', 'Ask for one with surety design preview first.', { project });
    const running = this.driving.get(project);
    if (running) await running;
    const env = state.environment;
    const p = this.teardown(project, env.id, reason)
      .catch((err) => log('design preview', err, { project }))
      .finally(() => {
        this.driving.delete(project);
        this.rt.services?.requestTick();
      });
    this.driving.set(project, p);
    return { status: 202, body: { preview: { environment: 'design-preview', environment_id: env.id, stopping: true } } };
  }

  // At a tick: a deployed preview past its time is torn down (D7 A.7).
  async expire(project: string): Promise<void> {
    if (this.driving.has(project) || !this.rt.deploy) return;
    const state = await this.rt.read<{ environment: { id: string } | null; latest: { status: string; ttl_until: string | null } | null }>('design.preview_state', { project });
    if (state.environment === null || state.latest?.status !== 'deployed' || state.latest.ttl_until === null) return;
    if (Date.parse(state.latest.ttl_until) > Date.parse(nowIso())) return;
    await this.stop(project, 'ttl');
  }

  // Every preview operation this incarnation drives, awaited (engine stop).
  async settle(): Promise<void> {
    await Promise.all([...this.driving.values()]);
  }

  // ---- the sealed copy ------------------------------------------------------------------------

  // The site committed in the engine's own preview repository (never the
  // project's): a tree built with a private index, no work tree touched.
  private async commit(project: string, files: Map<string, Buffer>, preview: string): Promise<string> {
    const repo = join(this.rt.home, 'design-preview', project);
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    const ctx = repoContext(realpathSync(repo));
    const run = async (args: string[], input?: Buffer, env: Record<string, string> = {}): Promise<string> => {
      const r = await git(ctx, args, { env: { ...IDENTITY, ...env }, ...(input !== undefined ? { input } : {}) });
      if (r.code !== 0) throw new Error(`git ${args[0]} in the preview repository failed: ${r.stderr.trim().slice(0, 200)}`);
      return r.stdout.trim();
    };
    if (!existsSync(join(repo, '.git'))) await run(['init', '-q', '-b', 'main']);
    const index = { GIT_INDEX_FILE: join(realpathSync(repo), '.git', `index-${preview}`) };
    await run(['read-tree', '--empty'], undefined, index);
    for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const oid = await run(['hash-object', '-w', '--stdin'], bytes);
      await run(['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], undefined, index);
    }
    const tree = await run(['write-tree'], undefined, index);
    return run(['commit-tree', tree, '-m', `surety: design preview ${preview}`]);
  }

  private async seal(project: string, preview: string, revision: string): Promise<{ digest: string; path: string }> {
    const v = this.rt.config.values as unknown as Record<string, number>;
    const sealed = await sealArtifact({
      home: this.rt.home,
      project,
      repo: realpathSync(join(this.rt.home, 'design-preview', project)),
      revision,
      exclude: [],
      bounds: {
        maxEntries: v.artifact_max_entries!,
        maxBytes: v.artifact_max_bytes!,
        totalMax: v.artifacts_max_bytes!,
        reserveDisk: v.host_reserve_disk!,
        deadlineSeconds: v.artifact_prepare_deadline!,
        startedMs: nowMs(),
        freeBytes: () => homeFreeBytes(this.rt.home),
        admission: (digest) => this.rt.read('deploy.artifact_admission', { project, digest }),
        inspect: (paths) => checkStart([process.execPath, 'server.js'], paths),
      },
    });
    const { spec: _spec, created: _created, ...artifact } = sealed;
    return this.rt.engine<{ digest: string; path: string }>('design.preview_artifact', { preview, sealed: artifact });
  }

  // ---- the operations -------------------------------------------------------------------------

  private detail(operation: string): Promise<DeployDetail | null> {
    return this.rt.read<DeployDetail | null>('deploy.detail', { operation });
  }

  private guard = async (presented: Capability): Promise<string | null> =>
    (await this.rt.read<{ field: string } | null>('deploy.capability_check', { capability: presented, incarnation: this.rt.incarnation }))?.field ?? null;

  // The preconditions read and the attempt recorded, as the Release
  // Operator does, admission waited for within the operation's deadline.
  private async attempt(project: string, operation: string): Promise<{ attempt: string; capability: Capability }> {
    for (;;) {
      await this.ro.observeServiceDomains(project).catch((err) => log('design preview', err));
      const d = await this.detail(operation);
      if (!d) throw new Error(`no operation ${operation}`);
      const facts = await this.ro.facts(d);
      const v = await this.rt.engine<Verdict>('deploy.preconditions', { operation, facts });
      if (v.verdict === 'fail') {
        const manifest = await this.ro.manifest(d, v.facts);
        await this.rt.engine('deploy.precondition_failed', { operation, fact: v.fact, manifest });
        throw new Error(`the precondition ${v.fact} does not hold`);
      }
      if (v.verdict === 'none') throw new Error(`nothing to attempt: ${(v as { why?: string }).why ?? ''}`);
      if (v.verdict === 'hold') {
        const manifest = await this.ro.manifest(d, v.facts);
        const made = await this.rt.engine<{ attempt?: string; capability?: Capability }>('deploy.attempt', {
          operation,
          incarnation: this.rt.incarnation,
          facts: facts as unknown as PreconditionFacts,
          manifest,
          service: { home: this.rt.home, checkCapacity: this.rt.setting('domain_memory_max') },
        });
        if (made.attempt && made.capability) return { attempt: made.attempt, capability: made.capability };
      }
      if (Date.parse(nowIso()) > Date.parse(d.deadline)) throw new Error('the operation reached its deadline before its admission');
      await sleep(500);
    }
  }

  // One operation from its attempt to its end: the effect, the receipt, the
  // reconcile read, the end (finalized when applied). The outcome read.
  private async drive(project: string, operation: string): Promise<{ outcome: string; attempt: string | null; capability: Capability | null }> {
    let attempt: string | null = null;
    let capability: Capability | null = null;
    try {
      const made = await this.attempt(project, operation);
      attempt = made.attempt;
      capability = made.capability;
      if (capability.kind === 'teardown') await this.ro.services?.closeRelays({ environment: capability.environment }, 'teardown');
      const launch = this.ro.launchChannel(attempt, capability.lease_generation);
      const r = await effectCall(adapterFor(ADAPTER), capability, launch, this.ro.bounds(), { guard: this.guard });
      await r.settled;
      if (r.refused !== null) {
        await this.rt.engine('deploy.capability_refused', { attempt, field: r.refused });
        return { outcome: 'refused', attempt, capability };
      }
      await this.rt.engine('deploy.receipt', { attempt, receipt: r.receipt, bound: r.bound });
      let judged: { outcome: string; read: unknown } = { outcome: 'unknown', read: null };
      for (let i = 0; i < 3; i++) {
        const d = await this.detail(operation);
        judged = (d ? await this.ro.judge(d, attempt) : null) ?? { outcome: 'unknown', read: null };
        if (judged.outcome === 'applied') break;
        await sleep(1000);
      }
      await this.rt.engine('qualify.reconciled', { attempt, outcome: judged.outcome, read: judged.read });
      return { outcome: judged.outcome, attempt, capability };
    } finally {
      await this.rt.engine('qualify.end_op', { operation, detail: { design_preview: true } }).catch((err) => log('design preview', err, { operation }));
    }
  }

  private async deploy(project: string, preview: string, digest: string): Promise<void> {
    let operation: string | null = null;
    try {
      operation = (await this.rt.engine<{ operation: string }>('design.preview_intend', { project, preview, kind: 'deploy', digest, incarnation: this.rt.incarnation })).operation;
      await pausePoint('preview.sealed');
      const r = await this.drive(project, operation);
      if (r.outcome !== 'applied' || r.capability?.kind !== 'deploy') {
        await this.rt.engine('design.preview_failed', { preview, reason: `the deploy's reconcile read ${r.outcome}` });
        return;
      }
      const cap = r.capability;
      const d = await this.detail(operation);
      const expect = d?.attempts.find((a) => a.id === r.attempt)?.expect ?? [];
      const env = d?.frozen.environment ?? cap.environment;
      const prefix = d?.prefix ?? '';
      // Two identity reads of the running service (D4 §3.4).
      const reads: Record<string, unknown>[] = [];
      for (let i = 1; i <= 2; i++) {
        const t0 = mono();
        const v = await readCall((s) => adapterFor(ADAPTER).verify({ environment: env, prefix }, expect, s), this.ro.bounds());
        const ms = Math.round(mono() - t0);
        if ('failure' in v || !Array.isArray(v.ok)) reads.push({ read: i, match: 'unread', failure: 'failure' in v ? v.failure : 'invalid_response', duration_ms: ms });
        else for (const x of v.ok as IdentityRead[]) reads.push({ read: i, target: x.target, match: x.match, generation: x.generation, duration_ms: ms });
      }
      if (reads.filter((x) => x.match === 'match').length < 2) {
        await this.rt.engine('design.preview_failed', { preview, reason: `the identity reads did not both match (${JSON.stringify(reads)})` });
        return;
      }
      await this.rt.engine('design.preview_deployed', { preview, unit: cap.create_units[0]!, identity_reads: reads, operation, attempt: r.attempt });
    } catch (err) {
      await this.rt.engine('design.preview_failed', { preview, reason: (err as Error).message }).catch(() => undefined);
      throw err;
    }
  }

  private async teardown(project: string, environment: string, reason: string): Promise<void> {
    const operation = (await this.rt.engine<{ operation: string }>('design.preview_intend', { project, preview: null, kind: 'teardown', incarnation: this.rt.incarnation })).operation;
    const r = await this.drive(project, operation);
    // The domains the host now shows closed, freed before the event.
    await this.ro.observeServiceDomains(project).catch((err) => log('design preview', err));
    if (r.outcome !== 'applied') {
      log('design preview', new Error(`the teardown of ${environment} read ${r.outcome}`), { project });
      return;
    }
    await this.rt.engine('design.preview_torn_down', { project, operation, reason });
  }
}
