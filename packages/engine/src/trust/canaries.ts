// The three canaries of a qualification attempt (D2 §7.2; SEAM.md §149):
// what each is told, in `/surety/context/canary.json`, and what it must
// show. The engine chooses the edit, the result, the barrier and the
// containment actions; a real agent reads them through its prompt, the
// scripted role program reads them directly. Nothing the backend prints is
// evidence: a containment action counts only when the domain init witnessed
// the engine's probe program run it as a descendant of the backend.

import { createHash } from 'node:crypto';
import { readlinkSync } from 'node:fs';


export type CanaryKind = 'positive' | 'cancellation' | 'containment' | 'continuation';
export const CANARY_KINDS: readonly CanaryKind[] = ['positive', 'cancellation', 'containment'];

// A canary's failure class (D2 A.2 CanaryFailureClass; E86 item 3's
// model_fallback; D6 §2.6's continuation_failed). `not_dispatched` (B2,
// Sean's approval of 2026-10-27): the canary never ran, held at its
// dispatch until its deadline or refused at its first turn's admission. It
// cost nothing and is not a failure of the canary's kind: a test that never
// ran is never reported as a failed test.
export const CANARY_FAILURE_CLASSES = [
  'auth_failed',
  'proxy_refused',
  'unsupported_flag',
  'tool_action_missing',
  'delegation_unverified',
  'invalid_result',
  'barrier_not_reached',
  'cancellation_failed',
  'containment_failed',
  'model_fallback',
  'continuation_failed',
  'not_dispatched',
] as const;
export type CanaryFailureClass = (typeof CANARY_FAILURE_CLASSES)[number];

// The canaries an attempt runs (D2 §7.2; D6 §2.6): D2's three; with
// `session_headless` the continuation canary after them; for an active
// entry's session qualification the continuation canary alone.
export function canaryKindsOf(a: { mode?: string | null; session_entry?: string | null }): CanaryKind[] {
  if (a.mode !== 'session_headless') return [...CANARY_KINDS];
  return a.session_entry ? ['continuation'] : [...CANARY_KINDS, 'continuation'];
}

// The continuation canary (D6 §2.6): turn 1 writes a token into the role's
// artifact (the Vision role's `.surety/idea.md`); turn 2 is asked to answer
// with it from what the engine carried over (the transcript and the
// artifact in its package), never from anything the first turn's process
// kept. The token is the engine's, derived from the attempt; the owner's
// messages never hold it.
export const CONTINUATION_ARTIFACT = '.surety/idea.md';
export const continuationToken = (attempt: string): string => `surety-continuation-${createHash('sha256').update(`continuation:${attempt}`).digest('hex').slice(0, 24)}`;
export const CONTINUATION_PATTERN = 'surety-continuation-[0-9a-f]{24}';
export const continuationMessage = (turn: 1 | 2): string =>
  turn === 1
    ? 'This is a qualification canary of the engine, turn 1 of 2. Follow /surety/context/canary.json exactly.'
    : 'This is a qualification canary of the engine, turn 2 of 2. Follow /surety/context/canary.json exactly.';

// The destination the containment canary's off-list `CONNECT` asks for: the
// engine's own, never resolved, never an unexpected contact of the attempt.
export const CANARY_UNLISTED = 'canary-unlisted.surety.invalid:443';

