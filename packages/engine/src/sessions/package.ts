// A session turn's context package (D6 §2.2; D2 §1.3): the role's task and
// prohibitions, the session's transcript so far (the durable record, never
// the provider's state), the engine's notes on the last save, the permitted
// paths and the result schema of B.7. Written by the engine before the turn
// is launched; the workspace itself holds the role's artifact (D6 §2.5).
// Pure but for the files it writes.

import { within } from '../design/paths.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Claim } from '../store/transitions/runs.js';
import { canaryPromptText } from '../trust/canaries.js';
import { type PackageName, type ReadsElement, architectElements, readsIds, readsText, specElements, statedElements } from '../packages/reads.js';
import { designerTurnResultSchema } from '../packages/design-reads.js';

// The role's artifact as the session's workspace holds it before the turn
// (D6 §2.2: "the current state of the role's artifact"), read by the main
// thread (sessions/turn-package.ts).
export interface ArtifactState {
  files: { path: string; text: string }[];
  omitted: { path: string; why: string }[];
  // Why the state cannot be read at all, or null.
  unknown: string | null;
}

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
  // `text`: an input the engine gives as it holds it, not a blob.
  approved: { name: string; blob: string; what: string; text?: string }[];
  // D6 §8.2: an adopted project's sessions run in retrofit mode.
  retrofit?: { pinned_revision: string; mode: string | null; paths: string[]; total: number | { unknown: string } } | null;
  // The Architect's: what its plan must name in `prepared_against`
  // (plan/bundle.ts preparedAgainstFacts); null when it cannot be read.
  prepared_against?: import('../plan/bundle.js').PreparedAgainstFacts | null;
}

// D6 §8.2 (K10; B10; SEAM.md §381): retrofit mode, a package variant, not a
// role. Description before prescription; the repository is the input.
const RETROFIT: Record<string, string[]> = {
  spec_writer: [
    '## Retrofit mode: this project was adopted from an existing repository',
    '',
    'Describe before you prescribe. The repository\'s code is your input: read it, and write the specification of what it does today and what the owner says it should do.',
    "- Give each requirement its Origin in the index: whether the code does it today, or the owner says it should and the code does not. Origin is your claim; it confirms nothing.",
    '- Fill the claims table: one row per claim the README, the documentation or the comments make, what the code was observed to do, and the requirement that records it.',
    '- In full mode every behaviour gets a requirement with criteria. In scoped mode write criteria only for the modules the owner names for the first changes; give the others the descriptive mark and no criteria.',
    '- Every requirement you produce is recorded reverse_engineered; the owner answers confirm, defect or withdraw for each. You cannot confirm one, and no label you write removes one from the owner\'s confirmation.',
    '- Existing tests, CI files and documentation are inputs you describe, never evidence. Never change the code, its tests or checks.',
  ],
  architect: [
    '## Retrofit mode: this project was adopted from an existing repository',
    '',
    'Reconstruct the architecture as it is from the code, which is your input.',
    '- The module map covers the whole project and classifies every module\'s sensitive areas (write `[]` for none), in either mode.',
    '- ADRs reconstructed from the code carry `reconstructed: true` in their front matter.',
    '- The roadmap\'s phase 1 is the conformance phase: the confirmed requirements, carried unchanged through the protected acceptance path to Alpha. Later phases hold the intended changes and the confirmed defects.',
    '- `phase-1.json` has exactly one stage with `conformance: true`, no tasks, implementing the confirmed requirements the roadmap assigns to phase 1 and never a defect; no source changes in phase 1.',
    '- Under a design policy other than off, an interface a `ui` module consumes states its `request`, `response` and `errors`; where the code does not let you shape one, write `"shape": "unknown"` in their place (D7 §12). The engine lists it shape unknown and derives nothing from it; never invent a shape.',
  ],
};

const TASK: Record<string, string> = {
  vision: 'You are the Vision role in a conversation with the project owner. Help the owner clarify the idea, then rewrite `.surety/idea.md` into the project identity: the idea brief\'s sections, closing with one fenced block whose info string is `yaml surety-identity` holding exactly the keys name, one_line, users, non_goals, success_measures, sensitive_areas, tier_recommendation and environments.',
  spec_writer:
    'You are the Spec Writer role in a conversation with the project owner. Turn the accepted idea record into `.surety/spec/spec.md`, in exactly the forms the engine reads (below). You may not approve your own specification.',
  designer:
    "You are the Designer role in a conversation with the project owner. From the interface inventory, draw the design of the product's user interface under `.surety/design/` (design.json, tokens.json, flows.json, screens.json, navigation.json, criteria.json, the mockups and the asset manifest), in exactly the forms the engine reads (below). The inventory and its fixtures are the engine's: read them, never change them. You may not approve your own design.",
  architect:
    'You are the Architect role in a conversation with the project owner. From the approved specification write the architecture (`.surety/architecture/architecture.md`, prose), the module map, the ADRs, the roadmap and the next phase\'s plan, in exactly the forms the engine reads (below). You may not approve your own proposals.',
};

