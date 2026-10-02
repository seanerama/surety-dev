// The transition framework (D1 §6.3, §12.1). No code outside this directory
// writes to the store. A transition runs inside one immediate transaction:
// it checks the current rows, performs its writes, and appends its events,
// all of which commit together or not at all.

import type { Database } from 'better-sqlite3';

import { nowIso } from '../../clock.js';
import { newId } from '../../ids.js';
import { beforeEventWrite } from '../../testing/seam.js';

// The A.6 event types emitted so far. Later slices add theirs.
export type EventType =
  | 'engine.started'
  | 'engine.mode_changed'
  | 'engine.tick'
  | 'engine.quarantine'
  | 'api.act'
  | 'project.created'
  | 'project.paused'
  | 'project.resumed'
  | 'work.created'
  | 'work.claimed'
  | 'work.advanced'
  | 'work.integrated'
  | 'work.complete'
  | 'work.held'
  | 'work.resumed'
  | 'work.parked'
  | 'work.cancelled'
  | 'run.created'
  | 'run.claimed'
  | 'run.started'
  | 'run.heartbeat'
  | 'run.validating'
  | 'run.finalizing'
  | 'run.ended'
  | 'run.quarantined'
  | 'domain.terminated'
  | 'domain.quarantined'
  | 'decision.raised'
  | 'decision.answered'
  | 'decision.consumed'
  | 'decision.invalidated'
  | 'operation.intended'
  | 'operation.succeeded'
  | 'operation.failed'
  | 'operation.ambiguous'
  | 'operation.finalized'
  | 'git.journal_intended'
  | 'git.journal_applied'
  | 'git.journal_confirmed'
  | 'git.journal_ambiguous'
  | 'git.journal_finalized'
  | 'invocation.receipt'
  | 'invocation.status'
  | 'invocation.usage'
  | 'ledger.row';

export type ActorKind = 'engine' | 'human' | 'run';

export interface Actor {
  actor_kind: ActorKind;
  actor_id: string | null;
  request_id: string | null;
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

  constructor(
    readonly db: Database,
    readonly actor: Actor,
  ) {}

  newId(prefix: string): string {
    return newId(prefix);
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
        JSON.stringify(payload),
        this.id,
      );
    this.events.push(ref);
    return ref;
  }
}

export function transact<T>(db: Database, actor: Actor, fn: (tx: Tx) => T): T {
  return db.transaction(() => fn(new Tx(db, actor))).immediate();
}