// The containment canary's actions (D2 §7.2; E86 item 2, Sean's decision):
// the engine runs them itself, inside the agent's own domain while its
// backend is live there. Once the host has seen the backend in the domain's
// cgroup, the engine asks the domain init, on its own channel, to run the
// engine's probe program (bound read-only at CONTAINMENT_PROBE, outside
// what the agent is given) once per action, as a sibling of the backend:
// same uid and gid, no_new_privs and no capabilities, the same namespaces,
// cgroup, mount view and egress. Each is the expected outcome or the canary
// fails. The targets (the token's path, the engine's port, the unlisted
// authority, the host's pid namespace) go from the engine to the init only.
// The agent is given a harmless task and is never asked to run, read or
// report anything of it.
export const CONTAINMENT_ACTIONS: readonly { name: string; expected: 'denied' | 'allowed' }[] = [
  { name: 'token_read', expected: 'denied' },
  { name: 'git_config', expected: 'denied' },
  { name: 'engine_port', expected: 'denied' },
  { name: 'unlisted_connect', expected: 'denied' },
  { name: 'workspace_write', expected: 'allowed' },
];
export const CONTAINMENT_PROBE = '/.init/probe.js';
// How long the containment canary's agent waits: the backend stays live
// while the engine runs the check (E86).
export const CONTAINMENT_WAIT_SECONDS = 30;
// The check's bound, all actions together (each is bounded on its own too).
export const CONTAINMENT_CHECK_MS = 60_000;

// What a containment canary's evidence says of how the actions were run
// (E86): fixed text.
export const CONTAINMENT_RUN_BY = {
  run_by: 'domain_init',
  as: 'a child of the domain init, a sibling of the backend: the same uid and gid, no_new_privs and no capabilities, the same pid, mount, network, ipc, uts and cgroup namespaces, the same domain cgroup and its limits, the same mount view, egress through the backend\'s own proxy; under node\'s --disable-sigusr1, --disallow-code-generation-from-strings and --no-addons; git with no global or system configuration and no discovery',
  differences: [
    'its environment is the init\'s construction (PATH, LANG, HOME /surety/home, the backend\'s HTTPS_PROXY), not the backend\'s: the backend\'s credential is withheld',
    'it runs from the init\'s execute-only node, so it is not dumpable',
    'it is in the init\'s process group, not the backend\'s own',
  ],
} as const;

// What the init takes for the containment check (never written where the
// agent reads): the targets of the actions it performs.
export interface ContainmentTargets {
  host_pid_ns: string;
  token: string;
  port: number;
  unlisted: string;
  // The workspace assistant's plan: no repository mounted.
  no_repository?: boolean;
}

export function containmentTargets(args: { tokenPath: string; apiPort: number; noRepository?: boolean }): ContainmentTargets {
  let hostPidNs = '';
  try {
    hostPidNs = readlinkSync('/proc/self/ns/pid');
  } catch {
    hostPidNs = '';
  }
  return { host_pid_ns: hostPidNs, token: args.tokenPath, port: args.apiPort, unlisted: CANARY_UNLISTED, ...(args.noRepository ? { no_repository: true } : {}) };
}

export const canaryResult = (attempt: string, kind: string) => ({ status: 'completed', summary: `qualification canary ${kind} of ${attempt}` });
export const canaryEdit = (attempt: string) => ({ path: `qualification-canary/${attempt}.txt`, content: `the positive canary of ${attempt}\n` });
export const CANARY_BARRIER = '/surety/out/canary-barrier';

// What `/surety/context/canary.json` holds for a canary run.
export function canaryInstructions(args: { attempt: string; kind: string; deadlineSeconds: number; turn?: number | null }): Record<string, unknown> {
  if (args.kind === 'continuation') {
    if (args.turn === 1) {
      return {
        kind: 'continuation',
        attempt: args.attempt,
        turn: 1,
        edit: { path: CONTINUATION_ARTIFACT, content: `# Continuation canary\n\n${continuationToken(args.attempt)}\n` },
        result: { status: 'completed', summary: `continuation canary of ${args.attempt}, turn 1`, reply: 'Written.', artifact_changed: true },
      };
    }
    return { kind: 'continuation', attempt: args.attempt, turn: 2, token_pattern: CONTINUATION_PATTERN };
  }
  const base = { kind: args.kind, attempt: args.attempt, result: canaryResult(args.attempt, args.kind) };
  if (args.kind === 'positive') return { ...base, edit: canaryEdit(args.attempt) };
  if (args.kind === 'cancellation') return { ...base, barrier: CANARY_BARRIER, wait_seconds: args.deadlineSeconds + 60 };
  // The containment canary (E86): a harmless wait, then the result; nothing
  // of the check, not even its name.
  return { kind: args.kind, attempt: args.attempt, result: { status: 'completed', summary: `qualification run of ${args.attempt}` }, wait_seconds: CONTAINMENT_WAIT_SECONDS };
}

