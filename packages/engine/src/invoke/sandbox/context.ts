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

import { within } from '../../design/paths.js';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Claim } from '../../store/transitions/runs.js';
import { type CheckWritingFacts, type PhaseAuthoringFacts, checkWritingText, phaseAuthoringText } from '../../checks/guide.js';
import { canaryPromptText } from '../../trust/canaries.js';
import { REPLAN_RESULT_FIELDS, type ReplanFacts, type ReplanFileKind, replanFiles, replanPromptText } from '../../plan/replan-package.js';
import type { PhaseVerificationFacts } from '../../plan/phase.js';
import { type DesignCatalogueFacts, type DesignChangeFacts, designChangeElements, verifierDesignElements } from '../../packages/design-reads.js';
import { type BuilderStageFacts, type PackageName, type ReadsElement, architectElements, builderElements, phaseElements, readsIds, readsResultFields, readsText, specElements, statedElements, verifierElements } from '../../packages/reads.js';
import { CHANGE_SPEC_CATEGORIES, DISPOSITIONS } from '../../runs/report.js';
import { BRIEF_RESULT_SCHEMA, BRIEF_TASK, type BriefPreparationFacts, briefPreparationText } from '../../prototype/brief.js';

export const PROBE_PROGRAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes', 'program.js');

export type ContextFacts = {
  // A replan's package (plan/replan-package.ts; D6 §3.5, §5.6).
  replan?: ReplanFacts | null;
  // A phase Verifier's (D6 §5.8): the phase evaluation and its findings.
  phase?: PhaseVerificationFacts | null;
  // A review of a protected proposal: the proposal it reviews.
  proposal?: Record<string, unknown> | null;
  // A spec change's request (D6 §4.3): the owner's words, for the Spec Writer.
  change_request?: Record<string, unknown> | null;
  // A rapid prototype's brief preparation (slice E3; prototype/brief.ts).
  prototype_brief?: BriefPreparationFacts | null;
  run: { id: string; role: string; base_revision: string; content_hash: string | null };
  work_item: { id: string; kind: string; subject: string; project: string };
  stage: Record<string, unknown> | null;
  requirements: { id: string; key: string; text_ref: string; assigned_phase: number | null; text?: string | null }[];
  adrs?: { id: string; key: string; text: string }[];
  constraints?: { id: string; key: string; text: string }[];
  // `interfaces`: the module map's (B.3), absent when it could not be read.
  modules: { id: string; name: string; paths: unknown; interfaces?: unknown[] }[];
  phase_plan: Record<string, unknown> | null;
  candidate: { id: string; revision: string; acceptance_content_hash: string | null } | null;
  review?: {
    findings: FindingFacts[];
    assessments: { id: string; finding: string; candidate: string; reason: string; status: string }[];
    signoffs: { role: string; scope: string; module?: string }[];
    diff_base: { revision: string | null; from: string | null; recorded?: Record<string, string> };
    revision_records?: Record<string, { by_run: boolean; kinds: string[]; purpose: string | null }> | null;
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
  // For check_correction work: what its Verifier is told about writing the
  // project's checks (src/checks/guide.ts).
  check_writing?: CheckWritingFacts | null;
  // For check_authoring and check_correction work: the design criteria it
  // covers (M537 (a2); src/packages/design-reads.ts).
  design_catalogue?: DesignCatalogueFacts | null;
  // For a design batch's spec_change: the design's criteria and human tests.
  design_change?: DesignChangeFacts | null;
  // For check_authoring work: the phase-authoring package (D6 §6.2; N04).
  authoring?: PhaseAuthoringFacts | null;
  // For check_authoring and check_correction work after its last proposal
  // was rejected (M443): the proposal, the note, its discovery errors.
  rejected_proposal?: { proposal: string; note: string | null; errors: { path: string; code: string | null }[] } | null;
  // For a Builder sent back after a rebase conflict with the moved
  // integration branch (E152 item 4): the files and the head.
  rebase_conflict?: { run: string; head: string | null; files: string[] } | null;
  // For a Builder whose last run's diff was refused for a path a Builder may
  // not change (D1 §7.3 step 1): the refusal and the paths.
  diff_violation?: { run: string; text: string | null; paths: string[] } | null;
  // For check_correction work the owner asked for on a finding's
  // finding_disposition question (`correct_check`, E152 item 3).
  owner_correct_check?: boolean;
  resumed: { run: string; outcome: unknown; reason_class: unknown; summary: unknown; records: { id: string; kind: string; path: string | null }[] } | null;
  // Whether the project was adopted (D6 §8): its packages' retrofit variants.
  adopted?: boolean;
  // For a stage's Builder: what the package states of its stage (row M442;
  // src/packages/reads.ts).
  builder_stage?: BuilderStageFacts | null;
  // For a Builder: what each environment's current configuration fixes.
  environments?: { name: string; adapter: string | null; runtime: string | null; start: string[]; port: number | null; exclude: string[] }[] | null;
};

// What a Builder of a project with an environment is told (BS4 §3, the role
// packages; E121 item 2, CD4): what the configuration fixes, and that the
// service must not change its process title or arguments.
export function environmentText(envs: NonNullable<ContextFacts['environments']>): string {
  return [
    '# Environments',
    '',
    'The project is deployed to these environments. Their configuration is the owner\'s and fixes how the service is run; it is not in the repository and you cannot change it.',
    '',
    ...envs.flatMap((e) => [
      `## ${e.name}`,
      '',
      `- Target: ${e.adapter ?? 'unknown'}, one service.`,
      `- Runtime: ${e.runtime ?? 'unknown'} (pinned by path and hash). The service runs on it as it is: no build step runs and no dependency is installed, so the service uses the runtime's own modules only.`,
      `- Start command: ${JSON.stringify(e.start)}, run from /surety/app, the sealed artifact (read-only). Its entry point${e.start[1] ? ` ${e.start[1]}` : ''} must be a file of the repository.`,
      `- Port: the service listens on 127.0.0.1 at the port in the environment variable PORT${e.port !== null ? ` (${e.port})` : ''}.`,
      `- Excluded from the artifact: ${e.exclude.length > 0 ? e.exclude.join(', ') : 'nothing'} (and .surety/ always).`,
      '',
    ]),
    'Writable: /tmp, /surety/home and /surety/state only, all lost when the service is replaced. There is no network beyond loopback.',
    '',
    'The service must not change its process title or its arguments: do not set process.title and do not rewrite process.argv. The engine identifies the running service by the arguments it was started with, and a changed title or argument fails its verification.',
    '',
  ].join('\n');
}

// What the package states of what the engine reads from this run's product
// (row M442; src/packages/reads.ts): the role package by the run's role and
// work, its elements less any the test seam omits. A qualification attempt
// states none.
// The design catalogue's facts with the programs the governed values name.
const designCatalogue = (facts: ContextFacts): DesignCatalogueFacts | null =>
  facts.design_catalogue ? { ...facts.design_catalogue, programs: facts.check_writing?.governed ? Object.keys(facts.check_writing.governed.check_commands).sort() : null } : null;

export function contextReads(claim: Pick<Claim, 'role' | 'work_kind' | 'attempt' | 'base_revision'>, facts: ContextFacts | null): { pkg: PackageName | null; elements: ReadsElement[] } {
  if (claim.attempt || facts === null) return { pkg: null, elements: [] };
  const retrofit = facts.adopted === true;
  const pick = (pkg: PackageName, built: Parameters<typeof statedElements>[1]) => ({ pkg, elements: statedElements(pkg, built) });
  if (claim.role === 'verifier' && claim.work_kind === 'check_authoring' && facts.authoring) {
    return pick(retrofit ? 'verifier_authoring_retrofit' : 'verifier_authoring', { ...verifierElements(facts.check_writing ?? null, { authoring: true, retrofit }), ...verifierDesignElements(designCatalogue(facts)) });
  }
  if (claim.role === 'verifier' && claim.work_kind === 'check_correction' && facts.check_writing) return pick('verifier_correction', { ...verifierElements(facts.check_writing, { authoring: false, retrofit }), ...verifierDesignElements(designCatalogue(facts)) });
  if (claim.role === 'architect' && facts.replan) {
    // A replan's plan names the approved versions and the head it started
    // from (plan/bundle.ts replanBaseline): from its package's generation.
    const g = facts.replan.generation;
    const prepared = g.spec_revision && g.architecture_revision && g.roadmap_revision ? { spec_version: g.spec_revision.version, architecture_version: g.architecture_revision.version, roadmap_version: g.roadmap_revision.version, revision: claim.base_revision } : null;
    return pick(retrofit ? 'replan_retrofit' : 'replan', architectElements({ retrofit, prepared_against: prepared, kind: 'replan' }));
  }
  if (claim.role === 'verifier' && claim.work_kind === 'phase_verification' && facts.phase) return pick('phase_verification', phaseElements());
  if (claim.role === 'spec_writer' && claim.work_kind === 'spec_change') return pick('spec_change', { ...specElements({ retrofit }), ...designChangeElements(facts.design_change ?? null) });
  if (claim.role === 'builder' && facts.builder_stage) return pick('builder', builderElements(facts.builder_stage));
  return { pkg: null, elements: [] };
}

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
  // Who dispositioned it: `human` (the owner), `reviewer`, or null.
  disposition_authority?: string | null;
  source_role: string | null;
};

