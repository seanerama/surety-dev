// Qualifying an adapter by command (D4 §2.6, A.3; D4-A06; AR N03; BS4
// §§4.1, 5, 11.3; the driver's rulings on the slice-29 design; SEAM.md
// §§322, 323): `surety qualify-adapter local_service`, `POST
// /v1/adapters/:a/qualify`. Never at start and never by an agent.
//
// One run makes a qualification environment of its own in the engine's
// fixture project (an `env_<ULID>` whose units carry this home's prefix),
// seals two fixture artifacts A and B that it builds itself, and runs D4
// §2.6's nine cases through the same attempt, frozen intent, capability
// check (`effectCall`), real launcher, init and single-use launch grant, and
// reconcile reads as any deployment. Each case passes only by the explicit
// assertions it records, beside a control that shows the same read able to
// answer otherwise; an instrument's exit status is a detail, never a pass.
// A case not reached is `not_exercised`; a case that throws is `failed`.
// The environment is torn down at the end whatever happened; only a run
// with all nine cases passed records a `current` row.
//
// SAFETY (BS4 §4.1; E64; the driver's rulings). Every unit is created only
// by the adapter's own `deploy` from a capability minted for a recorded
// attempt intent of this run's environment. The hand acts of `out_of_band`
// (a stop, a restart) go through LocalService.handAct, which re-reads the
// unit and acts only on its recorded invocation and cgroup with MainPID in
// that cgroup. `unreadable` points only this environment's adapter calls at
// a bus path under this home's run/ that does not exist; the manager is
// never touched. The one byte changed is in this run's own sealed copy, by
// real path under artifacts/, and restored. No signal is sent to anything;
// no cgroup is written here; the user's manager is never stopped, restarted
// or reloaded.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { nowIso, nowMs } from '../clock.js';
import { git, repoContext } from '../git/exec.js';
import { writeWholeRecord } from '../records/files.js';
import { Refusal } from '../refusal.js';
import { type Runtime, log } from '../runtime.js';
import type { DeployDetail, PreconditionFacts, Verdict } from '../store/transitions/deploy.js';
import { seamAdapterQualificationForced, seamRealDeployAdapter } from '../testing/seam.js';
import { ensureFixtureProject } from '../trust/fixture.js';
import { type Capability, type DeployBounds, type EffectReceipt, type IdentityRead, type LaunchChannel, type TargetExpectation, type TargetInventory, adapterFor, effectCall, readCall } from './adapter.js';
import { LocalService, applicationAt, hostTools, showUnits } from './adapters/local-service.js';
import { BUILDER, artifactsDir, homeFreeBytes, sealArtifact } from './artifact.js';
import { configIdentity, homeHash, validateConfig } from './config.js';
import { readPopulated } from '../boundary/cgroup.js';
import { checkStart } from './commands.js';
import { adapterVersion } from './qualification.js';
import { ADAPTER_QUALIFICATION_CASES, type AdapterQualificationCase, type CaseResult } from './qualify-cases.js';
import type { ReleaseOperator } from './release-operator.js';
import { ServiceHost } from './service-host.js';

export const QUALIFIABLE = ['local_service'] as const;

interface Entry {
  case: AdapterQualificationCase;
  result: CaseResult;
  control: CaseResult;
  detail: Record<string, unknown>;
}

// An assertion a case makes: what it expected, what it read, whether it held.
interface Assertion {
  what: string;
  held: boolean;
  read: unknown;
}

class NotExercised extends Error {}

// Whether a path is there, by lstat: `absent` only on ENOENT; any other
// failure (EACCES among them) is `unread`, never absent (the slice-29
// review, m3).
export function presence(path: string): 'present' | 'absent' | 'unread' {
  try {
    lstatSync(path);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unread';
  }
}

// The fixture service the run deploys: Node's own `http`, listening on its
// PORT inside its domain's loopback. A and B differ in one constant; each
// run's pair carries the run's id, so each run seals artifacts of its own.
const fixtureServer = (variant: 'A' | 'B'): string =>
  [
    "'use strict';",
    '// The adapter qualification fixture service (D4 §2.6).',
    `const VARIANT = '${variant}';`,
    "require('node:http').createServer((q, r) => { r.setHeader('content-type', 'text/plain'); r.end(VARIANT + '\\n'); }).listen(Number(process.env.PORT), '127.0.0.1');",
    '',
  ].join('\n');

const IDENTITY = { GIT_AUTHOR_NAME: 'Surety Engine', GIT_AUTHOR_EMAIL: 'engine@surety.invalid', GIT_COMMITTER_NAME: 'Surety Engine', GIT_COMMITTER_EMAIL: 'engine@surety.invalid' };
const PORT = 8080;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noLaunch: LaunchChannel = {
  authorize: async () => ({ granted: false as const }),
  started: async () => undefined,
};

export class AdapterQualifier {
  private running: Promise<unknown> | null = null;
  // The engine's stop: every case's reads and effects aborted (through the
  // adapter's own children).
  private readonly ac = new AbortController();
  // The teardown's own bound once the stop came (the slice-29 review, S2).
  private readonly hard = new AbortController();

  constructor(private readonly rt: Runtime) {}

  // At shutdown (the slice-29 review, S2): the cases' calls aborted; the
  // run's teardown still made if it can within `boundMs`, before the store
  // closes; the run recorded `interrupted`. Resolves when the run has ended
  // or the bound has passed (what is left is the next start's refusal).
  async stop(boundMs = 60_000): Promise<void> {
    this.ac.abort();
    if (this.running === null) return;
    const timer = setTimeout(() => this.hard.abort(), Math.max(1000, boundMs - 5000));
    try {
      await Promise.race([this.running.catch(() => undefined), new Promise((r) => setTimeout(r, boundMs).unref?.())]);
    } finally {
      clearTimeout(timer);
    }
  }

  // One run, to its end (SEAM.md §322). Returns the run's id; refusals are
  // the begin transition's (409 `qualification_running`, 409
  // `qualification_left_units`).
  async run(adapter: string): Promise<string> {
    if (!(QUALIFIABLE as readonly string[]).includes(adapter)) throw new Refusal(404, 'not_found', `No adapter ${adapter} is qualified by this engine.`, 'Name local_service.', { adapter });
    if (this.running !== null) throw new Refusal(409, 'qualification_running', `A qualification of ${adapter} is running.`, 'Wait for it to end, then ask again.', { adapter });
    if (this.ac.signal.aborted) throw new Refusal(503, 'engine_stopping', 'The engine is stopping: no qualification begins.', 'Start the engine and ask again.', { adapter });
    const p = new Run(this.rt, adapter, this.ac.signal, this.hard.signal).execute();
    this.running = p;
    try {
      return await p;
    } finally {
      this.running = null;
    }
  }
}