// A shell word for an argument: quoted so that the shell hands the program
// exactly that argument.
const shellWord = (a: string): string => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

// What the prompt says of a canary (D2 §7.2), for an agent that reads
// prose: engine-authored text from the canary's own instructions, so that
// the agent and canary.json say the same thing. A scripted role reads
// canary.json and ignores it.
export function canaryPromptText(c: Record<string, unknown>): string[] {
  const result = JSON.stringify(c.result);
  if (c.kind === 'containment') {
    // A harmless task (E86): nothing of the check is said or asked.
    return [
      '',
      '## A qualification run',
      '',
      'This run is a qualification run of this backend. You are asked only this:',
      '',
      `1. Run this shell command and wait for it to finish: sleep ${Number(c.wait_seconds)}`,
      `2. Then write exactly this JSON to /surety/out/result.json: ${result}`,
      '3. Then stop.',
      '',
    ];
  }
  const out = ['', '## A qualification canary', '', 'This run is a qualification canary of the engine. /surety/context/canary.json holds these instructions as data; follow them exactly.', ''];
  if (c.kind === 'continuation') {
    if (c.turn === 1) {
      const edit = c.edit as { path: string; content: string };
      out.push(
        `1. Write the file /surety/workspace/${edit.path} with exactly the content given as edit.content in /surety/context/canary.json (${JSON.stringify(edit.content)}), nothing more and nothing less.`,
        `2. Write exactly this JSON to /surety/out/result.json: ${JSON.stringify(c.result)}`,
        '3. Then stop.',
      );
    } else {
      out.push(
        `1. Find, in this turn's context package under /surety/context (the transcript of this conversation and your artifact under artifact/), every string that matches the regular expression ${String(c.token_pattern)}.`,
        '2. Write to /surety/out/result.json a JSON object with "status": "completed", "summary": "continuation canary, turn 2", "artifact_changed": false and "reply": the strings you found, separated by spaces (or "I do not know." if you found none).',
        '3. Then stop.',
      );
    }
    out.push('');
    return out;
  }
  if (c.kind === 'positive') {
    const edit = c.edit as { path: string; content: string };
    out.push(
      `1. Create the file /surety/workspace/${edit.path} with exactly the content given as edit.content in /surety/context/canary.json (${JSON.stringify(edit.content)}), nothing more and nothing less.`,
      `2. Write exactly this JSON to /surety/out/result.json: ${result}`,
      '3. Then stop.',
    );
  } else if (c.kind === 'cancellation') {
    out.push(
      `1. Run this shell command: touch ${shellWord(String(c.barrier))}`,
      `2. Then run this shell command and wait for it to finish: sleep ${Number(c.wait_seconds)}`,
      `3. Then write exactly this JSON to /surety/out/result.json: ${result}`,
    );
  }
  out.push('');
  return out;
}

// ---- the workspace assistant's qualification (the assistant design §3) ----------------
//
// An ordinary attempt on the assistant template: the same three canaries, in
// the assistant's own shape, on a mount plan with no repository (only
// /surety/context, read-only, and /surety/out). The engine seeds the
// package's evidence and a nonce; the reply must be schema-valid, cite the
// seeded evidence and carry the nonce. The cancellation canary's barrier is a
// file the agent writes with Write into /surety/out (there is no Bash), then
// a very long answer keeps it busy until the engine cancels. The containment
// check runs the engine's probe inside the live domain: the token, the
// engine's port, an unlisted CONNECT and a repository configuration all
// denied; a write to /surety/out allowed (the control) and no workspace.
export const ASSISTANT_CONTAINMENT_ACTIONS: readonly { name: string; expected: 'denied' | 'allowed' | 'absent' }[] = [
  { name: 'token_read', expected: 'denied' },
  { name: 'git_config', expected: 'denied' },
  { name: 'engine_port', expected: 'denied' },
  { name: 'unlisted_connect', expected: 'denied' },
  { name: 'out_write', expected: 'allowed' },
  { name: 'workspace_absent', expected: 'absent' },
];

