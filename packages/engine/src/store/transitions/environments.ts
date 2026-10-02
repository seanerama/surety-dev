// An environment's current observation (D1 §3.5, D1-28; SEAM.md §91). M1 has
// no observation job: the only writer is the transition below, which the
// seam's observation fixture calls with its label. The stored observation is
// what was observed, with its own time and source; nothing that reads it
// rewrites it.

import { notFound } from './common.js';
import type { Tx } from './tx.js';

export const OBSERVED_CONDITIONS = ['healthy', 'degraded', 'down', 'unknown'] as const;
export type ObservedCondition = (typeof OBSERVED_CONDITIONS)[number];

export interface ObservationInput {
  project: string;
  environment: string;
  condition: ObservedCondition;
  observed_at: string;
  source: string;
}

export function recordObservation(tx: Tx, args: ObservationInput, label: Record<string, unknown>): { environment: { id: string; observed: Record<string, unknown> } } {
  const env = tx.db.prepare('SELECT "id", "project" FROM "environments" WHERE "id" = ?').get(args.environment) as { id: string; project: string } | undefined;
  if (!env || env.project !== args.project) throw notFound('environment', args.environment);
  const observed = { condition: args.condition, detail: null, observed_at: args.observed_at, source: args.source };
  const text = JSON.stringify(observed);
  const existing = tx.db.prepare('SELECT "id" FROM "environment_records" WHERE "environment" = ?').get(args.environment) as { id: string } | undefined;
  if (existing) {
    tx.db.prepare('UPDATE "environment_records" SET "observed" = ? WHERE "id" = ?').run(text, existing.id);
  } else {
    tx.db
      .prepare('INSERT INTO "environment_records" ("id", "created_at", "project", "environment", "observed") VALUES (?, ?, ?, ?, ?)')
      .run(tx.newId('envr_'), tx.at, args.project, args.environment, text);
  }
  tx.emit('environment.observed', { project: args.project, environment: args.environment }, { ...label, condition: args.condition, observed_at: args.observed_at, source: args.source });
  return { environment: { id: args.environment, observed } };
}
