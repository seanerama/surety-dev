// The journal on the main thread (D1 §§6.3, 7.10; build spec §6 corrections
// 14 and 16; SEAM.md §§33, 44–46). An operation's intent is committed before
// its effect; the effect runs with no transaction held; its receipt, the
// probe's confirmation and the finalizer are each a transition of their own,
// with a barrier at every boundary.
//
// Two ways through an operation:
//
// - `execute`, the ordinary course, for an operation this engine has just
//   intended, or one whose effect a probe has positively reconciled as
//   absent (or boundedly partial): precondition, attempt, effect, receipt,
//   probe, confirmation, finalizer.
// - `reconcile`, for everything else: an operation another incarnation left,
//   one a deadline left ambiguous, one whose step failed in this engine. The
//   probe says what git holds, and the contract's way on is taken: finalize,
//   retry, complete, withdraw or block. Unknown and conflicting block; they
//   are never taken for absent, applied or success.
//
// An attempt this engine issued and saw complete is not reconciled: the
// engine knows its command's result, and goes on from it (probing as the
// ordinary course does). Every operation is driven by one caller at a time.

import { setTimeout as sleep } from 'node:timers/promises';

import { GIT_HOME_MARKER, GIT_INCARNATION_MARKER, GIT_OPERATION_MARKER, gitSettings } from '../git/exec.js';
import { removeResidue } from '../git/worktree.js';
import { environOf, processesWithMarker, signalFound } from '../invoke/processes.js';
import { type Runtime, log } from '../runtime.js';
import type { IntentResult, OpDetail, ProbeOutcome } from '../store/transitions/journal.js';
import { pausePoint, seamProbeOutcome } from '../testing/seam.js';
import { completeRemainder, effect, precondition, probe, readDescription, remainingScope } from './effects.js';

type Way = 'finalize' | 'retry' | 'complete' | 'withdraw' | 'block';

// Contract `probe.kinds.<kind>.<outcome>.leads_to`.
const WAYS: Record<OpDetail['kind'], Record<ProbeOutcome, Way>> = {
  ref_update: { absent: 'retry', applied: 'finalize', partial: 'block', conflicting: 'block', unknown: 'block' },
  commit_tree: { absent: 'retry', applied: 'finalize', partial: 'complete', conflicting: 'block', unknown: 'block' },
  worktree_add: { absent: 'withdraw', applied: 'finalize', partial: 'withdraw', conflicting: 'block', unknown: 'block' },
  worktree_remove: { absent: 'retry', applied: 'finalize', partial: 'complete', conflicting: 'block', unknown: 'block' },
};

export interface Settled {
  op: OpDetail;
  // What became of it: finalized, failed (refused, or withdrawn), ambiguous
  // (a deadline killed its command; not yet reconciled), or blocked.
  end: 'finalized' | 'failed' | 'ambiguous' | 'blocked';
  receipts: Record<string, unknown>;
}

export class Journal {
  // Attempts this engine issued, with what their command returned.
  private readonly results = new Map<string, 'pending' | 'ok' | 'failed' | 'timeout'>();
  // Operations this engine intended and has not yet attempted.
  private readonly fresh = new Set<string>();
  private readonly driving = new Map<string, Promise<Settled>>();
  private readonly projectLocks = new Map<string, Promise<void>>();

  constructor(private readonly rt: Runtime) {}

  private detail(op: string): Promise<OpDetail> {
    return this.rt.engine<OpDetail>('journal.detail', { operation: op });
  }

