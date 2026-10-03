// The flows that write the trust table and raise the two decisions about it
// (D2 §§4.1, 7.2, K10): an attempt proposed with its qualification_approval;
// an attempt that succeeded writing its entry proposed with its
// trust_activation. The same functions serve the harness fixtures, which
// stand for what a real attempt would have established (M2 plan §2.3).

import { raiseQuestion } from './queue.js';
import {
  type AttemptInput,
  type AttemptRow,
  type EntryInput,
  type EntryRow,
  entryProject,
  finishAttempt,
  getAttempt,
  writeAttempt,
  writeEntry,
} from './trust.js';
import type { Tx } from './tx.js';

// An attempt is proposed and its approval asked for; nothing runs until a
// person authorizes it (Q7).
export function proposeAttempt(tx: Tx, input: AttemptInput, label: Record<string, unknown> = {}): { attempt: AttemptRow; decision: string | null } {
  const attempt = writeAttempt(tx, input, label);
  const d = raiseQuestion(tx, { project: attempt.fixture_project, kind: 'qualification_approval', subjectType: 'qualification_attempt', subjectId: attempt.id });
  return { attempt, decision: d?.id ?? null };
}

// A trust entry is written proposed and its activation asked for (D2 §4.1).
// An entry whose canaries observed no usage is written and never asked
// about: it cannot be activated (D2 §4.2).
export function proposeEntry(tx: Tx, input: EntryInput, label: Record<string, unknown> = {}): { entry: EntryRow; decision: string | null } {
  const entry = writeEntry(tx, input, label);
  const d = raiseQuestion(tx, { project: entryProject(tx.db, entry), kind: 'trust_activation', subjectType: 'trust_entry', subjectId: entry.id });
  return { entry, decision: d?.id ?? null };
}

// A running attempt whose canaries all passed writes its entry (D2 §7.2); one
// whose canary failed ends `failed` with nothing written.
export function concludeAttempt(
  tx: Tx,
  args: { attempt: string; canaries: { kind: string; run: string | null; passed: boolean; failure_class?: string; provider_error?: string | null }[]; unexpected_contacts?: unknown[]; entry?: EntryInput },
  label: Record<string, unknown> = {},
): { status: 'succeeded' | 'failed'; entry: string | null; decision: string | null } {
  const a = getAttempt(tx.db, args.attempt)!;
  const passed = args.canaries.length === 3 && args.canaries.every((c) => c.passed);
  if (!passed || !args.entry) {
    finishAttempt(tx, a, { outcome: 'failed', canaries: args.canaries, unexpected_contacts: args.unexpected_contacts ?? [] });
    return { status: 'failed', entry: null, decision: null };
  }
  const { entry, decision } = proposeEntry(tx, { ...args.entry, qualification_attempt: a.id }, label);
  finishAttempt(tx, a, { outcome: 'succeeded', canaries: args.canaries, unexpected_contacts: args.unexpected_contacts ?? [], trust_entry: entry.id });
  return { status: 'succeeded', entry: entry.id, decision };
}