// The candidate's diff as the engine could take it (D2 §1.3): from `base` to
// the candidate's revision. `state` says what the patch is: the whole diff,
// its first bytes, only its file summary, or nothing, with why.
export type CandidateDiff = {
  base: string | null;
  base_from: string | null;
  revision: string;
  state: 'complete' | 'truncated' | 'stat_only' | 'unavailable';
  text: string;
  detail: string | null;
  // The commits of the range the engine made on no role run's behalf (E106),
  // or why they are unknown. Absent: not established for this package.
  engine_commits?: EngineCommitsInRange;
};

// `commits`: those the engine's records say the engine or the owner made;
// `unrecorded`: those with no record, whose maker is unknown; `more`: the
// range held more commits than were classified.
export type EngineCommitsInRange = { state: 'known'; commits: { sha: string; purpose: string }[]; unrecorded: string[]; more: boolean } | { state: 'unknown'; detail: string };

// What each kind of engine commit is, and whose (E106).
const ENGINE_COMMIT: Record<string, string> = {
  bootstrap: "the project's bootstrap (`.surety/project.json`), the engine's",
  policy: "a policy revision through the policy route (`.surety/policy.json`), the owner's",
  protected: 'an approved change to the protected checks, applied by the engine on its approval, not the Builder\'s',
  adopt: "the owner's out-of-band edits, committed by the engine on the owner's answer, the owner's",
  stash: "the owner's out-of-band edits, stashed by the engine, the owner's",
  // By the kind of its record, where no commit operation names a purpose.
  engine_commit: "a commit the engine made on no role run's behalf, the engine's",
  out_of_band: "a change of the integration branch made outside the engine and adopted by the owner, the owner's",
};
export const engineCommitText = (purpose: string): string => ENGINE_COMMIT[purpose] ?? `a commit the engine made on no role run's behalf (${purpose}), the engine's`;

