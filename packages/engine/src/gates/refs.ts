// The gate's own reads of its registered refs (D3 §5 X1; Q4, N02; A.2
// RefRead; SEAM.md §193), the part that judges what was read. A ref read is
// one of three things: a value, a verified absence, or an unsuccessful read.
// Only a value or an absence the registry cannot account for is a change; an
// unsuccessful read is never one, and is never taken for "unchanged".
//
// The registry's generation is read before and after git: a value either
// generation expects, or one the engine's own unfinished journaled update is
// moving the ref to, is the engine's own write, never out of band.

import type { RefRead } from '../git/repo.js';
import type { RefFact } from '../store/transitions/gates.js';

export interface RegistryGeneration {
  registry: string;
  ref: string;
  expected: string;
  moving: string[];
}

export interface RefJudgement {
  fact: RefFact;
  // Set when what was read is a change the registry cannot account for.
  change: { registry: string; expected: string; found: string | null } | null;
}

// `found`: the registered refs as read (git/repo.ts readRefs: a value, a
// verified absence, or unknown), or null when git could not list them.
export function judgeRefs(before: RegistryGeneration[], after: RegistryGeneration[], found: Map<string, RefRead> | null): RefJudgement[] {
  const out: RefJudgement[] = [];
  for (const now of after) {
    const read = found?.get(now.ref) ?? { state: 'unknown' as const };
    if (read.state === 'unknown') {
      out.push({ fact: { ref: now.ref, read: 'unread', oid: null }, change: null });
      continue;
    }
    const oid = read.state === 'ok' ? read.oid : null;
    const fact: RefFact = oid === null ? { ref: now.ref, read: 'absent', oid: null } : { ref: now.ref, read: 'value', oid };
    const then = before.find((b) => b.registry === now.registry);
    const accounted = oid !== null && [now.expected, ...now.moving, ...(then ? [then.expected, ...then.moving] : [])].includes(oid);
    out.push({ fact, change: accounted ? null : { registry: now.registry, expected: now.expected, found: oid } });
  }
  return out;
}

// Every ref unread: the registry's generation never held still across a
// read, so what was read cannot be judged against one (N02).
export const allUnread = (after: RegistryGeneration[]): RefJudgement[] => after.map((r) => ({ fact: { ref: r.ref, read: 'unread', oid: null }, change: null }));

// Did the registry's generation of these refs change between two reads?
export function sameGeneration(a: RegistryGeneration[], b: RegistryGeneration[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x) => {
    const y = b.find((z) => z.registry === x.registry);
    return y !== undefined && y.expected === x.expected && y.moving.length === x.moving.length && y.moving.every((m) => x.moving.includes(m));
  });
}
