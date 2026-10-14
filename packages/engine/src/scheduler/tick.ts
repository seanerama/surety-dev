// The scheduler (D1 §1.5, §8.1). One tick every tick_interval, or when a tick
// is requested through the API, which only sets a flag this loop consumes.
// One tick runs at a time.
//
// A tick, for every registered project:
//   1. Recover: a run end of the project that failed part way is retried at
//      once (not waited for); quarantined runs are observed again, and a
//      domain the boundary now reports terminated is cleared and its run
//      ended. Every run lease past its expiry is reconciled through the
//      run-end protocol.
//   2. Journal: every operation of the project that is not finalized and
//      not failed, and that nothing in this engine is driving, is probed and
//      taken on its way (correction 14); a nomination that is due is made.
//   3. Repository integrity (D1 §7.6).
//   (4. budgets: a project whose day has passed a day limit is not
//      dispatched; the select step and the claim check it, and a check whose
//      read fails dispatches nothing of the project.)
//   8. Select, and 9. dispatch: every eligible item in priority order, each
//      the envelope admits (D6 K2: no run count at either scope; one run
//      per work item); work at its chaining boundary is not
//      dispatched and gets one decision instead (D1-34); the tick waits for
//      what a dispatch writes before its spawn, never for the spawn or the run.
//  Then records whose retention has passed expire, and
//  10. engine.tick, after everything else the tick wrote.
//
// Steps 1 to 3 are safety prerequisites: one that overruns tick_step_budget
// or fails for a project makes that project's dispatch ineligible for this
// tick, also if it completes later; a tick that has used up tick_budget
// dispatches nothing further. Budgets are measured on the monotonic clock: a
// wall clock that steps back cannot stretch them (E30).

import type { PhaseStepResult } from '../plan/phase.js';
import { performance } from 'node:perf_hooks';