// The lines naming them under the candidate.diff line (E106). A role's
// commit is never named here.
export function engineCommitLines(e: EngineCommitsInRange | undefined): string[] {
  if (e === undefined) return [];
  if (e.state === 'unknown')
    return [
      `  Which commits in this range the engine or the owner made (the project's bootstrap, a policy revision), rather than the Builder, is unknown: ${e.detail}. Do not take every change in it as the Builder's work without checking.`,
    ];
  const out: string[] = [];
  if (e.commits.length === 0) out.push("  By the engine's records, no commit in this range was made by the engine or the owner.");
  else
    out.push(
      "  By the engine's records, these commits in this range were made by the engine or the owner, on no role run's behalf. Their changes are the engine's or the owner's, not the Builder's work to review; they stay in the diff, and you may still report on them:",
      ...e.commits.map((c) => `  - ${c.sha}: ${engineCommitText(c.purpose)}.`),
    );
  if (e.unrecorded.length > 0)
    out.push(
      "  The engine has no record of these commits in this range, so who made them is unknown (the engine, the owner or a role):",
      ...e.unrecorded.map((sha) => `  - ${sha}: unknown.`),
    );
  if (e.more) out.push('  The range holds more commits than the engine classified here (its newest); who made its older commits is unknown.');
  return out;
}

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
  | 'check_output'
  // A replan's (D6 §5.6; M424 (b)).
  | ReplanFileKind
  // The phase Verifier's (D6 §5.8).
  | 'phase_evaluation'
  // A UI Builder's design (D7 §8.4).
  | 'design';

// What every role is told, and what it may not do (F §4.1).
const PROHIBITIONS = [
  'Work only in /surety/workspace; it is the only place your changes are kept.',
  'Do not commit, tag, push or change any git reference: the engine makes every commit.',
  'Do not try to reach the engine, its home, other workspaces or the network beyond your egress proxy.',
  'Write your structured result as JSON to /surety/out/result.json before you exit.',
];

// What a Builder may change (F §4.1; D1 §7.3 step 1; src/git/snapshot.ts
// pathRule): code, never `.surety/`. Real Inkwell run: a fix Builder, told
// by the finding that the ADR still said the old status, edited the ADR and
// the architecture beside its code, and every run was refused whole.
export const BUILDER_SCOPE_TEXT = [
  'Change the code only. Nothing under `.surety/` is yours to change: the specification, the architecture, the ADRs, the module map, the roadmap, the phase plans, the protected checks, the policy and the project file. A run that changes any of it is refused whole (`diff_violation`) and nothing of it is kept, the code with it.',
  "Where the architecture's or an ADR's text disagrees with an approved specification change, revising it is the Architect's, not yours: the engine routes it. Leave that text as it is, make the code meet the approved specification, and mention the disagreement in your summary if you saw one.",
];

const ROLE_TASK: Record<string, string> = {
  builder: 'Build what the stage below asks for, within the requirements it names.',
  verifier: 'Verify the work below against its requirements, and report findings.',
  reviewer: 'Review the candidate named below at the acceptance content hash it names, and report findings.',
  architect: 'Plan or replan the work below.',
  // D6 §4.3: the Spec Writer's one-shot on a specification change.
  spec_writer: "Write the specification change the owner's request asks for (/surety/context/change_request.json) into .surety/spec/spec.md, keeping every key the approved specification gives. You may not approve it.",
};

// The result's schema, per role (D2 §1.3; SEAM.md §68): every field the
// engine reads from that role's result, each in the form the engine takes,
// with what the engine does with it. A field of another role's is not
// listed: the engine records nothing of it, and an Alpha exception proposal
// from any role but the Reviewer makes the result invalid.
const SEVERITY = { enum: ['critical', 'high', 'medium', 'low'] };
const FINDING_ID = { type: 'string', pattern: '^fnd_', description: 'A finding id, as listed in /surety/context/findings.json.' };
// A finding the human owner has dispositioned keeps his decision (S1; E172
// item 7; store/transitions/findings.ts recordReport; SEAM.md §555).
const OWNER_DECIDED_TEXT =
  "A finding listed with `disposition_authority` `human` was dispositioned by the human owner, and his decision stands: a disposition you report on it that your own authority would record (a `fix`, plan-targeted or not, or a `defer` of a Low finding) is refused and recorded as refused; the finding is left as he left it and nothing is registered. An `accept` or another `defer` on it is a proposal, as on any finding: its disposition stays his.";