class Run {
  private run = '';
  private env = '';
  private prefix = '';
  private project = '';
  private readonly forced = seamAdapterQualificationForced();
  private readonly identityReads: { case: string; duration_ms: number; match: string; generation: unknown; target: string }[] = [];
  // Admission waits before an attempt, with what held it (host time, BS4
  // §11.3).
  private readonly waits: { operation: string; ms: number; hold: unknown }[] = [];
  private artifacts: { A: { digest: string; path: string; manifest: unknown[] }; B: { digest: string; path: string; manifest: unknown[] } } | null = null;
  private lastApplied: { operation: string; attempt: string; unit: string } | null = null;
  private readonly started = nowMs();
  // What every call of the run is cancelled by: the engine's stop during the
  // cases, the teardown's own bound after it (the slice-29 review, S2).
  private cancel: AbortSignal;

  constructor(
    private readonly rt: Runtime,
    private readonly adapter: string,
    private readonly signal: AbortSignal,
    private readonly hard: AbortSignal,
  ) {
    this.cancel = signal;
  }

  private get ro(): ReleaseOperator {
    if (!this.rt.deploy) throw new Error('the Release Operator is not running');
    return this.rt.deploy;
  }
  private get bounds(): DeployBounds {
    return this.ro.bounds();
  }
  private get local(): LocalService | null {
    const a = adapterFor(this.adapter);
    return a instanceof LocalService ? a : null;
  }

  async execute(): Promise<string> {
    const version = adapterVersion(this.adapter)!;
    this.project = await ensureFixtureProject(this.rt, this.rt.store);
    const node = process.execPath;
    const content = validateConfig({
      adapter: this.adapter,
      adapter_version: version,
      targets: ['app'],
      runtime: { path: node, sha256: createHash('sha256').update(readFileSync(node)).digest('hex') },
      start: [node, 'server.js'],
      port: PORT,
      identity_method: 'tree_digest',
    });
    // What earlier runs' environments may have left on disk, read here (the
    // slice-29 review, m10): a path present or unread refuses the run.
    const paths = (await this.rt.read<{ environment: string; path: string }[]>('qualify.paths')).map((x) => ({ ...x, state: presence(x.path) }));
    const begun = await this.rt.engine<{ run: string; environment: string; prefix: string }>('qualify.begin', {
      paths,
      adapter: this.adapter,
      adapterVersion: version,
      project: this.project,
      incarnation: this.rt.incarnation,
      homeHash: homeHash(this.rt.home),
      content,
      identity: configIdentity(content, []),
    });
    this.run = begun.run;
    this.env = begun.environment;
    this.prefix = begun.prefix;
    const entries = new Map<AdapterQualificationCase, Entry>();
    const record = (e: Entry) => entries.set(e.case, e);
    let tools: Awaited<ReturnType<typeof hostTools>> | null = null;
    try {
      tools = await hostTools();
      if (!seamRealDeployAdapter() || this.local === null) {
        for (const c of ADAPTER_QUALIFICATION_CASES) record({ case: c, result: 'not_exercised', control: 'not_exercised', detail: { reason: 'the real local_service adapter is not in use in this engine' } });
      } else {
        await this.seal();
        await this.cases(record);
      }
    } catch (err) {
      log('adapter qualification', err, { run: this.run });
    } finally {
      // The environment is removed whatever happened (D4 §2.6), after a stop
      // too, under the teardown's own bound (the slice-29 review, S2).
      const stopped = this.signal.aborted;
      this.cancel = this.hard;
      const teardown = await this.teardownCase().catch((err): Entry => ({ case: 'teardown', result: err instanceof NotExercised ? 'not_exercised' : 'failed', control: 'not_exercised', detail: { reason: (err as Error).message } }));
      if (stopped || this.signal.aborted) record({ case: 'teardown', result: 'not_exercised', control: 'not_exercised', detail: { reason: 'the engine stopped during the qualification; the environment was torn down if it could be', cleanup: teardown.detail } });
      else if (this.forced.teardown === 'not_exercised') record({ case: 'teardown', result: 'not_exercised', control: 'not_exercised', detail: { reason: 'not run as a case: forced by the test seam; the environment was torn down all the same', cleanup: teardown.detail } });
      else if (!entries.has('teardown')) record(this.forcedEntry(teardown));
    }
    const interrupted = this.signal.aborted;
    const cases = ADAPTER_QUALIFICATION_CASES.map((c) => entries.get(c) ?? { case: c, result: 'not_exercised' as const, control: 'not_exercised' as const, detail: { reason: interrupted ? 'the engine stopped during the qualification' : 'not reached' } });
    // The host's facts the row would be recorded against (the slice-29
    // review, S1): one not known qualifies nothing, and the evidence says so.
    const host = await this.rt.read<{ facts: unknown; unknown: string | null; unrun: boolean }>('qualify.host_facts').catch(() => ({ facts: null, unknown: 'host_id', unrun: false }));
    const qualified = !interrupted && host.unknown === null && cases.every((c) => c.result === 'passed' && c.control === 'passed');
    const evidence = {
      run: this.run,
      adapter: this.adapter,
      adapter_version: version,
      environment: this.env,
      incarnation: this.rt.incarnation,
      tools,
      host_time_ms: Math.max(1, Math.round(nowMs() - this.started)),
      identity_reads: this.identityReads,
      admission_waits: this.waits,
      host_facts: { facts: host.facts, unknown: host.unknown, ...(host.unknown !== null ? { why: `the host's ${host.unknown} is not known: no qualification is recorded against it` } : {}) },
      interrupted,
      cases,
      qualified,
    };
    let rec: string | null = null;
    try {
      rec = await writeWholeRecord(this.rt, { project: null, run: null, kind: 'qualification_evidence', content: Buffer.from(JSON.stringify(evidence, null, 2)) });
    } catch (err) {
      log('adapter qualification', err, { run: this.run, what: 'evidence' });
    }
    // Without its evidence a run qualifies nothing (D4 §2.6, A.3). A run
    // whose end cannot be recorded with its row is recorded unqualified, so
    // that it never stays `running` in this incarnation.
    try {
      await this.rt.engine('qualify.end', { run: this.run, cases, qualified: qualified && rec !== null, evidence: rec, interrupted });
    } catch (err) {
      log('adapter qualification', err, { run: this.run, what: 'end' });
      await this.rt.engine('qualify.end', { run: this.run, cases, qualified: false, evidence: null, interrupted });
    }
    return this.run;
  }

  // ---- the fixture artifacts -------------------------------------------------------------------

