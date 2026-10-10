// The observation job (D4 §6.2; D1 §8.1 step 5; SEAM.md §291), on its own
// loop: woken by every tick request (scheduler/tick.ts) and never awaited by
// the tick, so an effect or a round held at a barrier holds no observation,
// and a held or slow read holds no tick (the driver's ruling on the slice-27
// design, answer 7). Single-flight per environment; every read bounded by
// `adapter_read_deadline`; due times are durable on the engine's clock
// (store/transitions/observe.ts); stopped and awaited at shutdown.
//
// One observation: the plan read (what is expected, the revision and the
// generation it compares against, whether an identity read is due), one
// bounded `status` read and, when due, one `verify` read, both as the
// observation job's (`by`: observation), then one transition that records
// it. No transaction is held across a read (D1 §6.1). The reads use the
// adapter's existing read paths only: no host call of its own, and nothing
// here stops, signals or writes anything on the host.

import { nowIso } from '../clock.js';
import { type Runtime, log } from '../runtime.js';
import { type DeployBounds, type IdentityRead, type TargetExpectation, type TargetInventory, adapterFor, readCall } from './adapter.js';

interface Plan {
  project: string;
  environment: string;
  prefix: string;
  adapter: string;
  expected_revision: number;
  generation: number | null;
  expect: TargetExpectation[];
  identity: boolean;
}

export class Observer {
  private readonly running = new Map<string, Promise<void>>();
  private sweeping: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly ac = new AbortController();

  constructor(
    private readonly rt: Runtime,
    private readonly bounds: () => DeployBounds,
  ) {}

  // A tick was asked for: whatever is due is taken up, never awaited here.
  wake(): void {
    if (this.stopped) return;
    if (this.sweeping !== null) {
      this.again = true;
      return;
    }
    this.sweeping = this.sweep()
      .catch((err) => log('observation', err))
      .finally(() => {
        this.sweeping = null;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  private async sweep(): Promise<void> {
    const due = await this.rt.read<{ environment: string; project: string; due: boolean; missed: boolean }[]>('deploy.observations_due', { now: nowIso() });
    for (const j of due) {
      if (this.stopped) return;
      if (this.running.has(j.environment)) continue;
      if (!j.due) {
        // Past the freshness bound and not due: `unknown`, once per lapse.
        if (j.missed) await this.rt.engine('deploy.observation_lapsed', { environment: j.environment });
        continue;
      }
      const env = j.environment;
      const p = this.observe(env, j.missed)
        .catch((err) => log('observation', err, { environment: env }))
        .finally(() => this.running.delete(env));
      this.running.set(env, p);
    }
  }

  private async observe(environment: string, missed: boolean): Promise<void> {
    const plan = await this.rt.read<Plan | null>('deploy.observation_plan', { environment });
    if (plan === null) return;
    const adapter = adapterFor(plan.adapter);
    const ref = { environment: plan.environment, prefix: plan.prefix };
    const from = nowIso();
    const s = await readCall((signal) => adapter.status(ref, plan.expect, signal, 'observation'), this.bounds(), this.ac.signal);
    const status: { ok: TargetInventory } | { failure: string } =
      'failure' in s ? { failure: s.failure } : s.ok && typeof s.ok === 'object' && Array.isArray((s.ok as TargetInventory).inventory) ? { ok: s.ok as TargetInventory } : { failure: 'invalid_response' };
    let identity: { ok: IdentityRead[] } | { failure: string } | null = null;
    if (plan.identity && !('failure' in status)) {
      const v = await readCall((signal) => adapter.verify(ref, plan.expect, signal, 'observation'), this.bounds(), this.ac.signal);
      identity = 'failure' in v ? { failure: v.failure } : Array.isArray(v.ok) ? { ok: v.ok as IdentityRead[] } : { failure: 'invalid_response' };
    }
    const to = nowIso();
    if (this.stopped) return;
    await this.rt.engine('deploy.observe', { environment, from, to, expected_revision: plan.expected_revision, generation: plan.generation, status, identity, missed });
  }

  // Every read in flight aborted (the adapter's own children through their
  // handles) and awaited.
  async stop(): Promise<void> {
    this.stopped = true;
    this.ac.abort();
    await Promise.allSettled([...this.running.values(), ...(this.sweeping ? [this.sweeping] : [])]);
  }
}