// What happens to a finding left with no disposition (store/transitions/
// findings.ts askUndispositioned; the driver's ruling on the real M443 run).
const OWED_TEXT = `A finding you raise in this result's \`findings\` has no id yet, so it cannot be named here. Every finding left with no disposition (one you raise, or a listed one you do not name) is put to the human owner, who chooses fix (offered only when the \`check\` the finding names can verify it: a required acceptance check of the finding's scope covering its \`criterion\`, or, for a finding naming no \`criterion\`, one covering no criterion), accept (a High or Critical finding is lowered to medium first, since it holds the gates at its severity whatever its disposition), or for a ${CHANGE_SPEC_CATEGORIES.join(' or ')} finding a specification change; say in its message what the fix or the change would be.`;
// What each finding category means and where the engine routes it (D3 §5
// X2 and §2.10; F §5.3; D6 §5.4 and §5.7; D1 §4.3). Real loop run 3: a
// Verifier filed a function whose signature broke the architecture's
// interface, a code defect, as contract_conflict, and the conflict route put
// it to the owner instead of the Builder's repair; the bare enum said
// nothing of the difference.
const DEFECT_NOT_CONFLICT =
  'When the code disagrees with a requirement or with the architecture (its interfaces or ADRs) and the check agrees with them, that is a `defect`, not a conflict: the code is wrong, and a Builder fixes it.';
export const CATEGORY_TEXT: Readonly<Record<string, string>> = {
  defect:
    "`defect`: the code is wrong against a requirement of the approved specification, the architecture's interfaces or ADRs, or a check. A Builder fixes it: fix work, or the repair of the work whose check failed (the normal route).",
  requirement_conflict:
    '`requirement_conflict`: a protected check, or the work, contradicts a requirement of the approved specification, or the specification has no criterion for the defect. The check or the requirement is wrong, not the code (if the requirement is wrong, it becomes a specification change).',
  contract_conflict:
    "`contract_conflict`: a protected check, or the phase plan, contradicts the architecture's contract (its interfaces, module map or ADRs). The check or the plan is wrong, not the code.",
  security: '`security`: a security weakness in the code; name its area in `sensitive_area` when it has one. It is fixed like a defect.',
  hygiene: '`hygiene`: a problem of upkeep rather than of behaviour, such as a change outside the work or something left behind. It is fixed like a defect.',
};
// What a fix is (F §4.1; D6 §4.5, §4.7): a Builder changes code, never
// `.surety/`. Real Inkwell run: a Verifier's defect asked that the ADR be
// "updated alongside" the code; the fix Builder did, and was refused whole
// four times. Text that disagrees with an approved specification change is
// the Architect's, through the change's replan or an architecture revision.
export const FIX_IS_CODE_TEXT =
  "A `defect`, `security` or `hygiene` finding is fixed in the code, by a Builder, who may change nothing under `.surety/` (the specification, the architecture, the ADRs, the module map, the roadmap, the phase plans, the checks): a fix that does is refused whole. Do not ask in such a finding's message for a change there. Where the architecture's or an ADR's text disagrees with an approved specification change, that is the Architect's to revise (the engine routes a specification change's replan), not a Builder's: leave it out of the finding's message and mention it in your summary.";
const CONFLICT_ROUTE_TEXT =
  "A conflict naming a check that fails on the work does not go to the Builder's repair: the engine holds the work for the human owner, who chooses to correct the check, change the specification, retry or cancel. Left with no disposition, a conflict is put to the owner with a specification change offered.";
