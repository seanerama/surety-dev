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
import { canaryPromptText } from '../../trust/canaries.js';

export const PROBE_PROGRAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes', 'program.js');

export type ContextFacts = {
  run: { id: string; role: string; base_revision: string; content_hash: string | null };
  work_item: { id: string; kind: string; subject: string; project: string };
  stage: Record<string, unknown> | null;
  requirements: { id: string; key: string; text_ref: string; assigned_phase: number | null; text?: string | null }[];
  adrs?: { id: string; key: string; text: string }[];
  constraints?: { id: string; key: string; text: string }[];
  modules: { id: string; name: string; paths: unknown }[];
  phase_plan: Record<string, unknown> | null;
  candidate: { id: string; revision: string; acceptance_content_hash: string | null } | null;
  review?: {
    findings: FindingFacts[];
    assessments: { id: string; finding: string; candidate: string; reason: string; status: string }[];
    signoffs: { role: string; scope: string; module?: string }[];
    diff_base: { revision: string | null; from: string | null };
  } | null;
  finding?: FindingFacts | null;
  // The project's checks (E87), for a Verifier, a Reviewer and a fix Builder.
  checks?: { key: string; requirements: string[]; criteria?: string[]; gate_kinds: string[]; required: boolean }[] | null;
  // false: no effective protected version, so the checks cannot be read.
  checks_known?: boolean | null;
  // The effective version's check keys and the registered index's criteria,
  // what a result may name (D3 §2.11, §5 X2); null where none can be read.
  check_keys?: string[] | null;
  criteria?: string[] | null;
  resumed: { run: string; outcome: unknown; reason_class: unknown; summary: unknown; records: { id: string; kind: string; path: string | null }[] } | null;
};

export type FindingFacts = {
  id: string;
  seq: number;
  scope: string;
  candidate: string | null;
  category: string;
  severity: string;
  message: string;
  check: string | null;
  criterion?: string | null;
  sensitive_area: string | null;
  status: string;
  disposition: string | null;
  source_role: string | null;
};

// The candidate's diff as the engine could take it (D2 §1.3): from `base` to
// the candidate's revision. `state` says what the patch is: the whole diff,
// its first bytes, only its file summary, or nothing, with why.
export type CandidateDiff = { base: string | null; base_from: string | null; revision: string; state: 'complete' | 'truncated' | 'stat_only' | 'unavailable'; text: string; detail: string | null };

export type ContextKind =
  | 'prompt'
  | 'instructions'
  | 'result_schema'
  | 'requirement'
  | 'adr'
  | 'constraint'
  | 'phase_plan'
  | 'interface'
  | 'diff'
  | 'acceptance_content_hash'
  | 'prior_run'
  // A failed repair check's output record (D3 §2.10; SEAM.md §229).
  | 'check_output';

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