  // Run `fn` with the project's journal to itself: integrations, policy
  // changes, nominations and discards of one project are serial (E18).
  async withProject<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const before = this.projectLocks.get(project) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = before.then(() => mine);
    this.projectLocks.set(project, chained);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (this.projectLocks.get(project) === chained) this.projectLocks.delete(project);
    }
  }

  // Record an intent with the store transition `name`. The barrier
  // `intent_committed` fires once it is durable, before anything else is done.
  async intend(name: string, args: unknown, kind: OpDetail['kind']): Promise<IntentResult> {
    const made = await this.rt.engine<IntentResult | null>(name, args);
    if (made === null) return { fenced: true };
    if ('operation' in made && !made.existing) {
      this.fresh.add(made.operation);
      await pausePoint(`journal.${kind}.intent_committed`);
    }
    return made;
  }

  // Drive an operation as far as it can go now. One caller at a time per
  // operation; a second caller waits for the first and gets its result.
  drive(op: string): Promise<Settled> {
    const running = this.driving.get(op);
    if (running) return running;
    const p = this.advance(op).finally(() => this.driving.delete(op));
    this.driving.set(op, p);
    return p;
  }

  isDriving(op: string): boolean {
    return this.driving.has(op);
  }

  // An operation this engine has intended and not yet begun belongs to the
  // caller that intended it.
  isFresh(op: string): boolean {
    return this.fresh.has(op);
  }

  private async advance(id: string): Promise<Settled> {
    for (let guard = 0; guard < 16; guard++) {
      const op = await this.detail(id);
      if (op.state === 'finalized') return { op, end: 'finalized', receipts: {} };
      if (op.state === 'failed') return { op, end: 'failed', receipts: {} };
      if (op.state === 'confirmed') return this.finalize(op);
      const latest = op.attempts.at(-1);
      const known = latest ? this.results.get(`${op.id}:${latest.attempt_number}`) : undefined;
      if (latest?.status === 'started' && latest.incarnation === this.rt.incarnation && known !== undefined && known !== 'pending') {
        return this.fromResult(op, known);
      }
      if (this.fresh.has(op.id) && op.state === 'intended' && latest === undefined) return this.execute(op);
      return this.reconcile(op);
    }
    throw new Error(`operation ${id} did not settle`);
  }

  // ---- the ordinary course -------------------------------------------------------

  private async execute(op: OpDetail, remainder = false): Promise<Settled> {
    this.fresh.delete(op.id);
    const refused = remainder ? null : await precondition(op, this.rt.home);
    if (refused) {
      await this.rt.engine('journal.refuse', { operation: op.id, detail: refused, incarnation: this.rt.incarnation });
      return { op: await this.detail(op.id), end: 'failed', receipts: {} };
    }
    const started = await this.rt.engine<{ attempt: number } | { refused: string }>('journal.start_attempt', { operation: op.id, incarnation: this.rt.incarnation });
    if ('refused' in started) return { op: await this.detail(op.id), end: 'failed', receipts: {} };
    const key = `${op.id}:${started.attempt}`;
    this.results.set(key, 'pending');
    let result: 'ok' | 'failed' | 'timeout';
    try {
      result = remainder ? await completeRemainder(op) : await effect(op);
    } catch (err) {
      log('git effect', err, { operation: op.id });
      result = 'timeout';
    }
    this.results.set(key, result);
    if (result === 'ok') await pausePoint(`journal.${op.kind}.effect_applied`);
    return this.fromResult(await this.detail(op.id), result);
  }

  // Go on from what this engine's own attempt returned.
  private async fromResult(op: OpDetail, result: 'ok' | 'failed' | 'timeout'): Promise<Settled> {
    if (result === 'timeout') {
      await this.rt.engine('journal.ambiguous', { operation: op.id });
      return { op: await this.detail(op.id), end: 'ambiguous', receipts: {} };
    }
    if (result === 'failed') {
      // The command failed. Whether anything of it was made is the probe's
      // to say; a failed command is not proven absence (correction 16).
      const found = await this.probeOf(op);
      if (found !== 'applied') {
        if (found === 'unknown') return this.block(op, found);
        await this.rt.engine('journal.failed', {
          operation: op.id,
          detail: { reason: op.kind === 'ref_update' ? 'compare_and_swap_failed' : 'command_failed', found, text: `the effect was not made: git refused it, and the probe found it ${found}` },
          incarnation: this.rt.incarnation,
        });
        return { op: await this.detail(op.id), end: 'failed', receipts: {} };
      }
    }
    if (op.state === 'intended' || op.state === 'ambiguous') {
      await this.rt.engine('journal.applied', { operation: op.id });
      await pausePoint(`journal.${op.kind}.receipt_committed`);
    }
    return this.confirm(await this.detail(op.id));
  }

  private async confirm(op: OpDetail, read?: string): Promise<Settled> {
    const found = await this.probeOf(op);
    if (found !== 'applied') return this.block(op, found);
    await this.rt.engine('journal.confirmed', { operation: op.id, incarnation: this.rt.incarnation, read });
    await pausePoint(`journal.${op.kind}.probe_confirmed`);
    return this.finalize(await this.detail(op.id));
  }

  private async finalize(op: OpDetail): Promise<Settled> {
    const receipts = await this.rt.engine<Record<string, unknown>>('journal.finalize', { operation: op.id });
    await pausePoint(`journal.${op.kind}.finalizer_committed`);
    return { op: await this.detail(op.id), end: 'finalized', receipts };
  }

  // ---- reconciliation ------------------------------------------------------------

  private async probeOf(op: OpDetail): Promise<ProbeOutcome> {
    const claimed = seamProbeOutcome(op.kind);
    if (claimed !== null) return claimed as ProbeOutcome;
    try {
      return await probe(op);
    } catch (err) {
      log('probe', err, { operation: op.id });
      return 'unknown';
    }
  }

  private async reconcile(op: OpDetail): Promise<Settled> {
    // A probe says what git holds now, not what a git child that is still
    // alive is about to write: such a child of another incarnation is
    // stopped first, and while one lives the operation is not reconciled.
    const outcome = (await this.othersChildrenGone(op.id)) ? await this.probeOf(op) : 'unknown';
    const way = WAYS[op.kind][outcome];
    const read = readDescription(op);
    const foreign = op.attempts.at(-1);
    switch (way) {
      case 'finalize':
        if (op.state === 'intended' || op.state === 'ambiguous') {
          await this.rt.engine('journal.applied', { operation: op.id });
          await pausePoint(`journal.${op.kind}.receipt_committed`);
        }
        await this.rt.engine('journal.confirmed', { operation: op.id, incarnation: this.rt.incarnation, read: foreign ? read : undefined });
        await pausePoint(`journal.${op.kind}.probe_confirmed`);
        return this.finalize(await this.detail(op.id));
      case 'retry':
      case 'complete': {
        const partial = way === 'complete';
        await this.rt.engine('journal.reconcile', {
          operation: op.id,
          outcome,
          to: partial ? 'reconciled_partial' : 'reconciled_absent',
          remaining: partial ? remainingScope(op) : undefined,
          read,
        });
        await pausePoint(`journal.${op.kind}.reconciled`);
        return this.execute(await this.detail(op.id), partial);
      }
      case 'withdraw': {
        let residue = false;
        if (outcome === 'partial') {
          const removed = removeResidue(op.payload.repo, op.payload.path!);
          if (removed !== 'ok') return this.block(op, removed === 'foreign' ? 'conflicting' : 'unknown');
          residue = true;
        }
        await this.rt.engine('journal.withdraw', { operation: op.id, outcome, residueRemoved: residue, read, incarnation: this.rt.incarnation });
        await pausePoint(`journal.${op.kind}.reconciled`);
        return { op: await this.detail(op.id), end: 'failed', receipts: {} };
      }
      case 'block':
        return this.block(op, outcome);
    }
  }

  private async block(op: OpDetail, outcome: ProbeOutcome): Promise<Settled> {
    const run = (op.inputs as { run?: string }).run;
    const workItem = (op.inputs as { work_item?: string }).work_item;
    await this.rt.engine('journal.block', {
      operation: op.id,
      outcome,
      read: readDescription(op),
      question:
        `Operation ${op.id} (${op.kind}${run ? ` of run ${run}` : ''}) cannot go on: the probe found its effect ${outcome}. ` +
        'Nothing is retried, completed or finalized, and nothing the probe found is changed, until a probe can tell what git holds.',
      workItems: workItem ? [workItem] : [],
    });
    await pausePoint(`journal.${op.kind}.reconciled`);
    return { op: await this.detail(op.id), end: 'blocked', receipts: {} };
  }

  // The git children of another incarnation of this engine home that perform
  // this operation (or any operation, when they carry none): stopped, and
  // waited for. A process another engine home started is never signalled
  // (E41 item 1). Returns whether none is left alive.
  private async othersChildrenGone(op: string): Promise<boolean> {
    const mine = this.rt.incarnation;
    const home = gitSettings().home;
    const children = () =>
      (processesWithMarker(GIT_INCARNATION_MARKER) ?? []).filter((p) => {
        const env = environOf(p.pid);
        if (env === null) return false;
        if (env.get(GIT_HOME_MARKER) !== home) return false;
        const inc = env.get(GIT_INCARNATION_MARKER);
        const forOp = env.get(GIT_OPERATION_MARKER);
        return inc !== mine && (forOp === undefined || forOp === op);
      });
    let left = children();
    if (left.length === 0) return true;
    for (const p of left) signalFound(p, 'SIGKILL');
    for (let i = 0; i < 25 && left.length > 0; i++) {
      await sleep(200);
      left = children();
    }
    if (left.length > 0) log('journal', new Error(`git children of a dead incarnation are still alive: ${left.map((p) => p.pid).join(', ')}`), { operation: op });
    return left.length === 0;
  }
}
