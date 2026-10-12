// A session turn's context package (D6 §2.2; D2 §1.3): the role's task and
// prohibitions, the session's transcript so far (the durable record, never
// the provider's state), the engine's notes on the last save, the permitted
// paths and the result schema of B.7. Written by the engine before the turn
// is launched; the workspace itself holds the role's artifact (D6 §2.5).
// Pure but for the files it writes.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Claim } from '../store/transitions/runs.js';

export interface SessionContextFacts {
  run: string;
  project: string;
  role: string;
  turn: number;
  paths: readonly string[];
  // null: the transcript record cannot be read; the package says so.
  transcript: { turn: number; speaker: string; at: string; text: string }[] | null;
  findings: { code: string; path: string | null; subject: Record<string, unknown>; message: string }[];
  // The approved inputs the role reads by their bindings (D6 §3.5; B02): the
  // Spec Writer the accepted idea record, the Architect the approved
  // specification; never a newer checkpoint of the same file.
  approved: { name: string; blob: string; what: string }[];
}

const TASK: Record<string, string> = {
  vision: 'You are the Vision role in a conversation with the project owner. Help the owner clarify the idea, then rewrite `.surety/idea.md` into the project identity: the idea brief\'s sections, closing with one fenced block whose info string is `yaml surety-identity` holding exactly the keys name, one_line, users, non_goals, success_measures, sensitive_areas, tier_recommendation and environments.',
  spec_writer:
    'You are the Spec Writer role in a conversation with the project owner. Turn the accepted idea record into `.surety/spec/spec.md` in the specification template\'s exact shape: the header, one `### R<n>. <title>` subsection per requirement with its statement, `**Sensitive areas:**` line and criteria `- R<n>.<m> ...`, and the section 5 index table that agrees with section 4. You may not approve your own specification.',
  architect:
    'You are the Architect role in a conversation with the project owner. From the approved specification write the architecture, the module map (`.surety/architecture/modules.json`), the ADRs (`.surety/adrs/ADR-<nnn>.md`), the roadmap (`.surety/roadmap/roadmap.json`, every approved requirement in exactly one phase) and the next phase\'s plan (`.surety/phases/phase-<n>.json`). You may not approve your own proposals.',
};

// B.7: the turn's result (beside §68's status and summary).
export const TURN_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: "A session turn's result, written to /surety/out/result.json",
  type: 'object',
  required: ['status', 'summary', 'reply', 'artifact_changed'],
  properties: {
    status: { const: 'completed' },
    summary: { type: 'string' },
    reply: { type: 'string', description: 'What you say to the owner.' },
    artifact_changed: { type: 'boolean', description: 'Whether you changed a file of your permitted paths this turn.' },
    questions_for_owner: { type: 'array', items: { type: 'string' } },
    done: { type: 'boolean', description: 'true proposes closing the session; the owner closes it.' },
  },
  additionalProperties: false,
};

// `texts`: each approved input's text by blob, read from git by the caller;
// a blob that could not be read is said to be unknown in the package.
export function writeSessionPackage(dir: string, claim: Claim, facts: SessionContextFacts, texts: Map<string, string | null> = new Map()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: { path: string; kind: string; source: string | null; sha256: string }[] = [];
  const put = (path: string, kind: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, path), content);
    files.push({ path, kind, source: null, sha256: createHash('sha256').update(content).digest('hex') });
  };
  const last = facts.transcript === null ? undefined : facts.transcript.filter((e) => e.speaker === 'owner').at(-1);
  put(
    'prompt.md',
    'prompt',
    [
      `# Your task (${facts.role}, turn ${facts.turn})`,
      '',
      TASK[facts.role] ?? 'Answer the owner.',
      '',
      `Session run ${facts.run}; project ${facts.project}.`,
      '',
      '## The owner says',
      '',
      facts.transcript === null ? "(the session's transcript cannot be read: what the owner said is unknown)" : (last?.text ?? '(nothing yet)'),
      '',
      ...(facts.findings.length > 0 ? ['## What the engine found at the last save', '', ...facts.findings.map((f) => `- ${f.code}${f.path ? ` (${f.path})` : ''}: ${f.message}`), ''] : []),
      ...(facts.approved.length > 0 ? [`The approved inputs you work from are in approved/: ${facts.approved.map((a) => `${a.name} (${a.what})`).join(', ')}. The checkout may hold a newer draft; these are what was approved.`, ''] : []),
      'The whole conversation so far is in transcript.json. Read instructions.md first.',
      '',
    ].join('\n'),
  );
  put(
    'instructions.md',
    'instructions',
    [
      '# Instructions',
      '',
      `- Write only under ${facts.paths.join(', ')}. Anything else is refused when the owner saves.`,
      '- Never write code, checks or the project policy.',
      '- The engine commits; you do not run git.',
      '- Your result follows result-schema.json: reply to the owner, and say whether you changed your artifact.',
      '',
    ].join('\n'),
  );
  put('transcript.json', 'transcript', `${JSON.stringify(facts.transcript === null ? { unknown: 'the transcript record cannot be read' } : facts.transcript, null, 2)}\n`);
  put('notes.json', 'instructions', `${JSON.stringify({ findings: facts.findings }, null, 2)}\n`);
  for (const a of facts.approved) {
    const text = texts.get(a.blob) ?? null;
    put(`approved/${a.name}`, 'approved', text ?? `The ${a.what} (blob ${a.blob}) could not be read; it is unknown to this package.\n`);
  }
  put('result-schema.json', 'result_schema', `${JSON.stringify(TURN_RESULT_SCHEMA, null, 2)}\n`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ work_item: null, run: claim.run, role: facts.role, kind: 'session', turn: facts.turn, files }, null, 2)}\n`);
}
