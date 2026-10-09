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
import type { DeployDetail, Fact, RoundDetail, Verdict } from '../store/transitions/deploy.js';
import { pausePoint, seamDeployAdmission } from '../testing/seam.js';
import { type Capability, type DeployBounds, type IdentityRead, type Instance, type LaunchChannel, type Reconciliation, adapterFor, effectCall, readCall } from './adapter.js';
import { type ManifestEntry, rehash } from './artifact.js';
import { heldDigests, secretDigestKey } from './config.js';
import { judgeReconcile } from './reconcile.js';

export class ReleaseOperator {
  private readonly driving = new Map<string, Promise<void>>();
  // Attempts whose effect this process issued (D4 §4.3): any other attempt
  // left `started` is an earlier incarnation's.
  private readonly issued = new Set<string>();

  constructor(private readonly rt: Runtime) {}

  private bounds(): DeployBounds {
    const v = this.rt.config.values as unknown as Record<string, number>;
    return { effectMs: v.adapter_effect_deadline! * 1000, readMs: v.adapter_read_deadline! * 1000, outputBytes: v.adapter_output_max_bytes! };
  }

  // At start: the HMAC key made if it is not there, and every current
  // configuration whose held values no longer give its digests marked
  // `secrets_changed` (RV5).
  async atStart(): Promise<void> {
    secretDigestKey(this.rt.home);
    const configs = await this.rt.read<{ config: string; refs: string[]; digests: { ref: string; digest: string }[] }[]>('deploy.configs_with_secrets');
    const changed = configs.map((c) => {
      const now = heldDigests(this.rt.home, c.refs);
      return { config: c.config, changed: c.digests.filter((d) => now[d.ref] !== d.digest).map((d) => d.ref) };
    });
    if (changed.some((c) => c.changed.length > 0)) await this.rt.engine('deploy.secrets_changed', { configs: changed });
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
    // Each operation is driven in the background (an adapter call may take
    // longer than a tick); the tick waits a moment for each.
    for (const op of [...new Set(work.drive)]) {
      const p = this.drive(op);
      await Promise.race([p, new Promise((r) => setTimeout(r, 200).unref())]);
    }
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
      if (!d || d.stage === 'ended' || d.journal === 'failed') return;
      const latest = d.attempts.at(-1);
      if (d.journal === 'confirmed') {
        await this.rt.engine('deploy.finalize', { operation });
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
  private async facts(d: DeployDetail): Promise<Record<string, unknown>> {
    const f = d.frozen;
    const rehashed = f.manifest && f.artifact_path ? rehash(f.artifact_path, f.manifest as ManifestEntry[]) : 'none';
    const secretDigests = heldDigests(this.rt.home, f.secret_digests.map((s) => s.ref));
    const gate = d.kind === 'deploy' && f.candidate ? await gateFacts(this.rt, d.project, f.candidate) : {};
    return { rehash: rehashed, secretDigests, admission: seamDeployAdmission(f.environment) ?? 'granted', gate, now: nowIso() };
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
    if (v.verdict === 'none' || v.verdict === 'wait') return false;
    const manifest = await this.manifest(d, v.facts);
    if (v.verdict === 'fail') {
      await this.rt.engine('deploy.precondition_failed', { operation: d.id, fact: v.fact, manifest });
      return false;
    }
    const made = await this.rt.engine<{ attempt?: string; capability?: Capability; retry?: true }>('deploy.attempt', { operation: d.id, incarnation: this.rt.incarnation, facts, manifest });
    if (!made.attempt || !made.capability) return true;
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
    const { receipt, bound } = await effectCall(adapterFor(d.frozen.adapter), cap, launch, this.bounds());
    const r = await this.rt.engine<{ reconcile: boolean }>('deploy.receipt', { attempt, receipt, bound });
    await pausePoint('deploy.receipt_recorded');
    if (!r.reconcile) return false;
    const now = await this.detail(d.id);
    return now !== null && this.reconcile(now, attempt);
  }

  private async reconcile(d: DeployDetail, attempt: string): Promise<boolean> {
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
          },
          signal,
        ),
      this.bounds(),
    );
    const judged = judgeReconcile(result as { ok: Reconciliation } | { failure: never }, {
      kind: d.kind,
      digest: f.artifact_digest,
      create_units: a.intent?.create_units ?? [],
      prior: (a.intent?.prior ?? []).map((p) => p.unit),
      stop_units: a.intent?.resources ?? [],
      recorded: d.recorded_units,
      launch_state: a.launch_state,
      app_instance: a.app_instance,
    });
    const way = await this.rt.engine<{ way: string }>('deploy.reconciled', { attempt: a.id, outcome: judged.outcome, read: judged.read });
    return way.way === 'confirmed' || way.way === 'retry';
  }

  // The verification round and completion (D4 §§5.3, 5.5). false: wait.
  private async verify(d: DeployDetail): Promise<boolean> {
    const open = d.rounds.filter((r) => r.status === 'open').at(-1);
    if (!open) {
      if (d.stage !== 'completion') return false;
      const candidate = d.frozen.candidate!;
      const facts = await gateFacts(this.rt, d.project, candidate);
      await this.rt.engine('gate.evaluate', { ...facts, project: d.project, candidate, kind: 'alpha_complete', operation: d.id });
      return false;
    }
    const rd = await this.rt.read<RoundDetail | null>('deploy.round', { round: open.id });
    if (!rd) return false;
    const finalize = async (args: Record<string, unknown>) => {
      await this.rt.engine('deploy.round_finalize', { round: rd.id, ...args });
      await pausePoint('verify.row_recorded');
    };
    // The orchestration deadline (§4.7; E115): never renewed; reached, the
    // round is `unknown`, `missing` naming what was absent.
    if (Date.parse(nowIso()) > Date.parse(rd.deadline)) {
      await finalize({ reads: null, failure: null, reason: 'deadline' });
      return true;
    }
    const read = async (): Promise<{ reads: IdentityRead[] | null; failure: string | null }> => {
      const r = await readCall((signal) => adapterFor(d.frozen.adapter).verify({ environment: rd.environment.id, prefix: rd.environment.prefix }, rd.expect, signal), this.bounds());
      return 'failure' in r ? { reads: null, failure: r.failure } : { reads: Array.isArray(r.ok) ? (r.ok as IdentityRead[]) : null, failure: Array.isArray(r.ok) ? null : 'invalid_response' };
    };
    if (rd.step === 'first_read') {
      await this.rt.engine('deploy.round_first_read', { round: rd.id, ...(await read()) });
      return true;
    }
    if (rd.step === 'checks') {
      const done = await this.rt.engine<{ done: boolean }>('deploy.round_checks_done', { round: rd.id });
      if (!done.done) return false;
    }
    // A first read that did not match left no checks to bracket: the second
    // read is not made.
    const r = rd.executions.length > 0 ? await read() : { reads: null, failure: null };
    await finalize(r);
    return true;
  }
}