// The result's schema, per role (D2 §1.3; SEAM.md §68): every field the
// engine reads from that role's result, each in the form the engine takes,
// with what the engine does with it. A field of another role's is not
// listed: the engine records nothing of it, and an Alpha exception proposal
// from any role but the Reviewer makes the result invalid.
const SEVERITY = { enum: ['critical', 'high', 'medium', 'low'] };
const FINDING_ID = { type: 'string', pattern: '^fnd_', description: 'A finding id, as listed in /surety/context/findings.json.' };
const FIELDS: Record<string, Record<string, unknown>> = {
  status: { const: 'completed' },
  summary: { type: 'string', description: 'What you did, in a few sentences.' },
  checkpoint: { type: 'boolean', description: 'true asks the engine to commit your workspace as a checkpoint and continue the work in a new run.' },
  nominate: { type: 'boolean', description: 'true asks the engine to nominate the result as a candidate (honoured at tier T1 only; otherwise the engine nominates on its own cadence).' },
  findings: {
    type: 'array',
    description: 'Each defect or conflict you found in the candidate. The engine records each as an open finding of the candidate. Do not repeat a finding already listed in /surety/context/findings.json; change its severity instead.',
    items: {
      type: 'object',
      required: ['category', 'severity', 'message'],
      properties: {
        category: { enum: ['defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene'] },
        severity: SEVERITY,
        message: { type: 'string', description: 'What is wrong and where, so a Builder can fix it.' },
        scope: { enum: ['candidate', 'lineage', 'project'], description: 'Default candidate.' },
        sensitive_area: { type: 'string' },
        check: {
          type: 'string',
          description: 'The key of the check whose passing shows the finding fixed. Required for the finding to be resolved by a fix; one of the keys listed in the prompt.',
        },
        criterion: {
          type: 'string',
          description:
            "The criterion of the requirement index the finding breaks (R<n>.<m>). Required for the finding to be resolved by a fix: it is resolved only when its `check` is a required acceptance check covering this criterion and passes after the disposition.",
        },
      },
    },
  },
  objections: {
    type: 'array',
    description:
      'Only when a protected check contradicts the requirement or the interface the work names: your objection to it. The check stays in force; if it fails, the engine does not send you back but asks the human owner to correct the check, change the spec, retry or cancel.',
    items: {
      type: 'object',
      required: ['check', 'category', 'message'],
      properties: {
        check: { type: 'string', description: 'The key of the check you object to.' },
        criterion: { type: 'string', description: 'The criterion of the requirement index the conflict is about, if one.' },
        category: { enum: ['contract_conflict', 'requirement_conflict'] },
        message: { type: 'string', description: 'What contradicts what, and where.' },
      },
    },
  },
  severity_changes: {
    type: 'array',
    description: 'A new severity for a listed finding.',
    items: { type: 'object', required: ['finding', 'to'], properties: { finding: FINDING_ID, to: SEVERITY } },
  },
};
const VERIFIER_FIELDS: Record<string, Record<string, unknown>> = {
  severity_changes: { ...FIELDS.severity_changes, description: 'A higher severity for a listed finding. A Verifier may raise a severity, never lower one.' },
  applicability: {
    type: 'array',
    description: 'A proposal that a listed finding does not apply to a candidate, with your reason and evidence. A Reviewer assesses it.',
    items: {
      type: 'object',
      required: ['finding', 'candidate', 'reason', 'evidence'],
      properties: { finding: FINDING_ID, candidate: { type: 'string', description: 'The candidate id.' }, reason: { type: 'string' }, evidence: { type: 'string', description: 'Published as an evidence record.' } },
    },
  },
  proposal: {
    type: 'object',
    description: 'Only when you changed protected files (the checks): the rationale of that change, which the engine captures as a proposal. Any change outside them rejects the run whole.',
    required: ['rationale', 'requested_change_kind'],
    properties: { rationale: { type: 'string' }, requested_change_kind: { enum: ['tightening', 'loosening', 'unclassifiable'] } },
  },
};
const REVIEWER_FIELDS: Record<string, Record<string, unknown>> = {
  signoffs: {
    type: 'array',
    description: 'Your sign-off of the candidate, bound to the acceptance content hash you reviewed. /surety/context/review.json lists the sign-offs the project\'s tier requires.',
    items: { type: 'object', required: ['scope'], properties: { scope: { enum: ['candidate', 'module', 'security'] }, module: { type: 'string', description: 'The module, for scope module.' } } },
  },
  dispositions: {
    type: 'array',
    description:
      'What is to be done about each open finding listed in /surety/context/findings.json. fix: the engine registers fix work for it. defer: taken on your authority only for a Low finding with linked_issue and defer_target; otherwise, like accept, it is a proposal the human owner decides.',
    items: {
      type: 'object',
      required: ['finding', 'disposition'],
      properties: {
        finding: FINDING_ID,
        disposition: { enum: ['fix', 'defer', 'accept'] },
        linked_issue: { type: 'string' },
        defer_target: { type: 'string', format: 'date-time' },
      },
    },
  },
  severity_changes: {
    ...FIELDS.severity_changes,
    description: 'A new severity for a listed finding. Raising applies; lowering a Critical finding, or a High one out of the blocking range, is a proposal the human owner decides.',
  },
  assessments: {
    type: 'array',
    description: 'Your verdict on an applicability assessment listed in /surety/context/review.json, proposed by a Verifier.',
    items: { type: 'object', required: ['assessment', 'verdict'], properties: { assessment: { type: 'string' }, verdict: { enum: ['not_applicable', 'applicable'] } } },
  },
  proposal_approval: {
    type: 'object',
    description: 'Your recommendation to approve a captured protected-change proposal, by its id.',
    required: ['proposal', 'reason'],
    properties: { proposal: { type: 'string' }, reason: { type: 'string' } },
  },
  alpha_exception_proposals: {
    type: 'array',
    description: 'A proposal that a High finding be nonblocking at Alpha, with its containment argument and testing purpose. The human owner decides.',
    items: {
      type: 'object',
      required: ['finding', 'containment_text', 'testing_purpose', 'references'],
      properties: {
        finding: FINDING_ID,
        containment_text: { type: 'string' },
        testing_purpose: { type: 'string' },
        references: {
          type: 'array',
          items: { oneOf: [{ type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } }, additionalProperties: false }, { type: 'object', required: ['record'], properties: { record: { type: 'string', minLength: 1 } }, additionalProperties: false }] },
        },
      },
    },
  },
};