const FINDING_CATEGORY_LIST = ['defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene'];
const FIELDS: Record<string, Record<string, unknown>> = {
  status: { const: 'completed' },
  summary: { type: 'string', description: 'What you did, in a few sentences.' },
  checkpoint: { type: 'boolean', description: 'true asks the engine to commit your workspace as a checkpoint and continue the work in a new run.' },
  nominate: { type: 'boolean', description: 'true asks the engine to nominate the result as a candidate (honoured at tier T1 only; otherwise the engine nominates on its own cadence).' },
  findings: {
    type: 'array',
    description: `Each defect or conflict you found in the candidate. The engine records each as an open finding of the candidate. Do not repeat a finding already listed in /surety/context/findings.json; change its severity instead. ${DEFECT_NOT_CONFLICT}`,
    items: {
      type: 'object',
      required: ['category', 'severity', 'message'],
      properties: {
        category: {
          enum: [...FINDING_CATEGORY_LIST],
          description: `What kind of finding it is. ${FINDING_CATEGORY_LIST.map((c) => CATEGORY_TEXT[c]).join(' ')} ${CONFLICT_ROUTE_TEXT} ${DEFECT_NOT_CONFLICT}`,
        },
        severity: SEVERITY,
        message: { type: 'string', description: `What is wrong and where, so a Builder can fix it. ${FIX_IS_CODE_TEXT}` },
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
      'Only when a protected check contradicts the requirement or the interface the work names: your objection to it. The check stays in force; if it fails, the engine does not send you back but asks the human owner to correct the check, change the spec, retry or cancel. When your code disagrees with the requirement or the interface and the check agrees with them, that is no objection: fix the code.',
    items: {
      type: 'object',
      required: ['check', 'category', 'message'],
      properties: {
        check: { type: 'string', description: 'The key of the check you object to.' },
        criterion: { type: 'string', description: 'The criterion of the requirement index the conflict is about, if one.' },
        category: {
          enum: ['contract_conflict', 'requirement_conflict'],
          description: `What the check contradicts. ${CATEGORY_TEXT.requirement_conflict} ${CATEGORY_TEXT.contract_conflict} ${DEFECT_NOT_CONFLICT}`,
        },
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
  spec_applicability: {
    type: 'array',
    description:
      'Only on the correction of a specification change: your assessment that a check applies unchanged to the changed meaning of the criteria it covers, with your rationale. It resolves that check\'s open obligation as your claim; fresh evidence under the new generation still decides. Each entry must name a check with an open obligation and cover its criteria, or the run is refused. With no change to the checks and no assessment, the correction is refused while its obligations are open.',
    items: {
      type: 'object',
      required: ['check', 'criteria', 'rationale'],
      additionalProperties: false,
      properties: { check: { type: 'string', description: 'The check key.' }, criteria: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
    },
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
      `What is to be done about each open finding listed in /surety/context/findings.json, one entry per finding, named by its id: ${DISPOSITIONS.join(', ')}. fix: the engine registers fix work for it, on a finding that names a check; a fix on a finding that names no check is refused (no check could show it done): nothing is registered, and the finding is put to the human owner (target plan excepted). defer: taken on your authority only for a Low finding with linked_issue and defer_target; otherwise, like accept, it is a proposal the human owner decides. ${OWNER_DECIDED_TEXT} ${OWED_TEXT}`,
    items: {
      type: 'object',
      required: ['finding', 'disposition'],
      properties: {
        finding: FINDING_ID,
        disposition: { enum: [...DISPOSITIONS] },
        linked_issue: { type: 'string' },
        defer_target: { type: 'string', format: 'date-time' },
        target: { enum: ['plan'], description: 'With fix, on a contract_conflict finding you raised: the conflict is with the phase plan, not the code. The engine asks the Architect to replan the open phase instead of registering fix work, and the replacement resolves the finding.' },
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

// What a check-writing Verifier's finding may name (the driver's ruling on
// loop run 1): a check of the effective version, or one this result's
// protected proposal adds, bound when the proposal is decided.
export const PROPOSED_CHECK_TEXT = (keys: readonly string[]): string =>
  `It names a check of the project (${keys.length > 0 ? keys.join(', ') : 'it has none'}), or a check your protected proposal in this result adds: a finding may name the check the same result proposes. The reference is bound when the proposal is applied; if the proposal is rejected, or the applied version does not have that check, the finding stands with no check (it is never dropped). Any other key makes the result invalid.`;

// `checkKeys` (the review of b72b9cc, F1): the keys a finding's `check` may
// name, the effective protected version's; given, `check` is an enum of
// them, and with none (no checks, or none readable) it is left out. The
// same for `criteria`, the registered index's (D3 §2.11), and a finding's
// `criterion`; and for a Builder's objections, whose `check` and
// `criterion` take the same enums.
// `proposes` (the driver's ruling on loop run 1): a check-writing Verifier,
// whose result may carry a protected proposal; a finding's `check` may name
// a check that proposal adds, so it is no enum: the keys are stated with the
// rule (invoke/choke.ts unknownCheck, runs/accept.ts proposedCheckRefusal).
export function resultSchema(role: string, checkKeys?: readonly string[], criteria?: readonly string[], opts: { proposes?: boolean } = {}): Record<string, unknown> {
  const fields: Record<string, Record<string, unknown>> = { ...(ROLE_FIELDS[role] ?? {}) };
  const narrow = (field: string) => {
    if (!fields[field]) return;
    const items = (fields[field].items ?? {}) as { properties?: Record<string, unknown> };
    const props: Record<string, unknown> = { ...(items.properties ?? {}) };
    if (checkKeys !== undefined && field === 'findings' && opts.proposes === true) {
      const check = props.check as Record<string, unknown>;
      props.check = { ...check, description: `${String(check.description)} ${PROPOSED_CHECK_TEXT(checkKeys)}` };
    } else if (checkKeys !== undefined) {
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
// B.17: a binding for every effective asset file the Builder placed.
const ASSET_BINDINGS_SCHEMA = {
  type: 'array',
  description: 'One binding for every effective asset file you placed (D7 §6.5): where it is, and whether it is the file byte for byte (copy) or made from it (derived).',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['slot', 'variant', 'target', 'path', 'form'],
    properties: { slot: { type: 'string' }, variant: { type: 'string' }, target: { type: 'string' }, path: { type: 'string', description: 'the path in the workspace' }, form: { enum: ['copy', 'derived'] } },
  },
};

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
  opts: { probe: boolean; readRecord?: (id: string) => Buffer | null; canary?: Record<string, unknown> | null; diff?: CandidateDiff | null; design?: import('../../design/package.js').DesignPackage | null },
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
              ...engineCommitLines(diff.engine_commits),
            ]
          : []),
        `- /surety/context/findings.json: the ${review.findings.length} finding(s) that apply to this candidate, ${open.length} of them open, each by the id your result names it by.${
          open.length > 0 ? ` Open: ${open.map((f) => `${f.id} (${f.severity})`).join(', ')}.` : ''
        }`,
        ...(role === 'reviewer'
          ? [
              '- /surety/context/review.json: the sign-offs this project\'s tier requires, and the applicability assessments that await your verdict.',
              '',
              `Give every open finding listed above a disposition in your result's \`dispositions\` (${DISPOSITIONS.join(', ')}), named by its id: \`fix\` registers fix work for it where the finding names a \`check\`; a \`fix\` on a finding that names no \`check\` is refused (nothing is registered, and the finding is put to the human owner), unless it is your own contract_conflict with \`target\` \`plan\`. ${OWNER_DECIDED_TEXT} Record new findings in \`findings\`, and your sign-offs in \`signoffs\`. ${OWED_TEXT}`,
              "A fix is shown done, and the finding resolved, when the finding's `check` is a required acceptance check covering the finding's `criterion` and passes after your disposition. A finding with no check, or no criterion, cannot be resolved that way: if you raise one, name both.",
              FIX_IS_CODE_TEXT,
              '',
              ...checkList,
            ]
          : [
              '',
              "Record what you find in your result's `findings`; name a listed finding by its id. The Reviewer dispositions each finding you raise; one the Reviewer leaves with none is put to the human owner.",
              "Name in each finding's `check` the key of the project's check whose passing shows it fixed (the check that covers the requirement it breaks), and in its `criterion` the criterion of the requirement index it breaks (R<n>.<m>, as listed with each check below). Without both, a fix of the finding can never be shown, and the finding stays open. If no check covers that criterion, report the finding anyway: the engine asks for the check to be corrected.",
              FIX_IS_CODE_TEXT,
              '',
              ...checkList,
            ]),
      ]
    : [];
  // check_correction work (BS3 §3): the Verifier writes the checks; the
  // finding it was registered for, if any, is one no check verifies, never
  // one it fixes in the code.
  const correcting = claim.work_kind === 'check_correction' || claim.work_kind === 'check_authoring';
  const authoring = claim.work_kind === 'check_authoring' ? (facts?.authoring ?? null) : null;
  const fix = correcting ? null : (facts?.finding ?? null);
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
        '',
        "Fix it in the code. If its message also asks for a change under `.surety/` (an ADR, the architecture, the specification, a plan or a check), that part is not yours: leave it unchanged, as the section on what you may change below says, and mention it in your summary.",
        ...(checkList.length > 0 ? ['', ...checkList] : []),
      ]
    : [];
  const routed = correcting ? (facts?.finding ?? null) : null;
  const routedText = routed
    ? [
        '',
        '## The finding this work was registered for',
        '',
        `Finding ${routed.id} (${routed.severity}, ${routed.category}${routed.check ? `; it names the check ${routed.check}` : ''}${routed.criterion ? `; it breaks the criterion ${routed.criterion}` : ''}):`,
        '',
        routed.message,
        '',
        'It is also in /surety/context/finding.json.',
        '',
        // Two routes register this work (src/store/transitions/repair.ts): a
        // Builder's objection the owner answered `correct_check` (D3 §5 X2),
        // and a `fix` disposition whose finding cannot be verified (D3 §2.11):
        // it names no criterion, no check, or a check that is not a required
        // acceptance check covering its criterion.
        ...(facts?.owner_correct_check === true && routed.check !== null
          ? [
              // E152 item 3: the owner's `correct_check` on the finding.
              `The owner judged the check \`${routed.check}\` over-broad: it fails on what the requirements allow. Correct it so that it judges only what the requirements' approved texts say, and keep everything it rightly judges. It stays in force until your corrected version is approved; the finding is resolved when the corrected check passes.`,
            ]
          : routed.source_role === 'builder' && (routed.category === 'requirement_conflict' || routed.category === 'contract_conflict')
          ? [
              `It is a Builder's objection that ${routed.check ? `the check \`${routed.check}\`` : 'a check'} contradicts the requirement or the interface its work names${routed.criterion ? ` (criterion ${routed.criterion})` : ''}; the owner chose to have the check corrected. Read the objection against the requirement's approved text, and correct the check if it is wrong.`,
            ]
          : [
              "A fix of a finding is shown only when the check the finding names is a required acceptance check covering the criterion the finding names, and passes after the disposition. This finding cannot be shown fixed that way because:",
              ...(routed.criterion ? [] : ['- it names no criterion of the requirement index;']),
              ...(routed.check === null
                ? ['- it names no check;']
                : routed.criterion
                  ? [`- the check it names, \`${routed.check}\`, is not a required acceptance check covering ${routed.criterion}. Another check may cover ${routed.criterion}; what counts is the check this finding names.`]
                  : []),
              '',
              routed.check !== null && routed.criterion
                ? `Write or correct the checks so that \`${routed.check}\` is a required acceptance check covering ${routed.criterion} that judges what the requirement's approved text says.`
                : 'While the finding does not name both, no check can show it fixed. Write or correct the checks of the criterion it concerns all the same, and say in your summary that the finding names no ' +
                  (routed.criterion ? 'check.' : routed.check === null ? 'criterion and no check.' : 'criterion.'),
            ]),
      ]
    : [];
  // The facts for check_correction work, or null when the store could not
  // give them: then the task says so, and points to no section.
  const writing = correcting ? (facts?.check_writing ?? null) : null;
  const writingText = writing ? checkWritingText(writing, checkList, { authoring: claim.work_kind === 'check_authoring' }) : [];
  // A check writer's repair after its proposal was rejected (M443): what
  // the engine found wrong with it, so the repair does not repeat it.
  const rejected = correcting ? (facts?.rejected_proposal ?? null) : null;
  const rejectedText = rejected
    ? [
        '',
        '## Your last proposal was rejected',
        '',
        `Proposal ${rejected.proposal} was rejected${rejected.note ? `: "${rejected.note}"` : ''}.`,
        ...(rejected.errors.length > 0
          ? [
              'The engine found these errors in its definitions (file#pointer: code); correct each, against the sections on what the engine reads:',
              ...rejected.errors.map((x) => `- \`${x.path}\`: ${x.code ?? 'code unknown'}`),
            ]
          : ['The engine recorded no discovery error in it.']),
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
          'Fix the code, not the checks: they are protected. If a check contradicts the requirement or the interface, report it in your result\'s `objections`; if the check agrees with them and your code does not, the code is wrong: fix it.',
        ]
      : [];
  // A Builder sent back after a rebase conflict (D1 §7.5 as amended, E152
  // item 4): what moved and which files no longer applied.
  const rebase = role === 'builder' ? (facts?.rebase_conflict ?? null) : null;
  const rebaseText = rebase
    ? [
        '',
        '## Your last run could not be integrated',
        '',
        `While your last run (${rebase.run}) was under way the integration branch moved${rebase.head ? ` to ${rebase.head}` : ''}, and its changes to these files no longer applied to it:`,
        ...(rebase.files.length > 0 ? rebase.files.map((f) => `- \`${f}\``) : ['- (the engine did not record which)']),
        '',
        `Nothing of that run was integrated. This run starts from the new head (base revision ${claim.base_revision}): read what changed in those files there, and make your work again on top of it. The engine sends the work back once for such a conflict; another parks it for the owner.`,
      ]
    : [];
  // A Builder's repair after its last run's diff was refused for a path a
  // Builder may not change (D1 §7.3 step 1): the refusal and each path, to
  // leave unchanged, so that the repair does not repeat it.
  const violation = role === 'builder' && !claim.attempt ? (facts?.diff_violation ?? null) : null;
  const violationText = violation
    ? [
        '',
        '## Your last run was refused',
        '',
        `Your last run (${violation.run}) was refused whole, and nothing of it was kept: ${violation.text ?? 'the engine did not record why'}.`,
        ...(violation.paths.length > 0
          ? [
              'It changed these paths, which a Builder may not change:',
              ...violation.paths.map((p) => `- \`${p}\``),
              '',
              'Leave each of them unchanged in this run (as it is at the base revision), and make the code change again: a run that changes any of them is refused whole again.',
            ]
          : ['Do not repeat what it names: a run that does is refused whole again.']),
      ]
    : [];
  const builderScope = role === 'builder' && !claim.attempt ? ['', '## What you may change', '', ...BUILDER_SCOPE_TEXT] : [];
  const reads = contextReads(claim, facts);
  const prompt = [
    `# Your task (${role})`,
    '',
    claim.attempt
      ? 'This run qualifies the backend you run as: the section below says what it asks, and asks nothing else.'
      : claim.work_kind === 'fix' && fix
        ? 'Fix the finding below.'
        : correcting
          ? writing
            ? "Write or correct the project's protected checks, as the section below says."
            : "Write or correct the project's protected checks. The project's check facts (its protected roots, programs, requirements and criteria) could not be read, so none is given here: change nothing, and say so in your summary."
          : claim.work_kind === 'brief_preparation'
            ? BRIEF_TASK
            : (ROLE_TASK[role] ?? 'Do the work the work item below names.'),
    '',
    `Work item: ${claim.work_item} (${claim.work_kind}); run ${claim.run}; base revision ${claim.base_revision}.`,
    ...(goal !== null ? ['', '## The stage', '', `Stage ${String(facts?.stage?.number ?? '')}: ${goal}`] : []),
    ...(facts?.candidate ? ['', '## The candidate', '', `Candidate ${facts.candidate.id} at revision ${facts.candidate.revision}.`] : []),
    ...reviewText,
    ...fixText,
    ...routedText,
    ...writingText,
    ...(authoring ? phaseAuthoringText(authoring) : []),
    ...rejectedText,
    ...repairText,
    ...rebaseText,
    ...violationText,
    ...builderScope,
    ...(opts.design ? opts.design.prompt : []),
    ...(facts?.replan ? replanPromptText(facts.replan) : []),
    ...(facts?.prototype_brief ? briefPreparationText(facts.prototype_brief) : []),
    ...(facts?.phase
      ? [
          '',
          '## The phase',
          '',
          `Phase ${facts.phase.phase_plan.phase_number} (plan ${facts.phase.phase_plan.id}, generation ${facts.phase.phase_plan.generation}) on candidate ${facts.phase.candidate}: its \`phase\` gate evaluation is ${facts.phase.evaluation ? `${facts.phase.evaluation.outcome} (${facts.phase.evaluation.id})` : 'not recorded'}. /surety/context/phase.json holds the evaluation with every check's state and the phase's findings.`,
          'Read them and raise any finding.',
        ]
      : []),
    ...readsText(reads.elements),
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
      ...(role === 'builder' && !claim.attempt ? ['- Change the code only: nothing under `.surety/` is a Builder\'s to change (see "What you may change" in the prompt).'] : []),
      '',
      'The result must follow /surety/context/result-schema.json: the engine reads those fields and no other.',
      '',
    ].join('\n'),
  );
  const reports = role === 'verifier' || role === 'reviewer';
  const keys = facts?.checks && reports ? (facts.checks_known === false ? [] : [...new Set(facts.checks.map((c) => c.key))].sort()) : role === 'builder' && facts?.check_keys ? facts.check_keys : undefined;
  const criteria = (reports || role === 'builder') && facts && facts.criteria !== undefined ? (facts.criteria ?? []) : undefined;
  const proposes = role === 'verifier' && (claim.work_kind === 'check_authoring' || claim.work_kind === 'check_correction');
  const base = claim.attempt ? canaryResultSchema(String(opts.canary?.kind ?? claim.attempt.kind)) : resultSchema(role, keys, criteria, { proposes });
  // A replan's result (Appendix B.7): the plan it wrote and its declaration.
  // A phase authoring's result (B.7; N04): its governed changes and deferrals.
  // A phase authoring's result (B.7; N04): the fields its package's stated
  // elements add (governed changes, deferrals and, in retrofit, adopted
  // tests), so an element the test seam omits leaves its fields out too.
  // The fields the package's stated elements add (a phase authoring's
  // governed changes, deferrals and adopted tests; a phase sign-off; a spec
  // change's claimed changes; a retrofit replan's requests): an element the
  // test seam omits leaves its fields out too (row M442).
  const added = readsResultFields(reads.elements);
  const withAdded = { ...base, properties: { ...(base.properties as Record<string, unknown>), ...added } };
  const authored = authoring ? { ...withAdded, title: "The Verifier's phase authoring result, written to /surety/out/result.json" } : withAdded;
  const schema = facts?.replan ? { ...base, title: "The Architect's replan result, written to /surety/out/result.json", required: ['status', 'summary', 'plan', 'conformance'], properties: { ...(base.properties as Record<string, unknown>), ...REPLAN_RESULT_FIELDS, findings: FIELDS.findings, ...added } } : base;
  // A UI Builder's result declares its asset bindings (D7 §6.5, B.17).
  const withBindings = opts.design ? { ...authored, properties: { ...(authored.properties as Record<string, unknown>), asset_bindings: ASSET_BINDINGS_SCHEMA } } : authored;
  // A brief preparation's result carries the brief's idea-derived fields (slice E3).
  const withBrief = claim.work_kind === 'brief_preparation' ? { ...withBindings, title: "The Spec Writer's brief preparation result, written to /surety/out/result.json", required: ['status', 'summary', 'brief'], properties: { ...(withBindings.properties as Record<string, unknown>), brief: BRIEF_RESULT_SCHEMA } } : withBindings;
  put('result-schema.json', 'result_schema', null, `${JSON.stringify(facts?.replan ? schema : withBrief, null, 2)}\n`);
  if (facts?.prototype_brief) put('prototype-brief.json', 'instructions', facts.prototype_brief.iteration, `${JSON.stringify(facts.prototype_brief, null, 2)}\n`);
  if (facts?.replan?.prototype) put('prototype-brief.json', 'instructions', facts.replan.prototype.iteration, `${JSON.stringify(facts.replan.prototype, null, 2)}\n`);
  // The design's files, each confirmed inside the package (the slice-40 review's B1).
  for (const f of opts.design?.files ?? []) {
    if (!f.path.startsWith('design/') || within(dir, f.path) === null) throw new Error(`the design file ${JSON.stringify(f.path)} would be written outside the context package`);
    put(f.path, 'design', null, f.content);
  }
  if (authoring) put('authoring.json', 'instructions', authoring.phase_plan?.id ?? null, `${JSON.stringify(authoring, null, 2)}\n`);
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
            diff: diff
              ? { base: diff.base, base_from: diff.base_from, revision: diff.revision, state: diff.state, detail: diff.detail, ...(diff.engine_commits ? { engine_commits: diff.engine_commits } : {}) }
              : null,
            signoffs_required: review.signoffs,
            assessments: review.assessments,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  if (facts?.replan) for (const f of replanFiles(facts.replan)) put(f.path, f.kind, f.source, f.content);
  if (facts?.phase) put('phase.json', 'phase_evaluation', facts.phase.evaluation?.id ?? null, `${JSON.stringify(facts.phase, null, 2)}\n`);
  if (facts?.change_request) put('change_request.json', 'instructions', String(facts.change_request.id), `${JSON.stringify(facts.change_request, null, 2)}\n`);
  if (facts?.proposal) put('proposal.json', 'instructions', String(facts.proposal.id), `${JSON.stringify(facts.proposal, null, 2)}\n`);
  if (fix) put('finding.json', 'instructions', fix.id, `${JSON.stringify(fix, null, 2)}\n`);
  if (rebase) put('rebase-conflict.json', 'instructions', rebase.run, `${JSON.stringify(rebase, null, 2)}\n`);
  if (routed) put('finding.json', 'instructions', routed.id, `${JSON.stringify(routed, null, 2)}\n`);
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
  if (role === 'builder' && facts?.environments && facts.environments.length > 0) put('environments.md', 'instructions', null, environmentText(facts.environments));
  if (facts?.phase_plan) put('phase-plan.json', 'phase_plan', String(facts.phase_plan.id ?? '') || null, `${JSON.stringify(facts.phase_plan, null, 2)}\n`);
  for (const m of facts?.modules ?? []) put(`interfaces/${safeName(m.name)}.json`, 'interface', m.id, `${JSON.stringify({ module: m.name, paths: m.paths, ...(m.interfaces !== undefined ? { interfaces: m.interfaces } : {}) }, null, 2)}\n`);
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
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ work_item: claim.work_item, run: claim.run, role, kind: claim.work_kind, files, ...(reads.pkg ? { package: reads.pkg, reads: readsIds(reads.elements) } : {}) }, null, 2)}\n`);
}
