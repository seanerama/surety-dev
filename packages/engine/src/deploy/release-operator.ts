// The Release Operator (D4 §8): engine code, with no model. At each tick it
// intends the deploy work an issued authorization made, under the
// environment lease, and drives every operation whose orchestration has not
// ended, one driver per operation:
//
//   preconditions → attempt → capability check → effect → receipt →
//   reconcile → confirmation → finalizer → round: first read → checks →
//   second read → row → alpha_complete
//
// Every step is a store transition; between them, with no transaction held,
// the sealed copy is rehashed, the held secrets' digests computed, and the
// adapter called within its bounds (deploy/adapter.ts). A barrier sits at
// every boundary the M4 plan names (§2.3). An operation it cannot take
// further now (admission held, checks not yet recorded, a blocker) is taken
// up again at the next tick.

import { nowIso } from '../clock.js';
import { gateFacts } from '../gates/prepare.js';
import { type Runtime, log } from '../runtime.js';
import type { Capability, IdentityRead, TargetExpectation } from './adapter.js';
import { adapterFor, deployBounds, effectCall, readCall } from './adapter.js';
import { heldDigests, secretDigestKey } from './config.js';
import { type ManifestEntry, rehash } from './artifact.js';
import { judgeReconcile } from './reconcile.js';
import type { DeployDetail, RoundDetail } from '../store/transitions/deploy.js';
import { pausePoint, seamDeployAdmission } from '../testing/seam.js';

export class ReleaseOperator {
  private readonly driving = new Map<string, Promise<void>>();
  // Attempts whose effect this process issued (D4 §4.3): any other attempt
  // left `started` is an earlier incarnation's.
  private readonly issued = new Set<string>();

  constructor(private readonly rt: Runtime) {}

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
    const work = await this.rt.read<{ intend: { work_item: string }[]; drive: string[] }>('deploy.work', { project });
    for (const w of work.intend) {
      await pausePoint('deploy.requested');
      const made = await this.rt.engine<{ operation?: string }>('deploy.intend', { workItem: w.work_item, incarnation: this.rt.incarnation, deadlineSeconds: deployBounds().orchestrationSeconds });
      if (made.operation) {
        await pausePoint('deploy.intended');
        work.drive.push(made.operation);
      }
    }
    // Each operation is driven in the background: an adapter call may take
    // longer than a tick. The tick waits only a moment for each.
    for (const op of [...new Set(work.drive)]) {
      const p = this.drive(op);
      await Promise.race([p, new Promise((r) => setTimeout(r, 50).unref())]);
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

  isDriving(operation: string): boolean {
    return this.driving.has(operation);
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
        await pausePoint('deploy.before_finalizer');
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
      // Ambiguous or partial: read again, never retried (§2.4).
      if (!(await this.reconcile(d, latest.id))) return;
    }
  }

  // The preconditions' facts, read with no transaction held (D4 §4.1).
  private async facts(d: DeployDetail): Promise<Record<string, unknown>> {
    const f = d.frozen;
    let rehashed: string = 'none';
    if (f.artifact) {
      const manifest = await this.rt.read<ManifestEntry[] | null>('deploy.artifact_manifest', { project: d.project, digest: f.artifact.digest });
      rehashed = manifest === null ? 'unread' : rehash(f.artifact.path, manifest);
    }
    const secretDigests = heldDigests(this.rt.home, (f.config?.secret_digests ?? []).map((s) => s.ref));
    const adapter = adapterFor(f.environment.adapter);
    const expect: TargetExpectation[] = f.targets.map((t) => ({ target: t, digest: f.artifact?.digest ?? '', unit: null, generation: null, instance: null }));
    const status = await readCall((signal) => adapter.status({ environment: f.environment.id, prefix: f.environment.prefix }, expect, signal));
    const inventory =
      'failure' in status
        ? { unread: status.failure }
        : { units: status.ok.map((t) => t.unit).filter((u): u is string => typeof u === 'string') };
    const gate = d.kind === 'deploy' && f.candidate ? await gateFacts(this.rt, d.project, f.candidate) : {};
    return { rehash: rehashed, secretDigests, admission: seamDeployAdmission() ?? 'granted', inventory, gate, now: nowIso() };
  }

