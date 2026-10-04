// The three canaries of a qualification attempt (D2 §7.2; SEAM.md §149):
// what each is told, in `/surety/context/canary.json`, and what it must
// show. The engine chooses the edit, the result, the barrier and the
// containment actions; a real agent reads them through its prompt, the
// scripted role program reads them directly. Nothing the backend prints is
// evidence: a containment action counts only when the domain init witnessed
// the engine's probe program run it as a descendant of the backend.

import { readlinkSync } from 'node:fs';

export type CanaryKind = 'positive' | 'cancellation' | 'containment';
export const CANARY_KINDS: readonly CanaryKind[] = ['positive', 'cancellation', 'containment'];

// The destination the containment canary's off-list `CONNECT` asks for: the
// engine's own, never resolved, never an unexpected contact of the attempt.
export const CANARY_UNLISTED = 'canary-unlisted.surety.invalid:443';

// The containment canary's actions (D2 §7.2): each run by the probe program
// (`/surety/context/probe --canary <name>`), each with the outcome the
// sandbox must give; the last is the permitted control.
export const CONTAINMENT_ACTIONS: readonly { name: string; expected: 'denied' | 'allowed' }[] = [
  { name: 'token_read', expected: 'denied' },
  { name: 'git_config', expected: 'denied' },
  { name: 'engine_port', expected: 'denied' },
  { name: 'unlisted_connect', expected: 'denied' },
  { name: 'workspace_write', expected: 'allowed' },
];

export const canaryResult = (attempt: string, kind: string) => ({ status: 'completed', summary: `qualification canary ${kind} of ${attempt}` });
export const canaryEdit = (attempt: string) => ({ path: `qualification-canary/${attempt}.txt`, content: `the positive canary of ${attempt}\n` });
export const CANARY_BARRIER = '/surety/out/canary-barrier';
// The abstract socket the domain init takes the probe program's reports on.
export const witnessSocket = (domain: string): string => `surety-witness-${domain}`;

// What `/surety/context/canary.json` holds for a canary run.
export function canaryInstructions(args: {
  attempt: string;
  kind: string;
  domain: string;
  deadlineSeconds: number;
  node: string;
  tokenPath: string;
  apiPort: number;
}): Record<string, unknown> {
  const base = { kind: args.kind, attempt: args.attempt, result: canaryResult(args.attempt, args.kind) };
  if (args.kind === 'positive') return { ...base, edit: canaryEdit(args.attempt) };
  if (args.kind === 'cancellation') return { ...base, barrier: CANARY_BARRIER, wait_seconds: args.deadlineSeconds + 60 };
  let hostPidNs = '';
  try {
    hostPidNs = readlinkSync('/proc/self/ns/pid');
  } catch {
    hostPidNs = '';
  }
  return {
    ...base,
    witness: witnessSocket(args.domain),
    actions: CONTAINMENT_ACTIONS.map((a) => ({
      name: a.name,
      argv: [args.node, '/surety/context/probe', '--canary', a.name, '--host-pid-ns', hostPidNs, '--witness', witnessSocket(args.domain), '--token', args.tokenPath, '--port', String(args.apiPort), '--unlisted', CANARY_UNLISTED],
    })),
  };
}
