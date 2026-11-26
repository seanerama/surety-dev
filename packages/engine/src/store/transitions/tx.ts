// The transition framework (D1 §6.3, §12.1). No code outside this directory
// writes to the store. A transition runs inside one immediate transaction:
// it checks the current rows, performs its writes, and appends its events,
// all of which commit together or not at all.

import type { Database } from 'better-sqlite3';

import { nowIso } from '../../clock.js';
import { newId } from '../../ids.js';
import { beforeEventWrite } from '../../testing/seam.js';

import type { EventType } from './event-types.js';
import { addCommittedTickRequests, recordTickRequests } from './tick-requests.js';

export type { EventType };

export type ActorKind = 'engine' | 'human' | 'run';

export interface Actor {
  actor_kind: ActorKind;
  actor_id: string | null;
  request_id: string | null;
  // D7 (DECISIONS item 57, the owner's ruling of 2026-11-26: "An agent
  // acting on my instruction must be distinguishable from my own GUI
  // click"): an owner request an agent sent on the owner's instruction, as
  // the caller stated it (the engine cannot authenticate the statement; it
  // records what is stated). Absent: the owner's own act.
  delegation?: Delegation | null;
}

export interface Delegation {
  performed_by: 'agent';
  agent: string;
  instructed_by: 'owner';
  instruction: string | null;
}

// Who performed what the actor did, as recorded on an approval, an answer
// and the receipt (D7): the owner, an agent on the owner's instruction, the
// engine, or a run.
export function delegationOf(actor: Actor): Record<string, unknown> {
  if (actor.actor_kind === 'human') {
    const d = actor.delegation;
    return d ? { performed_by: `agent:${d.agent}`, agent: d.agent, instructed_by: d.instructed_by, instruction: d.instruction } : { performed_by: 'owner' };
  }
  return { performed_by: actor.actor_kind === 'engine' ? 'engine' : `run:${actor.actor_id ?? 'unknown'}` };
}

export const ENGINE_ACTOR: Actor = { actor_kind: 'engine', actor_id: null, request_id: null };

export interface EventRef {
  id: string;
  seq: number;
  type: EventType;
}

export class Tx {
  readonly id = newId('tx_');
  readonly at = nowIso();
  readonly events: EventRef[] = [];
  // Fields every event of this transaction carries in its payload: the
  // label of a caller that installs test setup through the transitions.
  stamp: Record<string, unknown> = {};

  constructor(
    readonly db: Database,
    readonly actor: Actor,
  ) {
    // D7: every event of a delegated owner request names the delegation in
    // its payload (its actor_id is `agent:<name>`).
    if (actor.actor_kind === 'human' && actor.delegation) this.stamp = { delegation: delegationOf(actor) };
  }

  newId(prefix: string): string {
    return newId(prefix);
  }

  // The store order of a fact this transaction writes now (DECISIONS item
  // 51; migration 0052): the highest event seq so far. The fact follows
  // every event up to it and precedes every later one, so it is before an
  // event of seq E exactly when it is < E, whatever the wall clock said.
  storeOrder(): number {
    return (this.db.prepare('SELECT COALESCE(MAX("seq"), 0) AS s FROM "events"').get() as { s: number }).s;
  }

  // Append one event in this transaction. seq is store-wide and strictly
  // increasing: the store has one writer connection and the transaction is
  // immediate, so MAX(seq) cannot move underneath it.
  emit(type: EventType, subject: Record<string, unknown>, payload: Record<string, unknown>): EventRef {
    beforeEventWrite(type);
    const { n } = this.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "events"').get() as { n: number };
    const ref: EventRef = { id: newId('ev_'), seq: n, type };
    this.db
      .prepare(
        `INSERT INTO "events" ("id", "created_at", "seq", "at", "type", "subject", "actor_kind", "actor_id", "request_id", "payload", "tx")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref.id,
        this.at,
        ref.seq,
        this.at,
        type,
        JSON.stringify(subject),
        this.actor.actor_kind,
        this.actor.actor_id,
        this.actor.request_id,
        JSON.stringify({ ...this.stamp, ...payload }),
        this.id,
      );
    this.events.push(ref);
    return ref;
  }
}

// Checks every transaction runs before its commit, registered by the store
// worker (store/transitions/awaiting.ts: no item awaits nothing).
const afterTransition: ((tx: Tx) => void)[] = [];
export function registerAfterTransition(fn: (tx: Tx) => void): void {
  if (!afterTransition.includes(fn)) afterTransition.push(fn);
}

export function transact<T>(db: Database, actor: Actor, fn: (tx: Tx) => T): T {
  let requested = 0;
  const value = db
    .transaction(() => {
      const tx = new Tx(db, actor);
      const out = fn(tx);
      for (const check of afterTransition) check(tx);
      // D6 K1: the ticks this transition requests, in its own transaction.
      requested = recordTickRequests(tx);
      return out;
    })
    .immediate();
  if (requested > 0) addCommittedTickRequests(requested);
  return value;
}

// An operation's finalization in the store order (DECISIONS item 51;
// migration 0052): the seq of its `operation.finalized` event, written in
// the transaction that finalizes it.
export function finalizedInOrder(tx: Tx, operation: string, event: EventRef): void {
  tx.db.prepare('UPDATE "operations" SET "finalized_seq" = ? WHERE "id" = ?').run(event.seq, operation);
}