const ROLE_FIELDS: Record<string, Record<string, Record<string, unknown>>> = {
  builder: { checkpoint: FIELDS.checkpoint!, nominate: FIELDS.nominate!, objections: FIELDS.objections! },
  architect: { checkpoint: FIELDS.checkpoint! },
  verifier: { findings: FIELDS.findings!, ...VERIFIER_FIELDS },
  reviewer: { findings: FIELDS.findings!, ...REVIEWER_FIELDS },
};

// `checkKeys` (the review of b72b9cc, F1): the keys a finding's `check` may
// name, the effective protected version's; given, `check` is an enum of
// them, and with none (no checks, or none readable) it is left out. The
// same for `criteria`, the registered index's (D3 §2.11), and a finding's
// `criterion`; and for a Builder's objections, whose `check` and
// `criterion` take the same enums.
export function resultSchema(role: string, checkKeys?: readonly string[], criteria?: readonly string[]): Record<string, unknown> {
  const fields: Record<string, Record<string, unknown>> = { ...(ROLE_FIELDS[role] ?? {}) };
  const narrow = (field: string) => {
    if (!fields[field]) return;
    const items = (fields[field].items ?? {}) as { properties?: Record<string, unknown> };
    const props: Record<string, unknown> = { ...(items.properties ?? {}) };
    if (checkKeys !== undefined) {
      if (checkKeys.length > 0) props.check = { ...(props.check as Record<string, unknown>), enum: [...checkKeys] };
      else if (field === 'findings') delete props.check;
    }
    if (criteria !== undefined) {
      if (criteria.length > 0) props.criterion = { ...(props.criterion as Record<string, unknown>), enum: [...criteria] };
      else delete props.criterion;
    }
    fields[field] = { ...fields[field], items: { ...items, properties: props } };
  };
  narrow('findings');
  narrow('objections');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `The ${role}'s result, written to /surety/out/result.json`,
    type: 'object',
    required: ['status', 'summary'],
    properties: { status: FIELDS.status, summary: FIELDS.summary, ...fields },
    additionalProperties: false,
  };
}