  // Preconditions, the attempt, the capability check, the effect, the
  // receipt and the reconcile read. false: nothing more to do now.
  private async attempt(d: DeployDetail): Promise<boolean> {
    const facts = await this.facts(d);
    const made = await this.rt.engine<{ attempt?: string; capability?: Capability; waiting?: string; failed?: string; skipped?: string }>('deploy.attempt', {
      operation: d.id,
      incarnation: this.rt.incarnation,
      facts,
    });
    if (!made.attempt || !made.capability) return false;
    this.issued.add(made.attempt);
    await pausePoint('deploy.attempt_recorded');
    const cap = made.capability;
    // adapterCall's check (D4 §2.2): every field against the store, before
    // any host call.
    const refused = await this.rt.read<{ field: string } | null>('deploy.capability_check', { capability: cap, incarnation: this.rt.incarnation });
    if (refused !== null) {
      await this.rt.engine('deploy.capability_refused', { attempt: made.attempt, field: refused.field });
      return false;
    }
    await pausePoint('adapter.before_host_call');
    const { receipt, bound } = await effectCall(adapterFor(d.frozen.environment.adapter), cap);
    await pausePoint('adapter.after_host_call');
    const r = await this.rt.engine<{ reconcile: boolean }>('deploy.receipt', { attempt: made.attempt, receipt, bound });
    await pausePoint('deploy.receipt_recorded');
    if (!r.reconcile) return false;
    const now = await this.detail(d.id);
    return now !== null && this.reconcile(now, made.attempt);
  }

  private async reconcile(d: DeployDetail, attempt: string): Promise<boolean> {
    const a = d.attempts.find((x) => x.id === attempt);
    if (!a || a.generation === null) return false;
    const f = d.frozen;
    const adapter = adapterFor(f.environment.adapter);
    const result = await readCall((signal) =>
      adapter.reconcile(
        { operation: d.id, kind: d.kind, environment: f.environment.id, prefix: f.environment.prefix, digest: f.artifact?.digest ?? null, targets: f.targets },
        {
          attempt: a.id,
          generation: a.generation!,
          createUnits: a.intent?.create_units ?? [],
          prior: a.intent?.prior ?? [],
          cleanup: a.intent?.cleanup ?? [],
          stopUnits: a.intent?.resources ?? [],
          recordedUnits: d.recorded_units,
          instance: a.app_instance,
        },
        signal,
      ),
    );
    const judged = judgeReconcile(result, { kind: d.kind, targets: f.targets, recorded: d.recorded_units });
    const way = await this.rt.engine<{ way: string }>('deploy.reconciled', {
      attempt: a.id,
      outcome: judged.outcome,
      read: judged.read,
      instance: judged.instance,
      autoRetriesMax: deployBounds().autoRetries,
    });
    if (way.way === 'confirmed') {
      await pausePoint('deploy.confirmed');
      return true;
    }
    return way.way === 'retry';
  }

  // The verification round and completion (D4 §§5.3, 5.5). false: wait.
  private async verify(d: DeployDetail): Promise<boolean> {
    const open = d.rounds.filter((r) => r.status === 'open').at(-1);
    if (!open) {
      if (d.stage !== 'completion') return false;
      await pausePoint('deploy.before_completion');
      const candidate = d.frozen.candidate!;
      const facts = await gateFacts(this.rt, d.project, candidate);
      await this.rt.engine('gate.evaluate', { ...facts, project: d.project, candidate, kind: 'alpha_complete', operation: d.id });
      return false;
    }
    const rd = await this.rt.read<RoundDetail | null>('deploy.round', { round: open.id });
    if (!rd) return false;
    // The orchestration deadline (§4.7; E115): never renewed; reached, the
    // round is `unknown`, `missing` naming what was absent.
    if (Date.parse(nowIso()) > Date.parse(rd.deadline)) {
      await this.rt.engine('deploy.round_finalize', { round: rd.id, reads: null, failure: null, reason: 'deadline' });
      return true;
    }
    const adapter = adapterFor(d.frozen.environment.adapter);
    const read = async (): Promise<{ reads: IdentityRead[] | null; failure: string | null }> => {
      const r = await readCall((signal) => adapter.verify({ environment: rd.environment.id, prefix: rd.environment.prefix }, rd.expect, signal));
      return 'failure' in r ? { reads: null, failure: r.failure } : { reads: r.ok, failure: null };
    };
    if (rd.step === 'first_read') {
      const r = await read();
      await this.rt.engine('deploy.round_first_read', { round: rd.id, ...r });
      await pausePoint('verify.after_first_read');
      return true;
    }
    if (rd.step === 'checks') {
      const done = await this.rt.engine<{ done: boolean }>('deploy.round_checks_done', { round: rd.id });
      if (!done.done) return false;
    }
    await pausePoint('verify.before_second_read');
    const fresh = await this.rt.read<RoundDetail | null>('deploy.round', { round: open.id });
    // A first read that did not match left no checks to bracket: the
    // second is not made.
    const bracketed = fresh !== null && fresh.executions.length > 0;
    const r = bracketed ? await read() : { reads: null, failure: null };
    await this.rt.engine('deploy.round_finalize', { round: rd.id, ...r });
    return true;
  }
}
