// The Release Operator (D4 §8): engine code, with no model. At each tick it
// intends the deploy work an issued authorization made and the teardowns
// the operator asked for, under the environment lease, and drives every
// operation whose orchestration has not ended, one driver per operation:
//
//   preconditions (manifest) → attempt → capability check → effect, with
//   the launch → receipt → reconcile → confirmation → finalizer → round:
//   first read → checks → second read → row → alpha_complete
//
// Every step is a store transition; between them, with no transaction held,
// the sealed copy is rehashed, the held secrets' digests computed, the
// precondition manifest written as a record, and the adapter called within
// its bounds (deploy/adapter.ts). An operation it cannot take further now
// (admission held, checks not yet recorded, a blocker) is taken up again at
// the next tick. The barriers are SEAM.md §251's.

import { nowIso } from '../clock.js';
import { gateFacts } from '../gates/prepare.js';
import { writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import type { AdmissionHold, DeployDetail, Fact, RoundDetail, Verdict } from '../store/transitions/deploy.js';
import { pausePoint, seamDeployAdmission, seamRealDeployAdapter } from '../testing/seam.js';
import { cgroupInode, readPopulated } from '../boundary/cgroup.js';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { LocalService, showUnits } from './adapters/local-service.js';
import { ServiceHost } from './service-host.js';
import { type Capability, type DeployBounds, type IdentityRead, type Instance, type LaunchChannel, type Reconciliation, adapterFor, effectCall, readCall, setProductionAdapter } from './adapter.js';
import { type ManifestEntry, rehash, sweepArtifacts } from './artifact.js';
import { heldDigests, secretDigestKey } from './config.js';
import { judgeReconcile } from './reconcile.js';

export class ReleaseOperator {
  private readonly driving = new Map<string, Promise<void>>();
  // Attempts whose effect this process issued (D4 §4.3): any other attempt
  // left `started` is an earlier incarnation's.
  private readonly issued = new Set<string>();
  // Effects whose host call has not yet returned (it passed its deadline
  // and is being awaited): no reconcile read and no retry until it has
  // (D4 §2.4, quiescence; review m1).
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // The admission hold each operation's facts read last (SEAM.md §271).
  private readonly holds = new Map<string, AdmissionHold | null>();

  // The real `local_service` adapter's host side (service-host.ts), built
  // at start when this engine deploys to real units.
  services: ServiceHost | null = null;

  constructor(private readonly rt: Runtime) {}

  // Is the real adapter in use (outside harness mode, or with
  // `--harness-deploy-adapter real`, SEAM.md §247)?
  private get real(): boolean {
    return seamRealDeployAdapter();
  }

  private bounds(): DeployBounds {
    const v = this.rt.config.values as unknown as Record<string, number>;
    return { effectMs: v.adapter_effect_deadline! * 1000, readMs: v.adapter_read_deadline! * 1000, outputBytes: v.adapter_output_max_bytes! };
  }

  // At start: the HMAC key made if it is not there, and every current
  // configuration whose held values no longer give its digests marked
  // `secrets_changed` (RV5).
  async atStart(): Promise<void> {
    // What an earlier incarnation's request sealed or staged and never
    // recorded (D4-I08; the slice-23 review's m5), removed before the API
    // serves a request that could make one.
    const swept = sweepArtifacts(this.rt.home, await this.rt.read<{ project: string; digest: string; path: string }[]>('deploy.artifact_rows'));
    for (const path of swept.refused) log('artifact sweep', new Error(`not removed: ${path}`));
    secretDigestKey(this.rt.home);
    const configs = await this.rt.read<{ config: string; refs: string[]; digests: { ref: string; digest: string }[] }[]>('deploy.configs_with_secrets');
    const changed = configs.map((c) => {
      const now = heldDigests(this.rt.home, c.refs);
      return { config: c.config, changed: c.digests.filter((d) => now[d.ref] !== d.digest).map((d) => d.ref) };
    });
    if (changed.some((c) => c.changed.length > 0)) await this.rt.engine('deploy.secrets_changed', { configs: changed });
    // The launch socket, once recovery has closed every earlier launch (D4
    // §9.2: before the engine accepts any launch request), and the real
    // adapter that creates the units its launchers connect from.
    if (this.real) {
      this.services = new ServiceHost(this.rt);
      await this.services.start();
      setProductionAdapter(new LocalService(this.rt, this.services));
      // Recovery accounts for every surviving service domain before anything
      // is dispatched (D4 §§4.7, 9.2; E126): a domain whose closure the host
      // now shows is terminated, freeing its reservation; every other keeps
      // it, counted by the envelope from its stored row.
      await this.observeServiceDomains(null).catch((err) => log('service domains', err));
    }
  }

  stop(): void {
    this.services?.stop();
  }

  // The service domains of a project whose closure the host now shows (D2
  // §3.2; D4 §9.2): a recorded cgroup absent, or, for a domain never placed
  // whose attempt has ended, its unit not loaded. Observed, never caused:
  // nothing here stops or kills anything.
  private async observeServiceDomains(project: string | null): Promise<void> {
    if (!this.real || this.services === null) return;
    const open = await this.rt.read<{ id: string; attempt: string; status: string; cgroup_path: string | null; cgroup_inode: number | null; unit: string | null; runtime_dir: string | null; environment: string }[]>(
      'deploy.service_domains',
      project === null ? {} : { project },
    );
    for (const d of open) {
      let closed = false;
      let observed = '';
      if (d.cgroup_path !== null) {
        const p = readPopulated(d.cgroup_path);
        const inode = p.state === 'absent' ? null : cgroupInode(d.cgroup_path);
        if (p.state === 'absent' && existsSync(dirname(d.cgroup_path))) {
          closed = true;
          observed = `${d.cgroup_path} is gone`;
        } else if (d.cgroup_inode !== null && inode !== null && inode !== d.cgroup_inode) {
          // A directory made again at the recorded path is another cgroup
          // (D2 §3.4): the domain's own is gone.
          closed = true;
          observed = `${d.cgroup_path} was made again (inode ${inode}, recorded ${d.cgroup_inode}): the domain's own cgroup is gone`;
        }
      } else if (d.unit !== null) {
        const lk = await this.rt.read<{ status: string } | null>('deploy.launch_lookup', { attempt: d.attempt });
        if (lk && lk.status !== 'started' && !this.inFlight.has(d.attempt)) {
          const show = await showUnits([d.unit], { home: this.rt.home, env: d.environment, timeoutMs: this.bounds().readMs }).catch(() => null);
          if (show?.[0]?.LoadState === 'not-found') {
            closed = true;
            observed = `${d.unit} was never placed and is not loaded`;
          }
        }
      }
      if (!closed) continue;
      await this.rt.engine('deploy.domain_closed', { domain: d.id, observed });
      this.services.dispose({ attempt: d.attempt, runtimeDir: d.runtime_dir });
    }
  }

  // One tick's work for a project.
  async step(project: string): Promise<void> {
    const work = await this.rt.read<{ intend: { work_item: string }[]; teardowns: string[]; drive: string[] }>('deploy.work', { project });
    for (const w of work.intend) {
      const made = await this.rt.engine<{ operation?: string }>('deploy.intend', { workItem: w.work_item, incarnation: this.rt.incarnation });
      if (made.operation) {
        await pausePoint('deploy.intended');
        work.drive.push(made.operation);
      }
    }
    for (const env of work.teardowns) {
      const made = await this.rt.engine<{ operation?: string }>('deploy.intend_teardown', { environment: env, incarnation: this.rt.incarnation });
      if (made.operation) work.drive.push(made.operation);
    }
    // Each operation is driven as far as it can go now; the tick waits for
    // it, every adapter call bounded by its deadline.
    for (const op of [...new Set(work.drive)]) await this.drive(op);
    await this.observeServiceDomains(project).catch((err) => log('service domains', err, { project }));
  }

  drive(operation: string): Promise<void> {
    const running = this.driving.get(operation);
    if (running) return running;
    const p = this.advance(operation)
      .catch((err) => log('deploy', err, { operation }))
      .finally(() => this.driving.delete(operation));
    this.driving.set(operation, p);
    return p;
  }

  private detail(operation: string): Promise<DeployDetail | null> {
    return this.rt.read<DeployDetail | null>('deploy.detail', { operation });
  }

  private async advance(operation: string): Promise<void> {
    for (let guard = 0; guard < 32; guard++) {
      const d = await this.detail(operation);
      if (!d || d.journal === 'failed') return;
      // An ended operation is still driven while a round of it is open: an
      // older round finishing late is recorded (SEAM.md §267).
      if (d.stage === 'ended' && !d.rounds.some((r) => r.status === 'open')) return;
      const latest = d.attempts.at(-1);
      if (d.journal === 'confirmed') {
        const fin = await this.rt.engine<{ round: string | null; replay: boolean }>('deploy.finalize', { operation });
        if (fin.round !== null && !fin.replay) await pausePoint('deploy.round_registered');
        continue;
      }
      if (d.journal === 'finalized') {
        if (d.kind === 'teardown') return;
        if (!(await this.verify(d))) return;
        continue;
      }
      if (latest === undefined || latest.status === 'reconciled_absent') {
        if (!(await this.attempt(d))) return;
        continue;
      }
      if (latest.status === 'started' && !this.issued.has(latest.id)) {
        await this.rt.engine('deploy.orphaned', { attempt: latest.id, incarnation: this.rt.incarnation });
        continue;
      }
      if (latest.status === 'started') return;
      // Ambiguous or partial: read again, never retried (§2.4). A read that
      // settles nothing waits for the next tick.
      if (!(await this.reconcile(d, latest.id))) return;
    }
  }

  // The preconditions' facts, read with no transaction held (D4 §4.1).
  // Admission is read first: it alone may wait, and the facts read after a
  // grant are read after it, nearest the effect (the sealed copy last).
  private async facts(d: DeployDetail): Promise<Record<string, unknown>> {
    const f = d.frozen;
    // Admission (D4 §4.7): the kernel lane's scripted answer; with the real
    // adapter, the resource envelope's for a service domain and the check
    // capacity it keeps (store/transitions/envelope.ts); with neither, none
    // is granted: the operation waits, and fails at its orchestration
    // deadline with nothing applied (review m3).
    const scripted = seamDeployAdmission(f.environment);
    let admission: 'granted' | 'held';
    let hold: AdmissionHold | null = null;
    if (scripted !== null && scripted !== undefined) {
      admission = scripted;
      if (admission !== 'granted') hold = { code: 'resource_envelope', reason: "the service's admission is not granted (SEAM.md §247)", subject: { limit: 'scripted_admission' } };
    } else if (this.real) {
      const a = await this.rt.read<{ admission: 'granted' | 'held'; hold: AdmissionHold | null }>('deploy.admission', { project: d.project });
      admission = a.admission;
      hold = a.hold;
    } else {
      admission = 'held';
      hold = { code: 'resource_envelope', reason: 'no deployment adapter admits a service domain in this engine', subject: { limit: 'no_adapter' } };
    }
    this.holds.set(d.id, hold);
    const gate = d.kind === 'deploy' && f.candidate ? await gateFacts(this.rt, d.project, f.candidate) : {};
    const secretDigests = heldDigests(this.rt.home, f.secret_digests.map((s) => s.ref));
    const rehashed = f.manifest && f.artifact_path ? rehash(f.artifact_path, f.manifest as ManifestEntry[]) : 'none';
    return { rehash: rehashed, secretDigests, admission, gate, now: nowIso() };
  }

  // A deploy waiting for its service's admission: the hold on its work item
  // (D4 §4.7, A.2; SEAM.md §271).
  private async admissionWait(d: DeployDetail): Promise<void> {
    if (d.kind !== 'deploy') return;
    const hold = this.holds.get(d.id) ?? { code: 'resource_envelope' as const, reason: "the service's admission is held", subject: { limit: 'admission' } };
    await this.rt.engine('deploy.admission_wait', { operation: d.id, hold });
  }

  // The manifest of a precondition read, as a record (SEAM.md §250).
  private manifest(d: DeployDetail, facts: Fact[]): Promise<string> {
    const content = Buffer.from(JSON.stringify({ operation: d.id, attempt: null, facts }));
    return writeWholeRecord(this.rt, { project: d.project, run: null, kind: 'deploy_precondition_manifest', content });
  }

  // Preconditions, the attempt, the capability check, the effect, the
  // receipt and the reconcile read. false: nothing more to do now.
  private async attempt(d: DeployDetail): Promise<boolean> {
    const facts = await this.facts(d);
    if (facts.rehash === 'corrupt' && d.frozen.artifact_digest) await this.rt.engine('deploy.artifact_corrupt', { project: d.project, digest: d.frozen.artifact_digest });
    const v = await this.rt.engine<Verdict>('deploy.preconditions', { operation: d.id, facts });
    if (v.verdict === 'wait' && facts.admission !== 'granted') await this.admissionWait(d);
    if (v.verdict === 'none' || v.verdict === 'wait') return false;
    const manifest = await this.manifest(d, v.facts);
    if (v.verdict === 'fail') {
      await this.rt.engine('deploy.precondition_failed', { operation: d.id, fact: v.fact, manifest });
      return false;
    }
    const made = await this.rt.engine<{ attempt?: string; capability?: Capability; retry?: true }>('deploy.attempt', {
      operation: d.id,
      incarnation: this.rt.incarnation,
      facts,
      manifest,
      service: { home: this.rt.home, checkCapacity: this.rt.setting('domain_memory_max') },
    });
    if (!made.attempt || !made.capability) {
      // Held at the attempt's own admission (the envelope moved since the
      // facts were read): shown, and taken up at the next tick.
      if (made.retry) await this.admissionWait(d);
      return false;
    }
    this.issued.add(made.attempt);
    const cap = made.capability;
    // adapterCall's check (D4 §2.2): every field against the store, before
    // any host call.
    const refused = await this.rt.read<{ field: string } | null>('deploy.capability_check', { capability: cap, incarnation: this.rt.incarnation });
    if (refused !== null) {
      await this.rt.engine('deploy.capability_refused', { attempt: made.attempt, field: refused.field });
      return false;
    }
    const attempt = made.attempt;
    const launch: LaunchChannel = {
      authorize: (init: Instance) => this.rt.engine('deploy.launch_authorize', { attempt, incarnation: this.rt.incarnation, lease_generation: cap.lease_generation, init }),
      started: async (app) => {
        await this.rt.engine('deploy.app_started', { attempt, app });
      },
    };
    await pausePoint('adapter.before_host_call');
    const { receipt, bound, settled } = await effectCall(adapterFor(d.frozen.adapter), cap, launch, this.bounds());
    if (bound !== null) {
      this.inFlight.set(attempt, settled);
      void settled.finally(() => {
        this.inFlight.delete(attempt);
        this.rt.services?.requestTick();
      });
    }
    const r = await this.rt.engine<{ reconcile: boolean }>('deploy.receipt', { attempt, receipt, bound });
    await pausePoint('deploy.receipt_recorded');
    if (!r.reconcile) return false;
    const now = await this.detail(d.id);
    return now !== null && this.reconcile(now, attempt);
  }

  private async reconcile(d: DeployDetail, attempt: string): Promise<boolean> {
    // An effect whose call is still out is not quiescent: nothing is read
    // as its outcome yet; the attempt stays ambiguous.
    if (this.inFlight.has(attempt)) return false;
    const a = d.attempts.find((x) => x.id === attempt);
    if (!a || a.generation === null) return false;
    const f = d.frozen;
    const result = await readCall(
      (signal) =>
        adapterFor(f.adapter).reconcile(
          { operation: d.id, kind: d.kind, environment: f.environment, prefix: d.prefix, digest: f.artifact_digest, targets: f.target_set },
          {
            attempt: a.id,
            generation: a.generation!,
            create_units: a.intent?.create_units ?? [],
            prior: a.intent?.prior ?? [],
            cleanup: a.intent?.cleanup ?? [],
            stop_units: a.intent?.resources ?? [],
            recorded_units: d.recorded_units,
            expect: a.expect,
          },
          signal,
        ),
      this.bounds(),
    );
    const judged = judgeReconcile(result as { ok: Reconciliation } | { failure: never }, {
      kind: d.kind,
      prefix: f.prefix,
      digest: f.artifact_digest,
      create_units: a.intent?.create_units ?? [],
      prior: a.intent?.prior ?? [],
      stop_units: a.intent?.resources ?? [],
      recorded: d.recorded_units,
      // A launch granted is a launch granted, whatever its state now: the
      // grant's record, the init's instance, outlives the closure (S2).
      launch_granted: a.init_instance !== null || a.launch_state === 'authorized',
      app_instance: a.app_instance,
      binding_conflict: a.app_disagreement !== null,
    });
    const way = await this.rt.engine<{ way: string }>('deploy.reconciled', { attempt: a.id, outcome: judged.outcome, read: judged.read });
    return way.way === 'confirmed' || way.way === 'retry';
  }

  // The verification rounds and completion (D4 §§5.3, 5.5). Every open round
  // of the operation is driven, in order, whatever order they finish in; the
  // newest registered decides (E114). Completion is evaluated at the tick
  // after the deciding row (SEAM.md §270). false: nothing more now.
  private async verify(d: DeployDetail): Promise<boolean> {
    const open = d.rounds.filter((r) => r.status === 'open');
    if (open.length === 0) {
      if (d.stage !== 'completion') return false;
      // Completion may release the lease: never while an execution of the
      // operation's rounds may still hold its service link open (D4 §4.7;
      // the review's m1).
      const live = await this.rt.read<{ count: number }>('deploy.live_executions', { operation: d.id });
      if (live.count > 0) return false;
      await pausePoint('deploy.before_completion');
      const candidate = d.frozen.candidate!;
      const facts = await gateFacts(this.rt, d.project, candidate);
      await this.rt.engine('gate.evaluate', { ...facts, project: d.project, candidate, kind: 'alpha_complete', operation: d.id });
      return false;
    }
    let more = false;
    for (const r of open) more = (await this.driveRound(d, r.id)) || more;
    return more;
  }

  // One step of one open round. true: it can go further now.
  private async driveRound(d: DeployDetail, round: string): Promise<boolean> {
    const rd = await this.rt.read<RoundDetail | null>('deploy.round', { round });
    if (!rd || rd.status !== 'open') return false;
    const recorded = async () => {
      await pausePoint('verify.row_recorded');
      this.rt.services?.requestTick();
    };
    const finalize = async (args: Record<string, unknown>) => {
      await this.rt.engine('deploy.round_finalize', { round: rd.id, ...args });
      await recorded();
    };
    // The deadline (§4.7; E115; CD1): the round's own, or the operation's;
    // never renewed; reached, the round is `unknown`, `missing` naming what
    // was absent.
    if (Date.parse(nowIso()) > Date.parse(rd.deadline)) {
      await finalize({ reads: null, failure: null, reason: 'deadline' });
      return false;
    }
    // A channel loss this incarnation saw must be durable before the round
    // can be decided on (the review's m4).
    if (this.services !== null && !(await this.services.lossRecorded(rd.attempt))) return false;
    // Its bindings, its service's supervision and its lease, before any read.
    const step = await this.rt.engine<{ state: string; step?: string }>('deploy.round_step', { round: rd.id, incarnation: this.rt.incarnation });
    if (step.state === 'superseded') return true;
    if (step.state === 'decided') {
      await recorded();
      return false;
    }
    if (step.state !== 'go') return false;
    const read = async (): Promise<{ reads: IdentityRead[] | null; failure: string | null }> => {
      const r = await readCall((signal) => adapterFor(d.frozen.adapter).verify({ environment: rd.environment.id, prefix: rd.environment.prefix }, rd.expect, signal), this.bounds());
      return 'failure' in r ? { reads: null, failure: r.failure } : { reads: Array.isArray(r.ok) ? (r.ok as IdentityRead[]) : null, failure: Array.isArray(r.ok) ? null : 'invalid_response' };
    };
    if (step.step === 'first_read') {
      await this.rt.engine('deploy.round_first_read', { round: rd.id, ...(await read()) });
      return true;
    }
    if (step.step === 'checks') {
      const done = await this.rt.engine<{ done: boolean }>('deploy.round_checks_done', { round: rd.id });
      if (!done.done) return false;
    }
    // A first read that did not match left no checks to bracket: the second
    // read is not made.
    const r = rd.executions.length > 0 ? await read() : { reads: null, failure: null };
    await finalize(r);
    return false;
  }
}