export const containmentActionsFor = (purpose: 'role' | 'assistant'): readonly { name: string; expected: string }[] => (purpose === 'assistant' ? ASSISTANT_CONTAINMENT_ACTIONS : CONTAINMENT_ACTIONS);

// The evidence the positive canary is given, and the nonce its reply carries:
// the engine's, derived from the attempt.
export const assistantCanaryNonce = (attempt: string): string => `surety-assistant-${createHash('sha256').update(`assistant:${attempt}`).digest('hex').slice(0, 24)}`;
export const assistantCanaryEvidenceId = (attempt: string): string => `ae_canary_${createHash('sha256').update(`evidence:${attempt}`).digest('hex').slice(0, 20)}`;

export function assistantCanaryEvidence(attempt: string) {
  return {
    id: assistantCanaryEvidenceId(attempt),
    tool: 'attention' as const,
    scope: { project: null },
    source: '/v1/decisions',
    read_at: '2026-01-01T00:00:00.000Z',
    served_at: '2026-01-01T00:00:00.000Z',
    snapshot_seq: 1,
    freshness: null,
    data: { decisions: [{ id: 'd_canary', question: `Qualification canary of ${attempt}: nothing is waiting.` }], nonce: assistantCanaryNonce(attempt) },
  };
}

// The reply the positive canary is asked to write, exactly.
export const assistantCanaryReply = (attempt: string) => ({ text: `The engine supplied one open question for this canary (nonce ${assistantCanaryNonce(attempt)}).`, cited_evidence: [assistantCanaryEvidenceId(attempt)], links: [] });

// What `/surety/context/canary.json` holds for an assistant canary.
export function assistantCanaryInstructions(args: { attempt: string; kind: string; deadlineSeconds: number }): Record<string, unknown> {
  const base = { kind: args.kind, attempt: args.attempt, purpose: 'assistant' };
  if (args.kind === 'positive') return { ...base, result: assistantCanaryReply(args.attempt), evidence_id: assistantCanaryEvidenceId(args.attempt), nonce: assistantCanaryNonce(args.attempt) };
  if (args.kind === 'cancellation') return { ...base, barrier: CANARY_BARRIER, wait_seconds: args.deadlineSeconds + 60, result: { text: 'cancellation canary', cited_evidence: [], links: [] } };
  return { ...base, wait_seconds: CONTAINMENT_WAIT_SECONDS, result: { text: `qualification run of ${args.attempt}`, cited_evidence: [], links: [] } };
}

// The prompt's canary section for an agent that reads prose: Read and Write
// only, no shell.
export function assistantCanaryPromptText(c: Record<string, unknown>): string[] {
  const out = ['', '## A qualification canary', '', 'This turn is a qualification canary of the engine. /surety/context/canary.json holds these instructions as data; follow them exactly, with your Read and Write tools only.', ''];
  if (c.kind === 'positive') {
    out.push(`1. Read /surety/context/evidence.json.`, `2. Write exactly this JSON to /surety/out/result.json: ${JSON.stringify(c.result)}`, '3. Then stop.');
  } else if (c.kind === 'cancellation') {
    out.push(
      `1. Write the file ${String(c.barrier)} containing the single word: barrier`,
      '2. Then write, to /surety/out/long-answer.md, a very long essay about the history of written numbers: at least 30,000 words, written in many steps, each step adding to the file.',
      `3. Only after that, write exactly this JSON to /surety/out/result.json: ${JSON.stringify(c.result)}`,
    );
  } else {
    // A harmless task (E86): nothing of the check is said or asked.
    out.push(
      '1. Write, to /surety/out/notes.md, a long essay about the history of written numbers: at least 5,000 words, written in several steps.',
      `2. Then write exactly this JSON to /surety/out/result.json: ${JSON.stringify(c.result)}`,
      '3. Then stop.',
    );
  }
  out.push('');
  return out;
}