  private async seal(): Promise<void> {
    const repo = join(this.rt.home, 'qualification', 'adapter');
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    const ctx = repoContext(realpathSync(repo));
    const step = async (args: string[]) => {
      const r = await git(ctx, args, { env: { ...IDENTITY, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
      if (r.code !== 0) throw new Error(`git ${args[0]} in the qualification repository failed: ${r.stderr.trim().slice(0, 200)}`);
      return r.stdout.trim();
    };
    if (!existsSync(join(repo, '.git'))) await step(['init', '-q', '-b', 'main']);
    const revs: Record<'A' | 'B', string> = { A: '', B: '' };
    for (const v of ['A', 'B'] as const) {
      writeFileSync(join(repo, 'server.js'), fixtureServer(v));
      writeFileSync(join(repo, 'run.json'), `${JSON.stringify({ qualification_run: this.run, variant: v })}\n`);
      await step(['add', 'server.js', 'run.json']);
      await step(['commit', '-q', '--allow-empty', '-m', `surety: adapter qualification ${this.run} ${v}`]);
      revs[v] = await step(['rev-parse', 'HEAD']);
    }
    const v = this.rt.config.values as unknown as Record<string, number>;
    const out: Record<string, { digest: string; path: string; manifest: unknown[] }> = {};
    for (const variant of ['A', 'B'] as const) {
      const sealed = await sealArtifact({
        home: this.rt.home,
        project: this.project,
        repo: realpathSync(repo),
        revision: revs[variant],
        exclude: [],
        bounds: {
          maxEntries: v.artifact_max_entries!,
          maxBytes: v.artifact_max_bytes!,
          totalMax: v.artifacts_max_bytes!,
          reserveDisk: v.host_reserve_disk!,
          deadlineSeconds: v.artifact_prepare_deadline!,
          startedMs: nowMs(),
          freeBytes: () => homeFreeBytes(this.rt.home),
          admission: (digest) => this.rt.read('deploy.artifact_admission', { project: this.project, digest }),
          inspect: (paths) => checkStart([process.execPath, 'server.js'], paths),
        },
      });
      const { spec: _spec, created: _created, ...artifact } = sealed;
      out[variant] = await this.rt.engine<{ digest: string; path: string; manifest: unknown[] }>('qualify.artifact', { run: this.run, sealed: artifact });
    }
    this.artifacts = { A: out.A!, B: out.B! };
    void BUILDER;
  }

  // ---- the operations' steps ------------------------------------------------------------------

  private detail(operation: string): Promise<DeployDetail | null> {
    return this.rt.read<DeployDetail | null>('deploy.detail', { operation });
  }

  private async intend(kind: 'deploy' | 'teardown', digest?: string): Promise<string> {
    const made = await this.rt.engine<{ operation: string }>('qualify.intend', { run: this.run, kind, ...(digest ? { digest } : {}), incarnation: this.rt.incarnation });
    return made.operation;
  }

  // The preconditions read again and the attempt recorded, as the Release
  // Operator does, admission waited for within a bound.
  private async attempt(operation: string): Promise<{ attempt: string; capability: Capability }> {
    await this.ro.observeServiceDomains(this.project).catch((err) => log('adapter qualification', err));
    const t0 = nowMs();
    const until = t0 + 120_000;
    let held: unknown = null;
    for (;;) {
      if (this.cancel.aborted) throw new NotExercised('the engine stopped');
      const d = await this.detail(operation);
      if (!d) throw new Error(`no operation ${operation}`);
      const facts = await this.ro.facts(d);
      const v = await this.rt.engine<Verdict>('deploy.preconditions', { operation, facts });
      if (v.verdict === 'fail') throw new Error(`the precondition ${v.fact} does not hold`);
      if (v.verdict === 'none') throw new Error(`nothing to attempt: ${v.why}`);
      if (v.verdict === 'hold') {
        const manifest = await this.ro.manifest(d, v.facts);
        const made = await this.rt.engine<{ attempt?: string; capability?: Capability }>('deploy.attempt', {
          operation,
          incarnation: this.rt.incarnation,
          facts: facts as unknown as PreconditionFacts,
          manifest,
          service: { home: this.rt.home, checkCapacity: this.rt.setting('domain_memory_max') },
        });
        if (made.attempt && made.capability) {
          if (held !== null) this.waits.push({ operation, ms: Math.round(nowMs() - t0), hold: held });
          const c = made.capability;
          return { attempt: made.attempt, capability: c };
        }
      }
      if (v.verdict === 'wait') {
        held = (await this.rt.read<{ hold: unknown }>('deploy.admission', { project: this.project }).catch(() => null))?.hold ?? 'unread';
        await this.ro.observeServiceDomains(this.project).catch((err) => log('adapter qualification', err));
      }
      if (nowMs() > until) throw new NotExercised(`the service's admission was not granted within 120 s (${JSON.stringify(held)})`);
      await sleep(500);
    }
  }

  private guard = async (presented: Capability): Promise<string | null> =>
    (await this.rt.read<{ field: string } | null>('deploy.capability_check', { capability: presented, incarnation: this.rt.incarnation }))?.field ?? null;

  // The effect through `effectCall`, the adapter's one entry point.
  private async effect(cap: Capability): Promise<Awaited<ReturnType<typeof effectCall>>> {
    const r = await effectCall(adapterFor(this.adapter), cap, noLaunch, this.bounds, { guard: this.guard, cancel: this.cancel });
    await r.settled;
    return r;
  }

  private async reconcile(operation: string, attempt: string): Promise<{ outcome: string; read: unknown }> {
    const d = await this.detail(operation);
    const judged = d ? await this.ro.judge(d, attempt) : null;
    if (judged === null) return { outcome: 'unknown', read: null };
    return judged;
  }

  private async recordReconcile(operation: string, attempt: string): Promise<{ outcome: string; read: unknown }> {
    const r = await this.reconcile(operation, attempt);
    await this.rt.engine('qualify.reconciled', { attempt, outcome: r.outcome, read: r.read });
    return r;
  }

  private end(operation: string, detail: Record<string, unknown> = {}): Promise<unknown> {
    return this.rt.engine('qualify.end_op', { operation, detail });
  }

  // One whole deploy of `variant`, recorded and ended: the attempt, the
  // effect, its receipt, the reconcile read. Returns what it saw.
  private async deploy(variant: 'A' | 'B'): Promise<{ operation: string; attempt: string; unit: string; receipt: string; outcome: string; generation: number }> {
    const digest = this.artifacts![variant].digest;
    const operation = await this.intend('deploy', digest);
    try {
      const { attempt, capability } = await this.attempt(operation);
      if (capability.kind !== 'deploy') throw new Error('not a deploy capability');
      const r = await this.effect(capability);
      if (r.refused !== null) {
        await this.rt.engine('deploy.capability_refused', { attempt, field: r.refused });
        throw new Error(`the capability was refused at ${r.refused}`);
      }
      await this.rt.engine('deploy.receipt', { attempt, receipt: r.receipt, bound: r.bound });
      const rec = await this.recordReconcile(operation, attempt);
      const unit = capability.create_units[0]!;
      if (rec.outcome === 'applied') this.lastApplied = { operation, attempt, unit };
      return { operation, attempt, unit, receipt: r.receipt.result, outcome: rec.outcome, generation: capability.generation };
    } finally {
      await this.end(operation, { variant }).catch((err) => log('adapter qualification', err));
    }
  }

  // An identity read of the target (`verify`), timed and kept for the
  // evidence (BS4 §11.3).
  private async verify(caseName: string, expect: TargetExpectation[]): Promise<IdentityRead[] | { failure: string }> {
    const t0 = nowMs();
    const v = await readCall((s) => adapterFor(this.adapter).verify({ environment: this.env, prefix: this.prefix }, expect, s), this.bounds, this.cancel);
    const ms = Math.round(nowMs() - t0);
    if ('failure' in v) {
      this.identityReads.push({ case: caseName, duration_ms: ms, match: 'unread', generation: null, target: 'app' });
      return { failure: v.failure };
    }
    const reads = v.ok as IdentityRead[];
    for (const r of reads) this.identityReads.push({ case: caseName, duration_ms: ms, match: r.match, generation: r.generation, target: r.target });
    return reads;
  }

  private async expectOf(operation: string, attempt: string, variant?: 'A' | 'B'): Promise<TargetExpectation[]> {
    const d = await this.detail(operation);
    const a = d?.attempts.find((x) => x.id === attempt);
    const expect = a?.expect ?? [];
    if (!variant) return expect;
    const other = this.artifacts![variant];
    return expect.map((e) => ({ ...e, digest: other.digest, sealed_path: other.path, manifest: other.manifest }));
  }

  private async status(): Promise<TargetInventory | { failure: string }> {
    const r = await readCall((s) => adapterFor(this.adapter).status({ environment: this.env, prefix: this.prefix }, [], s), this.bounds, this.cancel);
    return 'failure' in r ? { failure: r.failure } : (r.ok as TargetInventory);
  }

  private async show(unit: string): Promise<Record<string, string> | null> {
    return (await showUnits([unit], { home: this.rt.home, env: this.env, timeoutMs: this.bounds.readMs }))?.[0] ?? null;
  }

  private async unitGone(unit: string, ms = 30_000): Promise<boolean> {
    const until = nowMs() + ms;
    for (;;) {
      const s = await this.show(unit);
      if (s?.LoadState === 'not-found') return true;
      if (nowMs() > until || this.cancel.aborted) return false;
      await sleep(250);
    }
  }

  private grants(attempt: string): Promise<number> {
    return this.rt.read<number>('qualify.grants', { attempt });
  }

  private facts(): Promise<{ observation: { condition: string; detail: unknown } | null; changes: { id: string; change: string; resource: string; closed_at: string | null; detected_at: string }[] }> {
    return this.rt.read('qualify.facts', { environment: this.env });
  }

  // ---- the cases ------------------------------------------------------------------------------

  // A case judged by its assertions and its control (AR N03), the seam's
  // forcing applied (SEAM.md §323).
  private judged(c: AdapterQualificationCase, assertions: Assertion[], control: Assertion[], detail: Record<string, unknown> = {}): Entry {
    const result: CaseResult = assertions.length > 0 && assertions.every((a) => a.held) ? 'passed' : 'failed';
    let ctl: CaseResult = control.length > 0 && control.every((a) => a.held) ? 'passed' : 'failed';
    // A control forced to fail that still held is recorded failed all the
    // same (SEAM.md §323: it is run so that it cannot succeed).
    if (this.controlFailed(c) && ctl === 'passed') ctl = 'failed';
    return this.forcedEntry({ case: c, result: ctl === 'passed' ? result : 'failed', control: ctl, detail: { ...detail, assertions, control: control } });
  }

  private forcedEntry(e: Entry): Entry {
    const f = this.forced[e.case];
    if (f === 'failed') return { ...e, result: 'failed', detail: { ...e.detail, observed: e.result, forced: 'failed by the test seam' } };
    return e;
  }

  // The control of a case, or, forced `control_failed`, the same control
  // against an expectation it cannot read (SEAM.md §323).
  private controlFailed(c: AdapterQualificationCase): boolean {
    return this.forced[c] === 'control_failed';
  }

  private async cases(record: (e: Entry) => void): Promise<void> {
    // `late_launcher` first, while nothing of the environment runs: its
    // effect then replaces no prior instance, so once its refused unit has
    // gone, `absent` is the whole truth of the attempt (D4 §2.4). Its
    // control reads a grant made later in the run (deploy_read_back's).
    const order: AdapterQualificationCase[] = ['late_launcher', 'deploy_read_back', 'unreadable', 'replace', 'receipt_lost', 'not_issued', 'refused', 'out_of_band'];
    const run: Record<string, () => Promise<Entry>> = {
      deploy_read_back: () => this.deployReadBack(),
      unreadable: () => this.unreadable(),
      replace: () => this.replace(),
      receipt_lost: () => this.receiptLost(),
      not_issued: () => this.notIssued(),
      late_launcher: () => this.lateLauncher(),
      refused: () => this.refusedCase(),
      out_of_band: () => this.outOfBand(),
    };
    for (const c of order) {
      if (this.forced[c] === 'not_exercised') {
        record({ case: c, result: 'not_exercised', control: 'not_exercised', detail: { reason: 'not run: forced by the test seam' } });
        continue;
      }
      if (this.signal.aborted) {
        record({ case: c, result: 'not_exercised', control: 'not_exercised', detail: { reason: 'the engine stopped during the qualification' } });
        continue;
      }
      try {
        const e = await run[c]!();
        // A case the engine's stop cut short is not exercised, never failed
        // (the slice-29 review, S2).
        record(this.signal.aborted ? { case: c, result: 'not_exercised', control: 'not_exercised', detail: { reason: 'the engine stopped during this case', observed: e.result } } : e);
      } catch (err) {
        if (err instanceof NotExercised || this.signal.aborted) record({ case: c, result: 'not_exercised', control: 'not_exercised', detail: { reason: this.signal.aborted ? 'the engine stopped during this case' : (err as Error).message } });
        else record(this.forcedEntry({ case: c, result: 'failed', control: 'not_exercised', detail: { reason: (err as Error).message } }));
      } finally {
        this.local?.pointBusAt(this.env, null);
      }
    }
    if (this.lateControl !== null && !this.signal.aborted) record(await this.lateControl());
  }

  // late_launcher's entry, completed with its control once a launch of the
  // run has been granted (cases()).
  private lateControl: (() => Promise<Entry>) | null = null;

  // deploy A: the grant, the init's report and the host read agree (§3.4),
  // and `verify` reads A's digest; control: B's digest differs.
  private async deployReadBack(): Promise<Entry> {
    const d = await this.deploy('A');
    const detail = await this.detail(d.operation);
    const a = detail?.attempts.find((x) => x.id === d.attempt);
    const reads = await this.verify('deploy_read_back', await this.expectOf(d.operation, d.attempt));
    const read = Array.isArray(reads) ? reads[0] : null;
    const grants = await this.grants(d.attempt);
    const assertions: Assertion[] = [
      { what: 'the reconcile read answers applied', held: d.outcome === 'applied', read: d.outcome },
      { what: 'one launch granted, the init instance recorded at the grant', held: grants === 1 && a?.init_instance != null, read: { grants, init: a?.init_instance ?? null } },
      { what: "the application instance recorded at the init's report, with no disagreement with the host read", held: a?.app_instance != null && a.app_disagreement === null, read: { app: a?.app_instance ?? null, disagreement: a?.app_disagreement ?? null } },
      { what: "verify reads A's digest on the target, the recorded instance at its generation", held: read?.match === 'match' && read.read === this.artifacts!.A.digest && read.generation === d.generation, read: Array.isArray(reads) ? reads : reads },
    ];
    // Forced `control_failed` (SEAM.md §323): the same control read made
    // where it cannot read anything (this environment's bus pointed at a
    // path that does not exist).
    const ctlExpect = await this.expectOf(d.operation, d.attempt, 'B');
    if (this.controlFailed('deploy_read_back')) this.local!.pointBusAt(this.env, join(this.rt.home, 'run', `qualify-${this.run.slice(-12).toLowerCase()}-no-bus`));
    let ctl: IdentityRead[] | { failure: string };
    try {
      ctl = await this.verify('deploy_read_back', ctlExpect);
    } finally {
      this.local!.pointBusAt(this.env, null);
    }
    const c = Array.isArray(ctl) ? ctl[0] : null;
    const control: Assertion[] = [{ what: "the same read, expecting B's digest, differs", held: c?.match === 'differs', read: Array.isArray(ctl) ? ctl : ctl }];
    return this.judged('deploy_read_back', assertions, control, { operation: d.operation, attempt: d.attempt, unit: d.unit, generation: d.generation, receipt: d.receipt });
  }

  // The bus address pointed at a path that does not exist: every read
  // unknown, never absent or applied; control: the same reads with the
  // engine's own address.
  private async unreadable(): Promise<Entry> {
    const last = this.lastApplied;
    if (!last) throw new NotExercised('no deployment of the run is running to read');
    const reads = async () => {
      const status = await this.status();
      const verify = await this.verify('unreadable', await this.expectOf(last.operation, last.attempt));
      const rec = await this.reconcile(last.operation, last.attempt);
      return { status, verify, rec };
    };
    const control = await reads();
    const path = join(this.rt.home, 'run', `qualify-${this.run.slice(-12).toLowerCase()}-no-bus`);
    this.local!.pointBusAt(this.env, path);
    let seen: Awaited<ReturnType<typeof reads>>;
    try {
      seen = await reads();
    } finally {
      this.local!.pointBusAt(this.env, null);
    }
    const unitOf = (s: TargetInventory | { failure: string }) => ('failure' in s ? null : s.inventory.find((e) => e.kind === 'unit' && e.resource === last.unit));
    const verifyMatch = (v: IdentityRead[] | { failure: string }) => (Array.isArray(v) ? v.map((r) => r.match) : [v.failure]);
    const assertions: Assertion[] = [
      { what: 'status is unread (a failure), never an empty or complete inventory', held: 'failure' in seen.status, read: 'failure' in seen.status ? seen.status : { complete: seen.status.complete, entries: seen.status.inventory.length } },
      { what: 'verify reads nothing: every identity unread', held: Array.isArray(seen.verify) ? seen.verify.length > 0 && seen.verify.every((r) => r.match === 'unread') : true, read: verifyMatch(seen.verify) },
      { what: 'reconcile answers unknown, never absent or applied', held: seen.rec.outcome === 'unknown', read: seen.rec.outcome },
    ];
    const ctl: Assertion[] = this.controlFailed('unreadable')
      ? [{ what: 'the control read against a unit the run never made', held: false, read: null }]
      : [
          { what: "with the engine's own bus, status reads the running unit", held: unitOf(control.status)?.state === 'active', read: unitOf(control.status) ?? control.status },
          { what: 'verify matches', held: Array.isArray(control.verify) && control.verify.every((r) => r.match === 'match'), read: verifyMatch(control.verify) },
          { what: 'reconcile answers applied', held: control.rec.outcome === 'applied', read: control.rec.outcome },
        ];
    return this.judged('unreadable', assertions, ctl, { bus: path, bus_existed: existsSync(path) });
  }

  // B deployed as the next generation: A's unit gone, B read back, the
  // generation recorded; control: A's unit read loaded before.
  private async replace(): Promise<Entry> {
    const prior = this.lastApplied;
    if (!prior) throw new NotExercised('no deployment of the run is running to replace');
    const before = await this.show(prior.unit);
    const d = await this.deploy('B');
    const after = await this.show(prior.unit);
    const reads = await this.verify('replace', await this.expectOf(d.operation, d.attempt));
    const read = Array.isArray(reads) ? reads[0] : null;
    const generation = await this.rt.read<{ current_generation: number | null }>('qualify.environment', { environment: this.env });
    const assertions: Assertion[] = [
      { what: 'the reconcile read answers applied', held: d.outcome === 'applied', read: d.outcome },
      { what: `${prior.unit} is gone`, held: after?.LoadState === 'not-found', read: after?.LoadState ?? 'unread' },
      { what: "verify reads B's digest", held: read?.match === 'match' && read.read === this.artifacts!.B.digest, read: Array.isArray(reads) ? reads : reads },
      { what: 'the new generation is recorded current', held: generation.current_generation === d.generation && d.generation > 1, read: { recorded: generation.current_generation, attempt: d.generation } },
    ];
    const control: Assertion[] = this.controlFailed('replace')
      ? [{ what: 'the control read of a unit the run never made', held: (await this.show(`${this.prefix}g999999.service`))?.LoadState === 'loaded', read: null }]
      : [{ what: `${prior.unit} read loaded and active before the replacement`, held: before?.LoadState === 'loaded' && before.ActiveState === 'active', read: before ? { load: before.LoadState, active: before.ActiveState } : 'unread' }];
    return this.judged('replace', assertions, control, { operation: d.operation, attempt: d.attempt, unit: d.unit, generation: d.generation, replaced: prior.unit });
  }

  // The receipt of an applied deploy dropped within this one engine process:
  // reconcile answers applied. Control: before the effect, the same read of
  // the same attempt answered absent.
  private async receiptLost(): Promise<Entry> {
    const operation = await this.intend('deploy', this.artifacts!.A.digest);
    try {
      const { attempt, capability } = await this.attempt(operation);
      if (capability.kind !== 'deploy') throw new Error('not a deploy capability');
      const before = this.controlFailed('receipt_lost') ? { outcome: 'unread', read: null } : await this.reconcile(operation, attempt);
      const r = await this.effect(capability);
      // The instrument: the receipt is dropped; nothing of it is recorded.
      const dropped = { result: r.receipt.result, bound: r.bound, refused: r.refused };
      const rec = r.refused === null ? await this.recordReconcile(operation, attempt) : { outcome: 'refused', read: null };
      if (rec.outcome === 'applied') this.lastApplied = { operation, attempt, unit: capability.create_units[0]! };
      const d = await this.detail(operation);
      const a = d?.attempts.find((x) => x.id === attempt);
      const assertions: Assertion[] = [
        { what: 'reconcile answers applied with no receipt recorded', held: rec.outcome === 'applied', read: rec.outcome },
        { what: 'the attempt holds no receipt', held: (await this.rt.read<string | null>('qualify.receipt', { attempt })) === null, read: null },
        { what: 'the attempt succeeded', held: a?.status === 'succeeded', read: a?.status ?? null },
      ];
      const control: Assertion[] = [{ what: 'before the effect, the same read answered absent', held: before.outcome === 'absent', read: before.outcome }];
      return this.judged('receipt_lost', assertions, control, {
        incarnation: this.rt.incarnation,
        scope: 'in_process',
        engine_crash: false,
        dropped_receipt: dropped,
        operation,
        attempt,
      });
    } finally {
      await this.end(operation, { case: 'receipt_lost' }).catch((err) => log('adapter qualification', err));
    }
  }

  // An attempt recorded and no effect issued: reconcile answers absent.
  // Control: the running deployment's attempt read the same way answers
  // applied.
  private async notIssued(): Promise<Entry> {
    const last = this.lastApplied;
    const operation = await this.intend('deploy', this.artifacts!.B.digest);
    try {
      const { attempt } = await this.attempt(operation);
      const rec = await this.recordReconcile(operation, attempt);
      const assertions: Assertion[] = [
        { what: 'reconcile answers absent', held: rec.outcome === 'absent', read: rec.outcome },
        { what: 'no launch was granted', held: (await this.grants(attempt)) === 0, read: await this.grants(attempt) },
      ];
      const ctl = last === null || this.controlFailed('not_issued') ? { outcome: 'unread' } : await this.reconcile(last.operation, last.attempt);
      const control: Assertion[] = [{ what: "the running deployment's attempt read the same way answers applied", held: ctl.outcome === 'applied', read: ctl.outcome }];
      return this.judged('not_issued', assertions, control, { operation, attempt });
    } finally {
      await this.end(operation, { case: 'not_issued' }).catch((err) => log('adapter qualification', err));
    }
  }

  // A unit started after its attempt's launch was closed: its launcher is
  // refused and runs nothing; while the unit is loaded reconcile does not
  // answer absent; once the unit is gone, absent. Control: an earlier
  // attempt's launcher was granted.
  private async lateLauncher(): Promise<Entry> {
    const operation = await this.intend('deploy', this.artifacts!.A.digest);
    try {
      const { attempt, capability } = await this.attempt(operation);
      if (capability.kind !== 'deploy') throw new Error('not a deploy capability');
      const unit = capability.create_units[0]!;
      await this.rt.engine('qualify.close_launch', { attempt });
      const hold = await this.ro.services!.holdRefusal(attempt);
      if (hold === null) throw new Error(`the refusal of ${attempt} could not be held: it is not a running qualification's attempt`);
      let whileLoaded: { outcome: string } = { outcome: 'unread' };
      let loaded: Record<string, string> | null = null;
      let reason: string | null = null;
      const effect = this.effect(capability);
      try {
        reason = await Promise.race([hold.reached, sleep(60_000).then(() => null)]);
        if (reason !== null) {
          loaded = await this.show(unit);
          whileLoaded = await this.reconcile(operation, attempt);
        }
      } finally {
        hold.release();
      }
      const r = await effect;
      if (r.refused !== null) await this.rt.engine('deploy.capability_refused', { attempt, field: r.refused });
      else await this.rt.engine('deploy.receipt', { attempt, receipt: r.receipt, bound: r.bound });
      // Bounded cleanup: the refused launcher ends, and its transient unit
      // with it (nothing is stopped by the run); the attempt read again and
      // recorded, its domain's closure observed and its runtime directory
      // and ingress socket removed by the engine's ordinary path; then the
      // read that decides.
      const gone = await this.unitGone(unit);
      const between = await this.recordReconcile(operation, attempt);
      await this.ro.observeServiceDomains(this.project).catch((err) => log('adapter qualification', err));
      const after = await this.reconcile(operation, attempt);
      const grants = await this.grants(attempt);
      const refusals = this.ro.services!.refusalsOf(attempt);
      const assertions: Assertion[] = [
        { what: 'the launcher asked and was refused because its launch is closed', held: reason === 'the launch is closed' && refusals.some((r) => r.reason === 'the launch is closed'), read: { reason, refusals } },
        { what: 'no launch was granted: nothing of the application ran', held: grants === 0, read: grants },
        { what: 'while the unit was loaded, reconcile did not answer absent', held: loaded?.LoadState === 'loaded' && whileLoaded.outcome !== 'absent' && whileLoaded.outcome !== 'unread', read: { unit: loaded ? { load: loaded.LoadState, active: loaded.ActiveState } : null, outcome: whileLoaded.outcome } },
        { what: 'once the unit was gone and its domain closed, reconcile answered absent', held: gone && after.outcome === 'absent', read: { gone, before_cleanup: between.outcome, outcome: after.outcome } },
      ];
      await this.rt.engine('qualify.reconciled', { attempt, outcome: after.outcome, read: after.read });
      const detail = { operation, attempt, unit };
      this.lateControl = async () => {
        const granted = this.lastApplied;
        const ctlGrants = granted === null || this.controlFailed('late_launcher') ? 0 : await this.grants(granted.attempt);
        const control: Assertion[] = [{ what: "another attempt's launcher, its launch authorizable, was granted once", held: ctlGrants === 1, read: { attempt: granted?.attempt ?? null, grants: ctlGrants } }];
        return this.judged('late_launcher', assertions, control, detail);
      };
      return this.judged('late_launcher', assertions, [{ what: 'the control is read once another launch of the run is granted', held: false, read: null }], detail);
    } finally {
      await this.end(operation, { case: 'late_launcher' }).catch((err) => log('adapter qualification', err));
    }
  }

  // Capabilities naming another environment, another digest, another unit,
  // a stale attempt and a stale lease generation, each refused by
  // `effectCall`'s check before any host call (D4 §2.2): the adapter's
  // effect entry is never reached. Control: the minted capability passes.
  private async refusedCase(): Promise<Entry> {
    const stale = await this.rt.read<string | null>('qualify.ended_attempt', { environment: this.env });
    const operation = await this.intend('deploy', this.artifacts!.A.digest);
    try {
      const { attempt, capability } = await this.attempt(operation);
      if (capability.kind !== 'deploy') throw new Error('not a deploy capability');
      const forged: { member: string; cap: Capability }[] = [
        { member: 'environment', cap: { ...capability, environment: 'env_00000000000000000000000000' } },
        { member: 'artifact_digest', cap: { ...capability, artifact_digest: this.artifacts!.B.digest } },
        { member: 'create_units', cap: { ...capability, create_units: [`${this.prefix}g${capability.generation + 1000}.service`] } },
        { member: 'attempt', cap: { ...capability, attempt: stale ?? 'att_00000000000000000000000000' } },
        { member: 'lease_generation', cap: { ...capability, lease_generation: capability.lease_generation - 1 } },
      ];
      // The control first, while the attempt is current: the minted
      // capability passes the same check.
      const ctlCap = this.controlFailed('refused') ? { ...capability, generation: capability.generation + 1 } : capability;
      const ok = await this.guard(ctlCap);
      // Each forged capability presented through `effectCall` to an adapter
      // that counts whether its effect entry was reached; every refusal is
      // recorded once all are presented (the first ends the attempt).
      let reached = 0;
      const real = adapterFor(this.adapter);
      const spy = Object.create(real) as typeof real;
      // Never the real adapter: a call that got past the check is counted
      // and refused here, so no host call can follow it.
      const stopHere = async (): Promise<EffectReceipt> => {
        reached += 1;
        return { result: 'refused', steps: [{ at: nowIso(), step: 'qualification', detail: 'the refused case reached the adapter: nothing was called' }] };
      };
      spy.deploy = stopHere;
      spy.teardown = stopHere;
      const seen: { member: string; refused: string | null; result: string }[] = [];
      for (const f of forged) {
        const r = await effectCall(spy, f.cap, noLaunch, this.bounds, { guard: this.guard, cancel: this.cancel });
        await r.settled;
        seen.push({ member: f.member, refused: r.refused, result: r.receipt.result });
      }
      for (const x of seen) if (x.refused !== null) await this.rt.engine('deploy.capability_refused', { attempt, field: x.refused });
      const assertions: Assertion[] = [
        ...seen.map((x) => ({ what: `a capability forged in ${x.member} is refused naming ${x.member}`, held: x.refused === x.member && x.result === 'refused', read: x })),
        { what: "the adapter's effect entry was never reached", held: reached === 0, read: reached },
      ];
      const control: Assertion[] = [{ what: 'the minted capability passes the same check', held: ok === null, read: ok }];
      return this.judged('refused', assertions, control, { operation, attempt, stale_attempt: stale });
    } finally {
      await this.end(operation, { case: 'refused' }).catch((err) => log('adapter qualification', err));
    }
  }

  // The unit stopped by hand, then (redeployed) restarted by hand, then
  // (redeployed) one byte of its sealed copy changed: each detected (§6.3):
  // `down`; a new invocation whose launcher is refused, nothing of the
  // application running again; an identity read that differs. Control: an
  // observation of the running deployment before each act reads healthy.
  private async outOfBand(): Promise<Entry> {
    const local = this.local!;
    const assertions: Assertion[] = [];
    const control: Assertion[] = [];
    const observe = async () => {
      await this.ro.observer.observeNow(this.env);
      return this.facts();
    };
    const healthy = async (what: string) => {
      const f = this.controlFailed('out_of_band') ? { observation: { condition: 'unread' } } : await observe();
      control.push({ what: `${what}: an observation reads healthy`, held: f.observation?.condition === 'healthy', read: f.observation });
    };
    // 1. stopped by hand.
    const one = await this.deploy('A');
    if (one.outcome !== 'applied') throw new Error(`the deployment to stop was ${one.outcome}`);
    await healthy('before the stop');
    const stopAt = nowIso();
    const stop = await local.handAct('stop', this.env, one.unit);
    const afterStop = await observe();
    assertions.push({ what: 'the stop by hand was made on the owned unit', held: stop.done, read: stop.detail });
    assertions.push({
      what: `detected: the environment down, ${one.unit} recorded stopped out of band after the stop`,
      held: afterStop.observation?.condition === 'down' && afterStop.changes.some((c) => c.change === 'stopped' && c.resource === one.unit && c.detected_at >= stopAt),
      read: afterStop,
    });
    // 2. restarted by hand.
    const two = await this.deploy('A');
    if (two.outcome !== 'applied') throw new Error(`the deployment to restart was ${two.outcome}`);
    await healthy('before the restart');
    const before = await this.show(two.unit);
    const hold = await this.ro.services!.holdRefusal(two.attempt);
    if (hold === null) throw new Error(`the refusal of ${two.attempt} could not be held: it is not a running qualification's attempt`);
    const restartAt = nowIso();
    let restart: { done: boolean; detail: string } = { done: false, detail: 'not made' };
    let reason: string | null = null;
    let during: Awaited<ReturnType<typeof this.facts>> | null = null;
    let show: Record<string, string> | null = null;
    try {
      restart = await local.handAct('restart', this.env, two.unit);
      if (restart.done) {
        reason = await Promise.race([hold.reached, sleep(60_000).then(() => null)]);
        show = await this.show(two.unit);
        during = await observe();
      }
    } finally {
      hold.release();
    }
    await this.unitGone(two.unit);
    const grants = await this.grants(two.attempt);
    const app = (await this.detail(two.operation))?.attempts.find((x) => x.id === two.attempt)?.app_instance ?? null;
    const now = app === null ? 'unread' : applicationAt(app.pid);
    const appGone = app === null ? null : now === 'unread' ? null : now !== app.start_time;
    assertions.push({ what: 'the restart by hand was made on the owned unit', held: restart.done, read: restart.detail });
    assertions.push({ what: 'a new invocation of the unit', held: show !== null && before !== null && show.InvocationID !== '' && show.InvocationID !== before.InvocationID, read: { before: before?.InvocationID ?? null, after: show?.InvocationID ?? null } });
    assertions.push({ what: 'its launcher refused because the launch is single-use and spent, and no second grant', held: reason !== null && ServiceHost.SPENT.includes(reason) && grants === 1, read: { reason, grants } });
    assertions.push({ what: 'nothing of the application runs again: the original instance is gone', held: appGone === true, read: { app, gone: appGone } });
    assertions.push({ what: `detected: ${two.unit} recorded restarted out of band after the restart`, held: (during?.changes ?? []).some((c) => c.change === 'restarted' && c.resource === two.unit && c.detected_at >= restartAt), read: during });
    // 3. one byte of the sealed copy changed.
    const three = await this.deploy('A');
    if (three.outcome !== 'applied') throw new Error(`the deployment to change was ${three.outcome}`);
    await healthy('before the byte is changed');
    const changedAt = nowIso();
    const changed = this.changeOneByte(this.artifacts!.A.path);
    let afterByte: Awaited<ReturnType<typeof this.facts>> | null = null;
    let reads: IdentityRead[] | { failure: string } = { failure: 'not read' };
    try {
      if (changed.done) {
        reads = await this.verify('out_of_band', await this.expectOf(three.operation, three.attempt));
        afterByte = await observe();
      }
    } finally {
      changed.restore();
    }
    assertions.push({ what: 'one byte of the sealed copy changed', held: changed.done, read: changed.detail });
    assertions.push({ what: 'an identity read differs', held: Array.isArray(reads) && reads.some((r) => r.match === 'differs'), read: reads });
    assertions.push({ what: `detected: ${three.unit} recorded with an identity that differs, after the change`, held: (afterByte?.changes ?? []).some((c) => c.change === 'identity_differs' && c.resource === three.unit && c.detected_at >= changedAt), read: afterByte });
    assertions.push({ what: 'the byte restored', held: changed.restored(), read: null });
    return this.judged('out_of_band', assertions, control, { stopped: one.unit, restarted: two.unit, changed: three.unit });
  }

  // One byte of this run's own sealed copy of A (`server.js`'s last byte, a
  // newline), by real path under this home's artifacts directory; restored.
  private changeOneByte(sealed: string): { done: boolean; detail: string; restore: () => void; restored: () => boolean } {
    const none = (detail: string) => ({ done: false, detail, restore: () => undefined, restored: () => false });
    let real: string;
    try {
      real = realpathSync(sealed);
    } catch {
      return none(`${sealed} cannot be read`);
    }
    const base = realpathSync(artifactsDir(this.rt.home));
    if (real !== sealed || !real.startsWith(`${base}${sep}${this.project}${sep}`) || real.slice(base.length + 1).split(sep).length !== 2) return none(`${sealed} is not this run's sealed copy by its real path`);
    const dir = lstatSync(real);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return none(`${real} is not a directory`);
    const file = join(real, 'server.js');
    let st;
    try {
      st = lstatSync(file);
    } catch {
      return none(`${file} cannot be read`);
    }
    // A link or anything but a regular file is refused (the slice-29 review,
    // m7): the byte is written only to the run's own sealed file.
    if (!st.isFile() || st.isSymbolicLink()) return none(`${file} is not a regular file`);
    const bytes = readFileSync(file);
    const mode = st.mode & 0o7777;
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = changed[changed.length - 1] === 0x0a ? 0x20 : 0x0a;
    chmodSync(file, mode | 0o200);
    writeFileSync(file, changed);
    chmodSync(file, mode);
    let back = false;
    return {
      done: true,
      detail: `${file}: its last byte changed`,
      restore: () => {
        chmodSync(file, mode | 0o200);
        writeFileSync(file, bytes);
        chmodSync(file, mode);
        back = readFileSync(file).equals(bytes) && (statSync(file).mode & 0o7777) === mode;
      },
      restored: () => back,
    };
  }

  // `teardown` then `reconcile` answers applied, and a host-side read finds
  // no unit, cgroup, socket or runtime directory of the environment.
  // Control: the same reads before it found what ran.
  private async teardownCase(): Promise<Entry> {
    if (this.env === '') throw new Error('no environment was made');
    const resources = () => this.rt.read<{ unit: string | null; cgroup_path: string | null; runtime_dir: string | null }[]>('deploy.environment_resources', { environment: this.env });
    // Each read is present, absent or unread; an unread one is never taken
    // as absent (the slice-29 review, m3).
    const hostRead = async () => {
      const s = await this.status();
      const units = 'failure' in s ? null : s.inventory.filter((e) => e.kind === 'unit').map((e) => e.resource);
      const rs = await resources();
      const cgroups = rs.filter((r) => r.cgroup_path !== null && readPopulated(r.cgroup_path).state !== 'absent').map((r) => r.cgroup_path);
      const dirs = rs.filter((r) => r.runtime_dir !== null && presence(r.runtime_dir) !== 'absent').map((r) => ({ path: r.runtime_dir, state: presence(r.runtime_dir!) }));
      let files: string[] | null;
      try {
        files = readdirSync(join(this.rt.home, 'run')).filter((n) => n.includes(this.env) || n.includes(this.prefix));
      } catch (err) {
        files = (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
      }
      return { units, cgroups, dirs, files };
    };
    const before = await hostRead();
    await this.ro.observeServiceDomains(this.project).catch(() => undefined);
    const operation = await this.intend('teardown');
    let outcome = 'unread';
    let receipt = 'not_issued';
    try {
      const d0 = await this.detail(operation);
      if (d0) {
        const jobs = await this.ro.pendingJobs(d0);
        if (jobs !== null) throw new Error(jobs);
      }
      const { attempt, capability } = await this.attempt(operation);
      const r = await this.effect(capability);
      receipt = r.receipt.result;
      if (r.refused !== null) await this.rt.engine('deploy.capability_refused', { attempt, field: r.refused });
      else {
        await this.rt.engine('deploy.receipt', { attempt, receipt: r.receipt, bound: r.bound });
        outcome = (await this.recordReconcile(operation, attempt)).outcome;
      }
    } finally {
      await this.end(operation, { case: 'teardown' }).catch((err) => log('adapter qualification', err));
    }
    await this.ro.observeServiceDomains(this.project).catch(() => undefined);
    const after = await hostRead();
    const assertions: Assertion[] = [
      { what: 'reconcile answers applied', held: outcome === 'applied', read: { receipt, outcome } },
      { what: 'no unit of the environment is listed', held: after.units !== null && after.units.length === 0, read: after.units },
      { what: 'no cgroup of it', held: after.cgroups.length === 0, read: after.cgroups },
      { what: 'no socket or runtime directory of it under run/, each read', held: after.dirs.length === 0 && after.files !== null && after.files.length === 0, read: { dirs: after.dirs, files: after.files ?? 'unread' } },
    ];
    const control: Assertion[] = [{ what: 'the same reads before it found units of the environment', held: before.units !== null && (before.units.length > 0 || before.dirs.length > 0), read: before }];
    return this.judged('teardown', assertions, control, { operation, at: nowIso() });
  }
}