import { observeIntegrity } from '../git/integrity.js';
import { Launcher } from '../invoke/choke.js';
import type { Journal } from '../journal/driver.js';
import type { ProjectCandidates } from '../store/reads.js';
import { expireRecords } from '../records/retention.js';
import { type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import { pausePoint, seamNotifyChannel, seamPrepareError, seamStepDelay } from '../testing/seam.js';
import { nowMs } from '../clock.js';
import { type Effects, classifyDue } from '../decisions/effects.js';
import { deliverNotifications } from '../decisions/notify.js';
import { publishAuthorized } from '../plan/publish.js';
import { rebindBundles } from '../plan/rebind.js';
import { ensureAncestry, ensurePresence, gateFacts } from '../gates/prepare.js';
import { prepareDeployment, settleDeployment } from '../deploy/commands.js';
import { Refusal } from '../refusal.js';
import { ENGINE_VERSION } from '../index.js';

const PREREQUISITES = ['recover', 'journal', 'integrity'] as const;

// Whether `work` settled successfully within `ms`.
async function withinBudget(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = work.then(
    () => true,
    (err) => {
      log('tick step', err);
      return false;
    },
  );
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Scheduler {
  private flag = false;
  // Requests set since the running tick began (D6 K1): what the next tick
  // coalesces, recorded on its engine.tick.
  private requests = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  // When the last tick began, on the engine's clock: the interval tick falls
  // due at it plus tick_interval (the driver's ruling Q12, slice 37).
  private lastTickAt = nowMs();

  constructor(
    private readonly rt: Runtime,
    private readonly launcher: Launcher,
    private readonly ender: RunEnder,
    private readonly journal: Journal,
    private readonly effects: Effects,
  ) {}

  start(): void {
    this.lastTickAt = nowMs();
    // `tick_interval` stays the ceiling of idle (K1): a tick falls due on the
    // engine's clock, polled each second; a clock that steps back only delays
    // what is due by the step.
    this.timer = setInterval(() => {
      if (this.running || this.flag) return;
      if (nowMs() - this.lastTickAt >= this.rt.setting('tick_interval') * 1000) this.request();
    }, 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  // D1 §1.5's flag, set by the API, the engine's own requests and the
  // transitions of K1 (`n` requests at once); never a re-entry into a
  // running tick: the loop below runs one tick after another.
  request(n = 1): void {
    // The observation job runs off the tick (D4 §6.2; deploy/observe.ts):
    // woken here, never awaited, so a tick held by an effect holds no
    // observation.
    this.rt.deploy?.observer.wake();
    this.flag = true;
    this.requests += Math.max(1, n);
    if (!this.running && !this.stopped) void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.flag && !this.stopped) {
        this.flag = false;
        const coalesced = this.requests;
        this.requests = 0;
        await this.tick(coalesced).catch((err) => log('tick', err));
      }
    } finally {
      this.running = false;
    }
  }

  private async step(name: (typeof PREREQUISITES)[number], project: string): Promise<void> {
    await seamStepDelay(name, project);
    if (name === 'recover') {
      this.ender.retryDue(project);
      await this.ender.observeQuarantines(project);
      await this.ender.reconcileExpired(project);
    } else if (name === 'journal') {
      await reconcileProject(this.rt, this.journal, project);
      await this.rt.services?.nominate(project);
      // A run whose end waited for one of these operations goes on now.
      this.ender.retryDue(project);
    } else {
      await observeIntegrity(this.rt, project);
    }
  }


  private async decide(project: string): Promise<void> {
    // The host as it is at this engine start, once per project and
    // incarnation (D6 §7.6); its backend entry kept current within it.
    await this.rt
      .engine('pace.observe_host', {
        project,
        incarnation: this.rt.incarnation,
        engine_version: ENGINE_VERSION,
        settings: Object.fromEntries((['tick_interval', 'domain_memory_max', 'max_concurrent_domains'] as const).map((k) => [k, this.rt.setting(k)])),
      })
      .catch((err) => log('host observation', err, { project }));
    await ensureAncestry(this.rt, project);
    // The repairs failed checks owe (D3 §2.10): reconciled from durable
    // state at every tick, so a failure recorded while its item was not yet
    // verifying is repaired by the next tick at the latest.
    await this.rt.engine('work.reconcile_repairs', { project }).catch((err) => log('check repair', err, { project }));
    // The candidates' module presence (D3 §4.1), before Gates and Checks: a
    // registration owed for want of it is made once it is read (L2).
    await ensurePresence(this.rt, project).catch((err) => log('module presence', err, { project }));
    // Every stage gate that is due (SEAM.md §70): a candidate's verification
    // is complete and the stage's work it holds is still verifying, with no
    // evaluation or a stale one.
    const due = await this.rt.read<{ candidate: string; stage: string }[]>('gates.due', { project });
    for (const g of due) {
      const facts = await gateFacts(this.rt, project, g.candidate);
      await this.rt.engine('gate.evaluate', { project, candidate: g.candidate, kind: 'stage', stage: g.stage, ...facts }).catch((err) => log('stage gate', err, { project, ...g }));
    }
    // The phase (D6 §5.8): its checks registered, its gate evaluated on the
    // facts read here, its completion; once per tick.
    await this.phase(project).catch((err) => log('phase', err, { project }));
    // `alpha_deploy: on_phase_complete` (D6 §6.8; SEAM.md §354): the request
    // a completed phase owes, made through requestDeployment's own path.
    await this.alphaPolicy(project).catch((err) => log('alpha policy', err, { project }));
    // The classifier (D3 §1.6; SEAM.md §215): every captured proposal,
    // classified at a tick after its capture, its question raised.
    await classifyDue(this.rt, project).catch((err) => log('classification', err, { project }));
    // A proposed bundle is never left without an open decision (B03): a
    // head move re-binds it or makes it stale, before the decisions'
    // review.
    await rebindBundles(this.rt, project).catch((err) => log('bundle rebind', err, { project }));
    await this.rt.engine('decisions.review', { project, channel: seamNotifyChannel() ?? 'none' });
    // The engine-scoped decisions (SEAM.md §117) are reviewed with every
    // project's tick: a dependency that changed raises their next generation.
    await this.rt.engine('decisions.review', { project: null, channel: 'none' });
    await this.effects.step(project);
    // The authorized finalizer (D6 §5.5): a bundle whose authority is
    // complete and which a restart left unpublished is published now, once.
    await publishAuthorized(this.rt, project).catch((err) => log('publication', err, { project }));
    await deliverNotifications(this.rt, project);
  }

  private async phase(project: string): Promise<void> {
    const step = await this.rt.engine<PhaseStepResult>('phase.step', { project });
    if (!step.evaluate) return;
    const facts = await gateFacts(this.rt, project, step.evaluate.candidate);
    await this.rt.engine('gate.evaluate', { project, candidate: step.evaluate.candidate, kind: 'phase', phase_plan: step.evaluate.phase_plan, ...facts });
    await this.rt.engine('phase.step', { project });
  }

  private async alphaPolicy(project: string): Promise<void> {
    const due = await this.rt.read<{ candidate: string; environment: string; key: string } | null>('deploy.policy_due', { project });
    if (!due) return;
    // Refused at its preparation (the runtime, the artifact): recorded
    // `not_issued` under its key with the reason, never made again (the 31b
    // review's S6). Any other error is counted on the key's row and the key
    // prepared again at most `deploy_auto_retries_max` more times, then
    // `not_issued` `preparation_failed` (the driver's ruling Q4, slice 37):
    // with ticks requested by events, an unbounded retry would be a hot loop.
    const failed = async (err: unknown) => {
      if (err instanceof Refusal) {
        await this.rt.engine('deploy.policy_refused', { project, candidate: due.candidate, environment: due.environment, key: due.key, refusal: { code: err.code, reason: err.reason } });
        return;
      }
      log('alpha policy preparation', err, { project });
      await this.rt.engine('deploy.policy_preparation_failed', { project, candidate: due.candidate, environment: due.environment, key: due.key, error: err instanceof Error ? err.message : String(err) });
    };
    let prepared: Awaited<ReturnType<typeof prepareDeployment>>;
    try {
      prepared = await prepareDeployment(this.rt, project, { candidate: due.candidate, environment: due.environment });
    } catch (err) {
      await failed(err);
      return;
    }
    try {
      // SEAM.md §433: an unexpected error after the sealing, before the
      // request's transaction: the preparation's.
      if (seamPrepareError(project)) {
        await failed(new Error('an unexpected error in the preparation of the deploy request (injected)'));
        return;
      }
      await this.rt.engine('deploy.policy_request', prepared);
    } finally {
      await settleDeployment(this.rt, prepared);
    }
  }

  private async tick(requests: number): Promise<void> {
    const started = performance.now();
    this.lastTickAt = nowMs();
    // The steps this tick ran, in order (engine.tick.payload.steps; D1 §8.1).
    const steps: string[] = [];
    const tickBudget = this.rt.setting('tick_budget') * 1000;
    const stepBudget = this.rt.setting('tick_step_budget') * 1000;
    const remaining = () => tickBudget - (performance.now() - started);
    const projects = await this.rt.read<string[]>('scheduler.projects');
    const ineligible = new Set<string>();
    for (const name of PREREQUISITES) {
      steps.push(name);
      for (const project of projects) {
        if (ineligible.has(project)) continue;
        const limit = Math.min(stepBudget, remaining());
        if (limit <= 0 || !(await withinBudget(this.step(name, project), limit))) ineligible.add(project);
      }
    }
    // 4. Budgets (D1 §8.1 step 4): a project whose day has passed a day limit
    // is not dispatched, nor one whose limits could not be read; the claim
    // checks it again.
    steps.push('budgets');
    for (const project of projects) {
      if (ineligible.has(project)) continue;
      const over = await this.rt.read<string[]>('scheduler.budgets', { project }).catch(() => null);
      if (over === null || over.length > 0) ineligible.add(project);
    }
    // The gates, the attention queue, the effects of consumed decisions and
    // the notifications of escalated ones (D1 §8.1 steps 5 to 7). Not
    // prerequisites of dispatch: a failure is reported and the tick goes on.
    for (const project of projects) {
      if (remaining() <= 0) break;
      await this.decide(project).catch((err) => log('tick decide', err, { project }));
    }
    // Checks (D3 §2.5; L2): after Gates, registrations owed, supervision,
    // and the admission of queued executions. Not a prerequisite of dispatch.
    for (const project of projects) {
      if (remaining() <= 0) break;
      await this.rt.checks?.step(project).catch((err) => log('tick checks', err, { project }));
    }
    // Deployments (D4 §§4, 5; the Release Operator, engine code, D4 §8):
    // deploy work intended under the environment lease, and every
    // operation whose orchestration has not ended taken on. Not a
    // prerequisite of dispatch.
    for (const project of projects) {
      if (remaining() <= 0) break;
      await this.rt.deploy?.step(project).catch((err) => log('tick deploy', err, { project }));
    }
    // Authorized qualification attempts: their canaries are dispatched by
    // their own authority (D2 §7.2, K10), not by the queue below.
    await this.rt.services?.qualificationStep().catch((err) => log('qualification', err));
    let dispatched = 0;
    // The turns sessions admitted (D6 §2.2; SEAM.md §344): dispatched by the
    // tick, the choke point's one caller, never by the turn route.
    // Sessions idle past their timeout closed by the idle protocol (D6
    // §2.4; B01) before any turn is dispatched; one whose budget is spent is
    // closed at the settlement that spent it (sessions/driver.ts).
    if (remaining() > 0 && this.rt.sessions) await this.rt.sessions.sweep().catch((err) => log('session sweep', err));
    if (remaining() > 0 && this.rt.sessions) dispatched += await this.rt.sessions.dispatchTurns().catch((err) => {
      log('turn dispatch', err);
      return 0;
    });
    await pausePoint('scheduler.tick_running');
    steps.push('select');
    if (remaining() > 0 && this.rt.selectHeld === 0) {
      const candidates = await this.rt.read<ProjectCandidates[]>('scheduler.candidates');
      steps.push('dispatch');
      // D6 K2 (B09): every eligible item in priority order, each admitted
      // or held by the envelope; no run count caps either scope. The
      // projects are taken in turn, one item each round, so no project's
      // queue starves another's under tick_budget (N02).
      const queues = candidates.filter((c) => !ineligible.has(c.project) && c.items.length > 0).map((c) => ({ c, items: [...c.items] }));
      // Each item claimed in turn, in priority order; what the claimed runs
      // need before their spawns made side by side, and waited for before
      // the tick ends (D1 §8.1 step 9: the tick waits for what a dispatch
      // writes before its spawn, never for the spawn or the run).
      const preparing: Promise<void>[] = [];
      while (queues.some((q) => q.items.length > 0) && remaining() > 0) {
        for (const q of queues) {
          const item = q.items.shift();
          if (!item || remaining() <= 0) continue;
          try {
            if (item.boundary) {
              // D1-34: the next step is a decision, asked once.
              await this.rt.engine('scheduler.chain_boundary', { workItem: item.id });
              continue;
            }
            // An item the envelope holds now is not offered to the launcher,
            // whose preflight reads and runs the entry's binary: with every
            // eligible item selected (K2) and ticks requested by events (K1),
            // that would be done for every held item at every tick. An item
            // whose backend the store already refuses goes on, so a refusal
            // never waits behind a domain (D2 §3.7).
            if (await this.rt.read<boolean>('scheduler.envelope_holds', { project: q.c.project, workItem: item.id })) continue;
            const claimed = await this.launcher.claimThenPrepare(q.c, item);
            if (claimed) {
              dispatched++;
              preparing.push(claimed.prepared.catch((err) => log('dispatch', err)));
            }
          } catch (err) {
            log('dispatch', err);
          }
        }
      }
      await Promise.all(preparing);
      // Why each item still eligible waits, recorded as intervals by reason
      // (N01; the driver's ruling Q3): one interval per hold, never one per tick.
      await this.rt.engine('work.mark_holds', {}).catch((err) => log('work holds', err));
    }
    // Records nothing live refers to expire once their retention has passed
    // (D1 §14.3). Not a prerequisite of dispatch.
    await expireRecords(this.rt).catch((err) => log('record expiry', err));
    await this.rt.engine('engine.tick', { incarnation: this.rt.incarnation, dispatched, requests, steps });
  }
}

// Every unfinished operation of a project (or of every project), oldest
// first, taken on its way. One that this engine is driving is waited for;
// one this engine has just intended and not yet begun is its caller's.
//
// A finalizer may intend the next operation of a chain (a bootstrap's or a
// policy change's ref update after its commit): the list is read again until
// it holds nothing this pass has not taken on.
export async function reconcileProject(rt: Runtime, journal: Journal, project?: string): Promise<void> {
  const seen = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    const ops = (await rt.read<{ id: string; project: string }[]>('journal.unfinished', { project: project ?? null })).filter((op) => !seen.has(op.id) && !journal.isFresh(op.id));
    if (ops.length === 0) return;
    for (const op of ops) {
      seen.add(op.id);
      await journal.withProject(op.project, () => journal.drive(op.id)).catch((err) => log('journal', err, { operation: op.id }));
    }
  }
}
