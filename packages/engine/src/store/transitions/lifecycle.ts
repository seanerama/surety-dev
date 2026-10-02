// The legal state changes of runs, execution domains and deployment
// authorizations, held as data (D1 A.5; build spec §6 corrections 4, 12 and
// 13; Review B17). Every transition function that changes one of these
// states checks the change against its table, and the executable contract
// (contract/) states these tables as they are.

import { illegal } from './common.js';

type Edge = readonly [string, string];

export const LIFECYCLES: Readonly<Record<'RunState' | 'DomainStatus' | 'AuthorizationStatus', readonly Edge[]>> = {
  RunState: [
    ['created', 'claimed'],
    ['claimed', 'executing'],
    ['claimed', 'finalizing'],
    ['executing', 'validating'],
    ['executing', 'finalizing'],
    ['validating', 'finalizing'],
    ['validating', 'proposal_captured'],
    ['proposal_captured', 'finalizing'],
    ['finalizing', 'finalizing'],
    ['finalizing', 'ended'],
    // Correction 12: recovery, Stop or Abandon can end a run still `created`.
    ['created', 'finalizing'],
  ],
  DomainStatus: [
    ['allocated', 'launched'],
    ['allocated', 'terminated'],
    ['allocated', 'quarantined'],
    ['launched', 'terminated'],
    ['launched', 'quarantined'],
    // Correction 13: a quarantine ends on observed termination, and on
    // nothing else (correction 2).
    ['quarantined', 'terminated'],
  ],
  AuthorizationStatus: [
    // Correction 4: created proposed, issued by a satisfied evaluation.
    ['proposed', 'issued'],
    ['proposed', 'superseded'],
    ['issued', 'consumed'],
    ['issued', 'superseded'],
    ['consumed', 'superseded'],
  ],
};

export type Lifecycle = keyof typeof LIFECYCLES;

// Throws `illegal_transition` unless from → to is in the table.
export function assertEdge(lifecycle: Lifecycle, from: string, to: string, subject: Record<string, unknown>): void {
  if (LIFECYCLES[lifecycle].some(([a, b]) => a === from && b === to)) return;
  throw illegal(`${lifecycle} ${from} → ${to}`, subject);
}