// What the turn's package states of what the engine reads from the role's
// product (row M442; src/packages/reads.ts): the Spec Writer's and the
// Architect's, each with its retrofit variant; Vision's identity block is
// in its task.
export function sessionReads(facts: Pick<SessionContextFacts, 'role' | 'retrofit' | 'prepared_against'>): { pkg: PackageName | null; elements: ReadsElement[] } {
  const retrofit = facts.retrofit !== null && facts.retrofit !== undefined;
  if (facts.role === 'spec_writer') {
    const pkg: PackageName = retrofit ? 'spec_writer_retrofit' : 'spec_writer';
    return { pkg, elements: statedElements(pkg, specElements({ retrofit })) };
  }
  if (facts.role === 'architect') {
    const pkg: PackageName = retrofit ? 'architect_retrofit' : 'architect';
    return { pkg, elements: statedElements(pkg, architectElements({ retrofit, prepared_against: facts.prepared_against ?? null, kind: 'session' })) };
  }
  return { pkg: null, elements: [] };
}

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
export function writeSessionPackage(
  dir: string,
  claim: Claim,
  facts: SessionContextFacts,
  texts: Map<string, string | null> = new Map(),
  artifact: ArtifactState | null = null,
  canary: Record<string, unknown> | null = null,
  // A Designer session's design files and what its package states of what
  // the engine reads (D7 §3.4, §10.2; design/package.ts).
  design: { files: { path: string; content: Buffer }[]; prompt: string[]; reads?: { pkg: PackageName; elements: ReadsElement[] } } | null = null,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: { path: string; kind: string; source: string | null; sha256: string }[] = [];
  const put = (path: string, kind: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, path), content);
    files.push({ path, kind, source: null, sha256: createHash('sha256').update(content).digest('hex') });
  };
  const last = facts.transcript === null ? undefined : facts.transcript.filter((e) => e.speaker === 'owner').at(-1);
  const reads: { pkg: PackageName | null; elements: ReadsElement[] } = canary ? { pkg: null, elements: [] } : (design?.reads ?? sessionReads(facts));
  put(
    'prompt.md',
    'prompt',
    [
      `# Your task (${facts.role}, turn ${facts.turn})`,
      '',
      TASK[facts.role] ?? 'Answer the owner.',
      '',
      ...(facts.retrofit && RETROFIT[facts.role]
        ? [
            ...RETROFIT[facts.role]!,
            '',
            `The adoption baseline revision A is ${facts.retrofit.pinned_revision}; the adoption mode is ${facts.retrofit.mode ?? 'not chosen yet (unknown)'}.`,
            `The repository's tracked files at A (${typeof facts.retrofit.total === 'number' ? `${facts.retrofit.total} in all` : `count unknown: ${facts.retrofit.total.unknown}`}${typeof facts.retrofit.total === 'number' && facts.retrofit.total > facts.retrofit.paths.length ? `, the first ${facts.retrofit.paths.length} listed` : ''}):`,
            '',
            ...facts.retrofit.paths.map((p) => `- ${p}`),
            '',
          ]
        : []),
      `Session run ${facts.run}; project ${facts.project}.`,
      '',
      '## The owner says',
      '',
      facts.transcript === null ? "(the session's transcript cannot be read: what the owner said is unknown)" : (last?.text ?? '(nothing yet)'),
      '',
      ...(facts.findings.length > 0 ? ['## What the engine found at the last save', '', ...facts.findings.map((f) => `- ${f.code}${f.path ? ` (${f.path})` : ''}: ${f.message}`), ''] : []),
      ...(facts.approved.length > 0 ? [`The approved inputs you work from are in approved/: ${facts.approved.map((a) => `${a.name} (${a.what})`).join(', ')}. The checkout may hold a newer draft; these are what was approved.`, ''] : []),
      'The whole conversation so far is in transcript.json, and your artifact as it stands now is under artifact/ (artifact.json lists it). Read instructions.md first.',
      '',
      ...(reads.elements.length > 0 ? [...readsText(reads.elements).slice(1), ''] : []),
      ...(canary ? canaryPromptText(canary) : []),
      ...(design ? design.prompt : []),
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
    const text = a.text ?? texts.get(a.blob) ?? null;
    put(`approved/${a.name}`, 'approved', text ?? `The ${a.what} (blob ${a.blob}) could not be read; it is unknown to this package.\n`);
  }
  // The artifact's current state (D6 §2.2; M416 (f)): each file of the
  // role's paths as the workspace holds it; what was left out, by name.
  const art = artifact ?? { files: [], omitted: [], unknown: 'not read for this package' };
  for (const f of art.files) put(`artifact/${f.path}`, 'artifact', f.text);
  put('artifact.json', 'artifact', `${JSON.stringify({ files: art.files.map((f) => f.path), omitted: art.omitted, ...(art.unknown ? { unknown: art.unknown } : {}) }, null, 2)}\n`);
  if (canary) put('canary.json', 'instructions', `${JSON.stringify(canary, null, 2)}\n`);
  for (const f of design?.files ?? []) {
    // Confirmed inside the package (the slice-40 review's B1).
    if (!f.path.startsWith('design/') || within(dir, f.path) === null) throw new Error(`the design file ${JSON.stringify(f.path)} would be written outside the context package`);
    mkdirSync(dirname(join(dir, f.path)), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, f.path), f.content);
    files.push({ path: f.path, kind: 'design', source: null, sha256: createHash('sha256').update(f.content).digest('hex') });
  }
  // A Designer's turn result carries its findings (B.12).
  put('result-schema.json', 'result_schema', `${JSON.stringify(facts.role === 'designer' ? designerTurnResultSchema(TURN_RESULT_SCHEMA) : TURN_RESULT_SCHEMA, null, 2)}\n`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ work_item: null, run: claim.run, role: facts.role, kind: 'session', turn: facts.turn, files, ...(reads.pkg ? { package: reads.pkg, reads: readsIds(reads.elements) } : {}) }, null, 2)}\n`);
}
