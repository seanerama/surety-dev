// The scoped context package (D2 §1.3; F §§3.10.8, 4.1; SEAM.md §139):
// written by the engine into the domain's area before the launcher starts,
// and mounted read-only at /surety/context. It holds the role's prompt (for a
// stage's work, the stage's goal verbatim: task text reaches the role here,
// never in an argument, D1 §17 item 3) and instructions with its
// prohibitions, the result's schema and path, and what the work item binds:
// one file per requirement the stage implements, the phase plan, the
// interfaces of the stage's modules; for a Reviewer the candidate's
// acceptance content hash; for a resumed run the prior run's context rebuilt
// from its records, never from its package. Never a raw user report (E5).
// `manifest.json` lists every file with its kind and what it was made from;
// the package holds exactly those files. The `probe` profile adds the
// engine's probe program at /surety/context/probe (D2 §§2.8, 7.2).
//
// The package scopes the initial context and hides nothing the role may
// inspect: the workspace and the repository's objects stay readable.

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Claim } from '../../store/transitions/runs.js';

export const PROBE_PROGRAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes', 'program.js');

export type ContextFacts = {
  run: { id: string; role: string; base_revision: string; content_hash: string | null };
  work_item: { id: string; kind: string; subject: string; project: string };
  stage: Record<string, unknown> | null;
  requirements: { id: string; key: string; text_ref: string; assigned_phase: number | null }[];
  modules: { id: string; name: string; paths: unknown }[];
  phase_plan: Record<string, unknown> | null;
  candidate: { id: string; revision: string; acceptance_content_hash: string | null } | null;
  resumed: { run: string; outcome: unknown; reason_class: unknown; summary: unknown; records: { id: string; kind: string; path: string | null }[] } | null;
};

export type ContextKind = 'prompt' | 'instructions' | 'result_schema' | 'requirement' | 'adr' | 'constraint' | 'phase_plan' | 'interface' | 'diff' | 'acceptance_content_hash' | 'prior_run';

// What every role is told, and what it may not do (F §4.1).
const PROHIBITIONS = [
  'Work only in /surety/workspace; it is the only place your changes are kept.',
  'Do not commit, tag, push or change any git reference: the engine makes every commit.',
  'Do not try to reach the engine, its home, other workspaces or the network beyond your egress proxy.',
  'Write your structured result as JSON to /surety/out/result.json before you exit.',
];

const ROLE_TASK: Record<string, string> = {
  builder: 'Build what the stage below asks for, within the requirements it names.',
  verifier: 'Verify the work below against its requirements, and report findings.',
  reviewer: 'Review the candidate named below at the acceptance content hash it names, and report findings.',
  architect: 'Plan or replan the work below.',
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

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'item';

// `readRecord` gives a record's bytes by its id (for a resumed run's prior
// context); null if they cannot be read.
export function writeContextPackage(dir: string, claim: Claim, facts: ContextFacts | null, opts: { probe: boolean; readRecord?: (id: string) => Buffer | null }): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: { path: string; kind: ContextKind; source: string | null; sha256: string }[] = [];
  const put = (path: string, kind: ContextKind, source: string | null, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, path), content);
    files.push({ path, kind, source, sha256: createHash('sha256').update(content).digest('hex') });
  };
  const role = claim.role;
  const goal = typeof facts?.stage?.goal === 'string' ? facts.stage.goal : null;
  const prompt = [
    `# Your task (${role})`,
    '',
    ROLE_TASK[role] ?? 'Do the work the work item below names.',
    '',
    `Work item: ${claim.work_item} (${claim.work_kind}); run ${claim.run}; base revision ${claim.base_revision}.`,
    ...(goal !== null ? ['', '## The stage', '', `Stage ${String(facts?.stage?.number ?? '')}: ${goal}`] : []),
    ...(facts?.candidate ? ['', '## The candidate', '', `Candidate ${facts.candidate.id} at revision ${facts.candidate.revision}.`] : []),
    '',
    'Read /surety/context/manifest.json for every file this package holds, and /surety/context/instructions.md first.',
    '',
  ].join('\n');
  put('prompt.md', 'prompt', null, prompt);
  put('instructions.md', 'instructions', null, ['# Instructions', '', ...PROHIBITIONS.map((p) => `- ${p}`), '', 'The result must follow /surety/context/result-schema.json.', ''].join('\n'));
  put('result-schema.json', 'result_schema', null, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`);
  for (const r of facts?.requirements ?? []) put(`requirements/${safeName(r.key)}.json`, 'requirement', r.id, `${JSON.stringify({ key: r.key, text_ref: r.text_ref, assigned_phase: r.assigned_phase }, null, 2)}\n`);
  if (facts?.phase_plan) put('phase-plan.json', 'phase_plan', String(facts.phase_plan.id ?? '') || null, `${JSON.stringify(facts.phase_plan, null, 2)}\n`);
  for (const m of facts?.modules ?? []) put(`interfaces/${safeName(m.name)}.json`, 'interface', m.id, `${JSON.stringify({ module: m.name, paths: m.paths }, null, 2)}\n`);
  if (facts?.candidate && facts.candidate.acceptance_content_hash) put('acceptance-content-hash.txt', 'acceptance_content_hash', facts.candidate.id, `${facts.candidate.acceptance_content_hash}\n`);
  if (facts?.resumed) {
    // Rebuilt from the prior run's records (D1 §15.3), one file per record.
    const r = facts.resumed;
    for (const rec of r.records) {
      const bytes = opts.readRecord?.(rec.id) ?? null;
      put(
        `prior-run/${safeName(rec.id)}.json`,
        'prior_run',
        rec.id,
        `${JSON.stringify({ run: r.run, outcome: r.outcome, reason_class: r.reason_class, summary: r.summary, record: rec.id, kind: rec.kind, content: bytes === null ? null : bytes.toString('utf8').slice(0, 64 * 1024) }, null, 2)}\n`,
      );
    }
    if (r.records.length === 0) put('prior-run/run.json', 'prior_run', null, `${JSON.stringify({ run: r.run, outcome: r.outcome, reason_class: r.reason_class, summary: r.summary }, null, 2)}\n`);
  }
  if (opts.probe) {
    copyFileSync(PROBE_PROGRAM, join(dir, 'probe'));
    chmodSync(join(dir, 'probe'), 0o555);
    files.push({ path: 'probe', kind: 'instructions', source: null, sha256: createHash('sha256').update(readFileSync(join(dir, 'probe'))).digest('hex') });
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ work_item: claim.work_item, run: claim.run, role, kind: claim.work_kind, files }, null, 2)}\n`);
}
