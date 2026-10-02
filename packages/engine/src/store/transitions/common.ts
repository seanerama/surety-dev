// Helpers shared by the transition functions: per-project sequence numbers,
// canonical hashing, and the refusals every transition uses.

import { createHash } from 'node:crypto';

import { Refusal } from '../../refusal.js';
import type { Tx } from './tx.js';

// Tables whose rows carry a per-project human number (D1 §2.2).
export type SequencedTable = 'work_items' | 'runs' | 'operations' | 'decisions';

// The next `seq` for a project. `projects.seq_counters` is the source (D1
// §2.2); a number is never reused, also when a row was written another way.
export function nextSeq(tx: Tx, project: string, table: SequencedTable): number {
  const row = tx.db.prepare('SELECT "seq_counters" FROM "projects" WHERE "id" = ?').get(project) as { seq_counters: string } | undefined;
  if (!row) throw notFound('project', project);
  const counters = JSON.parse(row.seq_counters) as Record<string, number>;
  const { n } = tx.db.prepare(`SELECT COALESCE(MAX("seq"), 0) AS n FROM "${table}" WHERE "project" = ?`).get(project) as { n: number };
  const next = Math.max((counters[table] ?? 0) + 1, n + 1);
  counters[table] = next;
  tx.db.prepare('UPDATE "projects" SET "seq_counters" = ? WHERE "id" = ?').run(JSON.stringify(counters), project);
  return next;
}

// JSON with object keys sorted, so equal values hash equally.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function notFound(what: string, id: string): Refusal {
  return new Refusal(404, 'not_found', `No ${what} "${id}" exists here.`, `Check the ${what} id and the project in the path.`, { [what]: id });
}

export function illegal(what: string, detail: Record<string, unknown>): Refusal {
  return new Refusal(409, 'illegal_transition', `${what} is not a legal transition.`, 'Nothing was changed. Read the current state and choose a transition it allows.', detail);
}

export const parseJson = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));