// A qualification canary's result (D2 §7.2): status and summary. Nothing of
// the containment check is asked of the agent (E86).
export function canaryResultSchema(_kind: string): Record<string, unknown> {
  return { ...resultSchema('canary'), title: "The canary's result, written to /surety/out/result.json" };
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'item';

// `readRecord` gives a record's bytes by its id (for a resumed run's prior
// context); null if they cannot be read.
export function writeContextPackage(
  dir: string,
  claim: Claim,
  facts: ContextFacts | null,
  opts: { probe: boolean; readRecord?: (id: string) => Buffer | null; canary?: Record<string, unknown> | null; diff?: CandidateDiff | null },
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: { path: string; kind: ContextKind; source: string | null; sha256: string }[] = [];
  const put = (path: string, kind: ContextKind, source: string | null, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, path), content);
    files.push({ path, kind, source, sha256: createHash('sha256').update(content).digest('hex') });
  };
  const role = claim.role;
  const goal = typeof facts?.stage?.goal === 'string' ? facts.stage.goal : null;
  // What a Verifier or a Reviewer reports against, and what a fix Builder
  // fixes (D2 §1.3): named in the prompt, given whole in the files.
  const review = facts?.candidate && facts.review ? facts.review : null;
  // The project's checks by key (E87), never their content.
  const checks = facts?.checks ?? null;
  const checkList =
    checks === null
      ? []
      : facts?.checks_known === false
        ? ["The project's checks could not be read: it has no effective protected version. No finding can name a check until it has one."]
        : checks.length === 0
          ? ['The project has no checks in its effective protected version, so no finding can name one.']
        : [
            "The project's checks:",
            ...checks.map(
              (c) =>
                `- \`${c.key}\`${c.required ? ' (required)' : ''}: covers ${c.requirements.length > 0 ? c.requirements.join(', ') : 'no requirement'}${
                  (c.criteria ?? []).length > 0 ? ` (criteria ${(c.criteria ?? []).join(', ')})` : ''
                }; gate kinds ${c.gate_kinds.length > 0 ? c.gate_kinds.join(', ') : 'none'}.`,
            ),
          ];
  const open = review ? review.findings.filter((f) => f.status === 'open') : [];
  const diff = review && role === 'reviewer' ? (opts.diff ?? null) : null;
  const DIFF_STATE: Record<CandidateDiff['state'], string> = {
    complete: 'the whole diff',
    truncated: 'the diff\'s first part only: it was too large to give whole; read the rest from the repository',
    stat_only: 'only the diff\'s file summary: the diff could not be taken whole; read it from the repository',
    unavailable: 'no diff: it could not be taken',
  };
  const reviewText = review
    ? [
        '',
        '## What you report on',
        '',
        ...(diff
          ? [
              `- /surety/context/candidate.diff: the candidate's changes, from ${diff.base ?? '(no base: the engine has no earlier revision of this project)'}${diff.base_from ? ` (${diff.base_from.replace(/_/g, ' ')})` : ''} to ${diff.revision}; ${DIFF_STATE[diff.state]}${diff.detail ? ` (${diff.detail})` : ''}.`,
            ]
          : []),
        `- /surety/context/findings.json: the ${review.findings.length} finding(s) that apply to this candidate, ${open.length} of them open, each by the id your result names it by.${
          open.length > 0 ? ` Open: ${open.map((f) => `${f.id} (${f.severity})`).join(', ')}.` : ''
        }`,
        ...(role === 'reviewer'
          ? [
              '- /surety/context/review.json: the sign-offs this project\'s tier requires, and the applicability assessments that await your verdict.',
              '',
              'Give every open finding a disposition in your result\'s `dispositions`: `fix` registers fix work for it; without a disposition the finding stays open and nothing is done about it. Record new findings in `findings`, and your sign-offs in `signoffs`.',
              "A fix is shown done, and the finding resolved, when the finding's `check` is a required acceptance check covering the finding's `criterion` and passes after your disposition. A finding with no check, or no criterion, cannot be resolved that way: if you raise one, name both.",
              '',
              ...checkList,
            ]
          : [
              '',
              "Record what you find in your result's `findings`; name a listed finding by its id.",
              "Name in each finding's `check` the key of the project's check whose passing shows it fixed (the check that covers the requirement it breaks), and in its `criterion` the criterion of the requirement index it breaks (R<n>.<m>, as listed with each check below). Without both, a fix of the finding can never be shown, and the finding stays open. If no check covers that criterion, report the finding anyway: the engine asks for the check to be corrected.",
              '',
              ...checkList,
            ]),
      ]
    : [];
  const fix = facts?.finding ?? null;
  const fixText = fix
    ? [
        '',
        '## The finding you fix',
        '',
        `Finding ${fix.id} (${fix.severity}, ${fix.category}${fix.check ? `; the check ${fix.check} shows it fixed` : ''}${fix.criterion ? `; it breaks the criterion ${fix.criterion}` : ''}):`,
        '',
        fix.message,
        '',
        'It is also in /surety/context/finding.json.',
        '',
        fix.check
          ? `It is resolved when the check \`${fix.check}\` passes on the candidate after your change: make it pass by fixing the code. The check is protected: do not change it.`
          : 'It names no check: describe in your summary what shows it fixed.',
        ...(checkList.length > 0 ? ['', ...checkList] : []),
      ]
    : [];
  // A repair run (D3 §2.10): the checks that failed on the item's current
  // candidate, each with its output in /surety/context/check-outputs/.
  const failedChecks = claim.check_outputs ?? [];
  const repairText =
    failedChecks.length > 0
      ? [
          '',
          '## The checks that failed',
          '',
          'Your last candidate failed these protected checks, and the engine sent the work back to you once to make them pass:',
          ...failedChecks.map((o) => `- \`${o.key}\`: its output is in /surety/context/check-outputs/${safeName(o.key)}.txt${o.output === null ? ' (it left no output record)' : ''}.`),
          '',
          'Fix the code, not the checks: they are protected. If a check contradicts the requirement or the interface, report it in your result\'s `objections`.',
        ]
      : [];
  const prompt = [
    `# Your task (${role})`,
    '',
    claim.attempt
      ? 'This run qualifies the backend you run as: the section below says what it asks, and asks nothing else.'
      : claim.work_kind === 'fix' && fix
        ? 'Fix the finding below.'
        : (ROLE_TASK[role] ?? 'Do the work the work item below names.'),
    '',
    `Work item: ${claim.work_item} (${claim.work_kind}); run ${claim.run}; base revision ${claim.base_revision}.`,
    ...(goal !== null ? ['', '## The stage', '', `Stage ${String(facts?.stage?.number ?? '')}: ${goal}`] : []),
    ...(facts?.candidate ? ['', '## The candidate', '', `Candidate ${facts.candidate.id} at revision ${facts.candidate.revision}.`] : []),
    ...reviewText,
    ...fixText,
    ...repairText,
    '',
    ...(claim.attempt ? (opts.canary ? canaryPromptText(opts.canary) : ['', '## A qualification canary', '', 'Follow /surety/context/canary.json exactly: it says what to do and what result to write.']) : []),
    'Read /surety/context/manifest.json for every file this package holds, and /surety/context/instructions.md first.',
    '',
  ].join('\n');
  put('prompt.md', 'prompt', null, prompt);
  put(
    'instructions.md',
    'instructions',
    null,
    [
      '# Instructions',
      '',
      ...PROHIBITIONS.map((p) => `- ${p}`),
      '',
      'The result must follow /surety/context/result-schema.json: the engine reads those fields and no other.',
      '',
    ].join('\n'),
  );
  const reports = role === 'verifier' || role === 'reviewer';
  const keys = facts?.checks && reports ? (facts.checks_known === false ? [] : [...new Set(facts.checks.map((c) => c.key))].sort()) : role === 'builder' && facts?.check_keys ? facts.check_keys : undefined;
  const criteria = (reports || role === 'builder') && facts && facts.criteria !== undefined ? (facts.criteria ?? []) : undefined;
  const schema = claim.attempt ? canaryResultSchema(String(opts.canary?.kind ?? claim.attempt.kind)) : resultSchema(role, keys, criteria);
  put('result-schema.json', 'result_schema', null, `${JSON.stringify(schema, null, 2)}\n`);
  if (review) {
    if (diff) put('candidate.diff', 'diff', facts!.candidate!.id, diff.text);
    put('findings.json', 'instructions', facts!.candidate!.id, `${JSON.stringify({ candidate: facts!.candidate!.id, findings: review.findings }, null, 2)}\n`);
    if (role === 'reviewer') {
      put(
        'review.json',
        'instructions',
        facts!.candidate!.id,
        `${JSON.stringify(
          {
            candidate: facts!.candidate!.id,
            revision: facts!.candidate!.revision,
            acceptance_content_hash: facts!.candidate!.acceptance_content_hash,
            diff: diff ? { base: diff.base, base_from: diff.base_from, revision: diff.revision, state: diff.state, detail: diff.detail } : null,
            signoffs_required: review.signoffs,
            assessments: review.assessments,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  if (fix) put('finding.json', 'instructions', fix.id, `${JSON.stringify(fix, null, 2)}\n`);
  // Each failed repair check's output record, whole (SEAM.md §229): the
  // record's text, or a note that it could not be read.
  for (const o of failedChecks) {
    const bytes = o.output === null ? null : (opts.readRecord?.(o.output) ?? null);
    put(
      `check-outputs/${safeName(o.key)}.txt`,
      'check_output',
      o.output,
      bytes ?? `The output record of the check ${o.key} (result ${o.check_result}) ${o.output === null ? 'does not exist' : 'could not be read'}.\n`,
    );
  }
  // The approved texts, verbatim (E67 item 7; SEAM.md §139): a role inside
  // the sandbox has no other way to read them.
  for (const r of facts?.requirements ?? []) {
    if (typeof r.text === 'string') put(`requirements/${safeName(r.key)}.md`, 'requirement', r.id, `# ${r.key}\n\n${r.text}\n`);
    else put(`requirements/${safeName(r.key)}.json`, 'requirement', r.id, `${JSON.stringify({ key: r.key, text_ref: r.text_ref, assigned_phase: r.assigned_phase }, null, 2)}\n`);
  }
  for (const a of facts?.adrs ?? []) put(`adrs/${safeName(a.key)}.md`, 'adr', a.id, `# ${a.key}\n\n${a.text}\n`);
  for (const c of facts?.constraints ?? []) put(`constraints/${safeName(c.key)}.md`, 'constraint', c.id, `# ${c.key}\n\n${c.text}\n`);
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
  // A qualification canary's instructions (D2 §7.2; SEAM.md §149). The
  // containment canary's probe program is not here: the engine runs it
  // (E86), from outside the package.
  if (opts.canary) put('canary.json', 'instructions', String(opts.canary.attempt ?? '') || null, `${JSON.stringify(opts.canary, null, 2)}\n`);
  if (opts.probe) {
    copyFileSync(PROBE_PROGRAM, join(dir, 'probe'));
    chmodSync(join(dir, 'probe'), 0o555);
    files.push({ path: 'probe', kind: 'instructions', source: null, sha256: createHash('sha256').update(readFileSync(join(dir, 'probe'))).digest('hex') });
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ work_item: claim.work_item, run: claim.run, role, kind: claim.work_kind, files }, null, 2)}\n`);
}
