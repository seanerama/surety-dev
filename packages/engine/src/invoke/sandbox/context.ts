// The scoped context package (D2 §1.3; F §§3.10.8, 4.1): written by the
// engine into the domain's area before the launcher starts, and mounted
// read-only at /surety/context. It holds the role's prompt and instructions
// with its prohibitions, the result's schema and path, and what the work item
// binds (its subject, the stage's requirements, phase plan and module
// interfaces; for a Reviewer the candidate and the acceptance content hash it
// reviews; for a resumed run what the records say of the run it resumes),
// and never a raw user report (E5). Task content reaches the role here, never
// in an argument (D1 §17 item 3). The `probe` profile adds the engine's probe
// program at /surety/context/probe (D2 §§2.8, 7.2).
//
// The package scopes the initial context and hides nothing the role may
// inspect: the workspace and the repository's objects stay readable.

import { copyFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Claim } from '../../store/transitions/runs.js';

export const PROBE_PROGRAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes', 'program.js');

export type ContextFacts = {
  run: { id: string; role: string; base_revision: string; content_hash: string | null };
  work_item: { id: string; kind: string; subject: string; project: string };
  stage: Record<string, unknown> | null;
  requirements: unknown[];
  modules: unknown[];
  phase_plan: Record<string, unknown> | null;
  candidate: { id: string; revision: string; acceptance_content_hash: string | null } | null;
  resumed: { run: string; outcome: unknown; summary: unknown } | null;
};

// What every role is told, and what it may not do (F §4.1).
const PROHIBITIONS = [
  'Work only in /surety/workspace; it is the only place your changes are kept.',
  'Do not commit, tag, push or change any git reference: the engine makes every commit.',
  'Do not try to reach the engine, its home, other workspaces or the network beyond your egress proxy.',
  'Write your structured result as JSON to /surety/out/result.json before you exit.',
];

const ROLE_TASK: Record<string, string> = {
  builder: 'Build what the stage in work.json asks for, within the requirements it names.',
  verifier: 'Verify the stage or candidate in work.json against its requirements, and report findings.',
  reviewer: 'Review the candidate in work.json at the acceptance content hash it names, and report findings.',
  architect: 'Plan or replan the work in work.json.',
};

export const RESULT_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { const: 'completed' },
    summary: { type: 'string' },
    checkpoint: { type: 'boolean' },
    nominate: { type: 'boolean' },
  },
  additionalProperties: true,
};

export function writeContextPackage(dir: string, claim: Claim, facts: ContextFacts | null, opts: { probe: boolean }): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const role = claim.role;
  const prompt = [
    `# Your task (${role})`,
    '',
    ROLE_TASK[role] ?? 'Do the work the work item in work.json names.',
    '',
    'Read /surety/context/work.json and /surety/context/instructions.md first.',
    '',
  ].join('\n');
  const instructions = ['# Instructions', '', ...PROHIBITIONS.map((p) => `- ${p}`), '', 'The result must follow /surety/context/result-schema.json.', ''].join('\n');
  writeFileSync(join(dir, 'prompt.md'), prompt);
  writeFileSync(join(dir, 'instructions.md'), instructions);
  writeFileSync(join(dir, 'result-schema.json'), `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`);
  writeFileSync(
    join(dir, 'invocation.json'),
    `${JSON.stringify({ invocation: claim.invocation, run: claim.run, work_item: claim.work_item, work_kind: claim.work_kind, role: claim.role }, null, 2)}\n`,
  );
  const work = {
    run: claim.run,
    role,
    work_item: facts ? { id: facts.work_item.id, kind: facts.work_item.kind, subject: facts.work_item.subject } : { id: claim.work_item, kind: claim.work_kind, subject: null },
    base_revision: claim.base_revision,
    result_path: '/surety/out/result.json',
    stage: facts?.stage ?? null,
    requirements: facts?.requirements ?? [],
    modules: facts?.modules ?? [],
    phase_plan: facts?.phase_plan ?? null,
    ...(facts?.candidate ? { candidate: facts.candidate } : {}),
    ...(facts?.resumed ? { resumes: facts.resumed } : {}),
  };
  writeFileSync(join(dir, 'work.json'), `${JSON.stringify(work, null, 2)}\n`);
  if (opts.probe) {
    copyFileSync(PROBE_PROGRAM, join(dir, 'probe'));
    chmodSync(join(dir, 'probe'), 0o555);
  }
}
