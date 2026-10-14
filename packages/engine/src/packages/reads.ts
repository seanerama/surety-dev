// What each role package states of what the engine reads from that role's
// products (E87 item 10: each role's package says what its gate reads;
// E135: M4's rehearsal passed while the real run failed, because the fake
// carried what the package never stated; BS5 §3, §12; row M442).
//
// One registry (src/packages/elements.ts names the elements). Each element
// is a one-line gloss and a JSON value written from the parsers' and gates'
// own constants (B.2's syntax, Appendix B.3 to B.6's closed schemas, the
// plan check's reasons, the kind floors, the definition reference, the
// adoption boundary), never copied by hand. It is rendered into the
// package's prompt.md as a subsection whose fenced block's info string is
// `json surety-reads <id>`: the block is the contract, the gloss a line for
// a reader. The package's manifest lists the ids it states under `reads`. A
// rehearsal's fake reads these blocks and the package's facts files, and
// nothing else (BS5 §12).
//
// The test seam can leave an element out of every package written from then
// on (row M442 (b); `--harness-package-omit`, POST /v1/harness/package-omit):
// its subsection, its block, the result fields it adds and its id in `reads`
// all go. Outside harness mode nothing is left out. Pure but for that read.

import { ADOPTED_TEST_FIELDS, BOUNDARY_DISPOSITIONS } from '../adopt/boundary.js';
import { AUTHORING_RESULT_FIELDS, type CheckWritingFacts, DEPLOYMENT_GATE } from '../checks/guide.js';
import { INDEX_COLUMNS, INDEX_ORIGIN_COLUMN, ORIGINS } from '../checks/requirement-index.js';
import { CHECK_KINDS, COVERING_KINDS, POST_DEPLOY, SENSITIVE_AREAS, SENSITIVE_AREA_NAMES, defaultGoverned } from '../checks/schema.js';
import { KIND_INVENTORY, SCOPE_KINDS, type Tier } from '../checks/scope.js';
import { PLAN_REASONS } from '../plan/check.js';
import { ADR_FIELDS, ADR_HEADINGS, ADR_STATUSES, B3, B4, B5, INTERFACE_KINDS, MODULES_FILE, ROADMAP_FILE } from '../plan/schemas.js';
import { QUESTION_BLOCKER_CODES } from '../spec/keys.js';
import { CLAIMS_COLUMNS, MODULE_TABLE_COLUMNS, SPEC_BLOCKING_CODES, SPEC_AREAS_LABEL, SPEC_HEADER_FIELDS, SPEC_MARKS, SPEC_SECTIONS, SPEC_STATUS_VALUES } from '../spec/semantics.js';
import { seamPackageOmitted } from '../testing/seam.js';
import { ELEMENT_TITLES, type ElementId, PACKAGE_ELEMENTS, type PackageName } from './elements.js';

export { PACKAGE_ELEMENTS, type PackageName, type ElementId } from './elements.js';

export interface ReadsElement {
  id: ElementId;
  gloss: string;
  data: unknown;
  // Fields the element adds to the run's result schema (B.7), if any.
  result_fields?: Record<string, Record<string, unknown>>;
}

export const READS_INFO = 'surety-reads';

type Built = Partial<Record<ElementId, ReadsElement | null>>;

// The elements a package states, in its registry order: those built (an
// element whose facts the package lacks is not built) and not omitted by
// the test seam.
export function statedElements(pkg: PackageName, built: Built): ReadsElement[] {
  const out: ReadsElement[] = [];
  for (const id of PACKAGE_ELEMENTS[pkg] as readonly ElementId[]) {
    const e = built[id];
    if (e && !seamPackageOmitted(id)) out.push(e);
  }
  return out;
}

// The section of prompt.md: one subsection per element, its gloss and its
// fenced block.
export function readsText(elements: readonly ReadsElement[]): string[] {
  if (elements.length === 0) return [];
  const out = ['', 'The engine reads your product mechanically, in exactly the forms the sections below state and nothing outside them. Each `surety-reads` block is exact: follow it.'];
  for (const e of elements) out.push('', `## What the engine reads: ${ELEMENT_TITLES[e.id]}`, '', e.gloss, '', `\`\`\`json ${READS_INFO} ${e.id}`, JSON.stringify(e.data, null, 2), '```');
  return out;
}

// The result fields the stated elements add.
export function readsResultFields(elements: readonly ReadsElement[]): Record<string, Record<string, unknown>> {
  return Object.assign({}, ...elements.map((e) => e.result_fields ?? {}));
}

// The ids stated, for the manifest's `reads`.
export const readsIds = (elements: readonly ReadsElement[]): string[] => elements.map((e) => e.id);

const KEY_PATTERN = '^R[1-9][0-9]*$';
const CRITERION_PATTERN = '^R[1-9][0-9]*\\.[1-9][0-9]*$';
const ADR_KEY_PATTERN = '^ADR-[0-9]{3,}$';
const section = (n: number, title: string): string => `## ${n}. ${title}`;

// ---- The Spec Writer (B.2; D6 §3.2, §3.4; K10) --------------------------------------------

const TIER_NAME: Record<Tier, string> = { T1: 'prototype', T2: 'standard', T3: 'critical' };

export function specElements(opts: { retrofit: boolean }): Built {
  const [, status] = SPEC_HEADER_FIELDS;
  return {
    'spec_writer.header_fields': {
      id: 'spec_writer.header_fields',
      gloss: 'At the top of `.surety/spec/spec.md`, one line per field: the label, then its value.',
      data: { fields: SPEC_HEADER_FIELDS.map((name) => ({ name, line: `**${name}:**`, ...(name === status ? { value: SPEC_STATUS_VALUES[0] } : {}) })) },
    },
    'spec_writer.requirement_form': {
      id: 'spec_writer.requirement_form',
      gloss: 'Each requirement is one subsection of section 4: the heading, the statement as its first paragraph, the sensitive-areas line, then each criterion as a list item.',
      data: { section: section(SPEC_SECTIONS.requirements, 'Requirements'), heading: '### R<n>. <title>', statement: '<text>', sensitive_areas: SPEC_AREAS_LABEL, criterion: '- R<n>.<m> <text>' },
    },
    'spec_writer.marks': {
      id: 'spec_writer.marks',
      gloss: 'A requirement with no criteria carries one of these lines instead: human_test when only a person can test it; descriptive in retrofit, for what the code does with criteria still to come.',
      data: { human_test: SPEC_MARKS.human_test, descriptive: SPEC_MARKS.descriptive },
    },
    'spec_writer.question_form': {
      id: 'spec_writer.question_form',
      gloss: 'Each open question is one list item of section 10; every R<n> it names is blocked by it, and its trailing phase hint says which phase it must be settled before.',
      data: { section: section(SPEC_SECTIONS.questions, 'Open questions'), item: '- Q<k> <text>', phase_hint: '(phase <n>)' },
    },
    'spec_writer.index_columns': {
      id: 'spec_writer.index_columns',
      gloss: 'Section 5 is one table in these columns, one row per requirement of section 4, agreeing with it exactly.',
      data: { section: section(SPEC_SECTIONS.index, 'Requirement index'), columns: [...INDEX_COLUMNS, INDEX_ORIGIN_COLUMN], origin: [...ORIGINS], default_origin: ORIGINS[0] },
    },
    'spec_writer.module_table': {
      id: 'spec_writer.module_table',
      gloss: "Section 6's table, in exactly these columns.",
      data: { section: section(SPEC_SECTIONS.modules, 'Modules and protected paths'), columns: [...MODULE_TABLE_COLUMNS] },
    },
    'spec_writer.environment_fields': {
      id: 'spec_writer.environment_fields',
      gloss: 'One subsection of section 7 per environment, headed by its name, each field a list item `- **<Field>:** <value>`.',
      data: {
        section: section(SPEC_SECTIONS.environments, 'Environments'),
        heading: '### <name>',
        line: '- **<Field>:** <value>',
        fields: ['Purpose', 'Verified means', 'Target', 'Runtime and start command', 'Port', 'Excluded from the artifact', 'Required post-deploy behaviour check', 'Stable arguments'],
      },
    },
    'spec_writer.sensitive_areas': {
      id: 'spec_writer.sensitive_areas',
      gloss: 'Name sensitive areas only by these identifiers, comma-separated, or write `none`.',
      data: { areas: SENSITIVE_AREAS.map((id) => ({ id, name: SENSITIVE_AREA_NAMES[id] ?? id })), none: 'none' },
    },
    'spec_writer.tier_table': {
      id: 'spec_writer.tier_table',
      gloss: "The header's Tier is one of these; each requires checks of its kinds at every gate.",
      data: { tiers: (Object.keys(KIND_INVENTORY) as Tier[]).map((tier) => ({ tier, name: TIER_NAME[tier], kinds: [...KIND_INVENTORY[tier]] })) },
    },
    'spec_writer.approval_blockers': {
      id: 'spec_writer.approval_blockers',
      gloss: "The owner's approve is blocked while any of these holds at the last save; you cannot approve your own specification.",
      data: {
        blockers: [
          { code: 'spec_semantics_invalid', when: 'the specification cannot be read in the forms above, or has any of these findings', findings: [...SPEC_BLOCKING_CODES] },
          { code: QUESTION_BLOCKER_CODES.no_hint, when: 'an open question has no (phase <n>)' },
          { code: QUESTION_BLOCKER_CODES.requirement_no_hint, when: 'an open question blocks a requirement with no Phase in the index' },
          { code: QUESTION_BLOCKER_CODES.phase_1, when: 'an open question blocks a requirement whose index Phase is 1' },
          { code: 'spec_keys_renumbered', when: 'a key of the approved specification now names another requirement or criterion' },
          { code: 'spec_key_reused', when: 'a withdrawn key is used again' },
          ...(opts.retrofit ? [{ code: 'requirement_confirm', when: 'full mode: a requirement you produced has not been confirmed, marked a defect or withdrawn by the owner' }] : []),
        ],
      },
    },
    'spec_writer.claims_table': opts.retrofit
      ? {
          id: 'spec_writer.claims_table',
          gloss: 'Section 12 is one table, one row per claim the repository makes about itself, set against what the code was observed to do.',
          data: { section: section(SPEC_SECTIONS.claims, 'Claims and reality'), columns: [...CLAIMS_COLUMNS], not_checked: 'not checked', none: 'none' },
        }
      : null,
  };
}

// ---- The Architect (B.3 to B.6; D6 §5.3, §5.4) ------------------------------------------

// A closed object's schema from a field list: `table` gives every field's
// schema, so a field added to the parser without one here fails the build.
function closedObject<F extends readonly string[]>(spec: { fields: F; required: readonly string[] }, table: Record<F[number], unknown>): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: [...spec.required], properties: Object.fromEntries(spec.fields.map((f: F[number]) => [f, table[f]])) };
}
const str = { type: 'string' };
const nonEmpty = { type: 'string', minLength: 1 };
const posInt = { type: 'integer', minimum: 1 };
const strings = { type: 'array', items: str };
const keys = { type: 'array', items: { type: 'string', pattern: KEY_PATTERN } };
const areas = { type: 'array', items: { enum: [...SENSITIVE_AREAS] } };

const INTERFACE_SCHEMA = closedObject(B3.interface, { name: nonEmpty, kind: { enum: [...INTERFACE_KINDS] }, path: str, description: str });
const MODULE_SCHEMA = closedObject(B3.module, {
  name: nonEmpty,
  paths: strings,
  sensitive_areas: areas,
  tier_override: { enum: ['T1', 'T2', 'T3'] },
  interfaces: { type: 'array', items: INTERFACE_SCHEMA },
  requirements: keys,
});
export const MODULE_MAP_SCHEMA = closedObject(B3.file, {
  version: { const: 1 },
  modules: { type: 'array', items: MODULE_SCHEMA },
  mapping_from_spec: { type: 'array', items: closedObject(B3.mapping, { spec_module: nonEmpty, to: strings }) },
});
export const ROADMAP_SCHEMA = closedObject(B4.file, {
  version: posInt,
  architecture_version: posInt,
  phases: { type: 'array', minItems: 1, items: closedObject(B4.phase, { number: posInt, goal: nonEmpty, modules: strings, requirement_ids: keys, depends_on: { type: 'array', items: posInt } }) },
  moved_requirements: { type: 'array', items: closedObject(B4.moved, { key: { type: 'string', pattern: KEY_PATTERN }, from: { type: ['integer', 'null'], minimum: 1 }, to: posInt }) },
});
export const PHASE_PLAN_SCHEMA = closedObject(B5.file, {
  phase: { ...posInt, description: 'the n of the file name' },
  prepared_against: closedObject(B5.prepared_against, { spec_version: posInt, architecture_version: posInt, roadmap_version: posInt, revision: { type: 'string', pattern: '^[0-9a-f]{40}$' } }),
  stages: {
    type: 'array',
    minItems: 1,
    items: closedObject(B5.stage, {
      number: posInt,
      goal: nonEmpty,
      tasks: strings,
      modules: strings,
      implements: keys,
      adrs: { type: 'array', items: { type: 'string', pattern: ADR_KEY_PATTERN } },
      depends_on: { type: 'array', items: posInt },
      validation: closedObject(B5.validation, { criteria: { type: 'array', items: { type: 'string', pattern: CRITERION_PATTERN } }, kinds: { type: 'array', items: { enum: [...CHECK_KINDS] } }, sensitive_areas: areas }),
      integration_obligations: strings,
      conformance: { type: 'boolean', description: 'true only on an adopted project\'s conformance stage, whose tasks are []' },
    }),
  },
  conformance: { enum: [...B5.conformance_values] },
  roadmap_revision: ROADMAP_SCHEMA,
  notes: str,
});
export const ADR_FRONT_MATTER_SCHEMA = closedObject(ADR_FIELDS, {
  key: { type: 'string', pattern: ADR_KEY_PATTERN },
  status: { enum: [...ADR_STATUSES] },
  supersedes: { type: 'string', pattern: ADR_KEY_PATTERN },
  reconstructed: { type: 'boolean' },
});

// What each reason of the plan check refuses (D6 A.4), keyed by every
// reason the check computes: a reason added there without its rule here
// fails the build.
const PLAN_REASON_RULES: Record<(typeof PLAN_REASONS)[number], string> = {
  PLAN_UNKNOWN_REQUIREMENT: 'a stage implements a requirement the approved specification does not have',
  PLAN_UNKNOWN_MODULE: 'a stage names a module the module map does not define',
  PLAN_UNKNOWN_ADR: 'a stage cites an ADR that does not exist',
  PLAN_CRITERION_MISMATCH: "a stage validates a criterion that is not one of its requirements' approved criteria",
  PLAN_UNKNOWN_STAGE: 'a stage depends on a stage number the plan does not have',
  PLAN_DUPLICATE_STAGE: 'two stages share a number',
  PLAN_QUESTION_OPEN: 'a stage implements a requirement an open question blocks',
  PLAN_STALE_BASELINE: 'prepared_against does not name the approved versions this plan is checked against',
  PLAN_CYCLE: 'the stages depend on each other in a cycle',
  PLAN_MODULE_OUTSIDE_PHASE: "a stage touches a module the roadmap's phase does not list",
  PLAN_REQUIREMENT_UNPLANNED: 'a requirement the roadmap assigns to this phase is implemented by no stage',
  PLAN_DEPENDENCY_INCOMPLETE: 'the phase depends on a phase that is not complete',
  PLAN_CRITERION_UNVALIDATED: "a criterion of an implemented requirement is in no stage's validation.criteria",
  PLAN_AREA_UNVALIDATED: "a sensitive area of an implemented requirement or a touched module is in no stage's validation.sensitive_areas",
  PLAN_KIND_MISSING: "a stage's validation.kinds lacks a kind its tier requires",
  PLAN_DESCRIPTIVE_MODULE_TOUCHED: 'scoped mode: a stage touches a module holding a descriptive requirement with no approved criteria',
  PLAN_CONFORMANCE_MISPLACED: "conformance: true outside the adopted project's first phase, or on a stage with tasks",
};
const RETROFIT_REASONS: readonly string[] = ['PLAN_DESCRIPTIVE_MODULE_TOUCHED', 'PLAN_CONFORMANCE_MISPLACED'];

export function architectElements(opts: { retrofit: boolean }): Built {
  return {
    'architect.schema.modules': { id: 'architect.schema.modules', gloss: 'The module map: JSON in exactly this schema; an unknown field is refused by name.', data: { file: MODULES_FILE, schema: MODULE_MAP_SCHEMA } },
    'architect.schema.roadmap': { id: 'architect.schema.roadmap', gloss: 'The roadmap: every approved requirement in exactly one phase.', data: { file: ROADMAP_FILE, schema: ROADMAP_SCHEMA } },
    'architect.schema.phase_plan': { id: 'architect.schema.phase_plan', gloss: 'The plan of the next phase only.', data: { file: '.surety/phases/phase-<n>.json', schema: PHASE_PLAN_SCHEMA } },
    'architect.schema.adr': {
      id: 'architect.schema.adr',
      gloss: 'One decision per file: front matter between two `---` lines, then the three headings.',
      data: { file: '.surety/adrs/ADR-<nnn>.md', front_matter: ADR_FRONT_MATTER_SCHEMA, headings: [...ADR_HEADINGS] },
    },
    'architect.plan_reasons': {
      id: 'architect.plan_reasons',
      gloss: 'The engine checks every plan against the approved specification, architecture and roadmap; each reason refuses it.',
      data: {
        reasons: PLAN_REASONS.filter((code) => opts.retrofit || !RETROFIT_REASONS.includes(code)).map((code) => ({ code, rule: PLAN_REASON_RULES[code] })),
        kinds_by_tier: Object.fromEntries((Object.keys(KIND_INVENTORY) as Tier[]).map((t) => [t, [...KIND_INVENTORY[t]]])),
      },
    },
    'architect.routing': {
      id: 'architect.routing',
      gloss: "A plan that passes the check is registered by the engine when nothing it compares changed; otherwise the owner decides.",
      data: {
        registered: 'engine:plan_check',
        human: 'plan_approval',
        compared: ['.surety/architecture/architecture.md', MODULES_FILE, '.surety/adrs/', ROADMAP_FILE, 'the plan\'s roadmap_revision', 'the stage count against phase_size'],
        declarations: 'a declaration only adds uncertainty: the plan\'s conformance "uncertain" sends it to the owner; "within_baseline" never hides a computed change',
      },
    },
  };
}

// ---- The Verifier (D3 Appendix B; D4 §5.1; D6 §6.2, §8.3) ---------------------------------

const ROUTE_SCOPES = SCOPE_KINDS.filter((k) => k !== 'phase');
const BEHAVIOR = POST_DEPLOY.find((k) => k.endsWith('behavior'))!;
const POST_DEPLOY_ORDER = [BEHAVIOR, ...POST_DEPLOY.filter((k) => k !== BEHAVIOR)];

export const NO_EXECUTION_AUTHORITY =
  'A proposal grants no execution authority: what you leave under the protected roots is captured as a protected proposal, classified by the engine as the classifier computes it (never as you request it), and decided on through the protected update route; only once it is applied are your checks run.';

export const ADOPTION_RULE =
  "Existing tests are the Builder's and evidence of nothing as they stand. To adopt one, copy its acceptance logic (the assertions, the expectations, the fixtures, the assertion helpers it imports and the runner configuration that decide its verdict) under the protected root, rewrite the copy's imports to the copies or replace them with your own protected logic, and give it a definition of origin acceptance naming the criteria it covers. An adopted check never delegates its verdict to the original suite or its helpers: nothing under the protected root may import outside it except a dependency_boundary entry with disposition application (the application as the subject under test). List each adoption in adopted_tests with its dependency boundary: every file it depends on and its disposition. Prefer tests that run the candidate as a child.";

export function verifierElements(f: CheckWritingFacts | null, opts: { authoring: boolean; retrofit: boolean }): Built {
  const tier = f && Object.hasOwn(KIND_INVENTORY, f.tier) ? (f.tier as Tier) : null;
  const envs = f?.environments ?? null;
  const root = f?.governed ? (f.governed.protected_paths.find((r) => f.governed!.check_discovery.definitions.startsWith(r)) ?? f.governed.protected_paths[0] ?? null) : (defaultGoverned().protected_paths[0] ?? null);
  const out: Built = {
    'verifier.kinds': {
      id: 'verifier.kinds',
      gloss: "A definition's `kind` is one of these; a criterion is shown met only by a check of a criteria kind.",
      data: { kinds: [...CHECK_KINDS], criteria_kinds: [...COVERING_KINDS], by_tier: Object.fromEntries((Object.keys(KIND_INVENTORY) as Tier[]).map((t) => [t, [...KIND_INVENTORY[t]]])) },
    },
    'verifier.gate_kinds_floor': {
      id: 'verifier.gate_kinds_floor',
      gloss: `Every scope needs a required acceptance-origin check of each floor kind listing that gate: list ${ROUTE_SCOPES.join(' and ')} in \`gate_kinds\` on each, or the deployment request is refused ACCEPTANCE_SCOPE_INCOMPLETE.`,
      data: { tier: f?.tier ?? null, floor: tier ? [...KIND_INVENTORY[tier]] : null, gate_kinds: [...ROUTE_SCOPES] },
    },
    'verifier.requires': {
      id: 'verifier.requires',
      gloss: 'A definition of a post-deploy kind requires the environment and the artifact digest; no other kind takes `requires`.',
      data: { member: 'requires', values: ['environment', 'artifact_digest'], kinds: [...POST_DEPLOY_ORDER] },
    },
    'verifier.covers': {
      id: 'verifier.covers',
      gloss: 'Every criterion needs a required acceptance-origin check of a criteria kind naming it in `covers.criteria`; `covers.sensitive_areas` only on sensitivity_floor.',
      data: {
        member: 'covers',
        criteria: 'criteria',
        sensitive_areas: 'sensitive_areas',
        criteria_kinds: [...COVERING_KINDS],
        refused_on: CHECK_KINDS.filter((k) => !COVERING_KINDS.includes(k) && k !== 'sensitivity_floor'),
      },
    },
    'verifier.secrets': {
      id: 'verifier.secrets',
      gloss: "`secrets` names deployment secret references an environment allows its checks, only on a check that requires `environment`; never a value.",
      data: { member: 'secrets', reference: 'deploy/<name>', variable: 'SURETY_SECRET_<NAME>', environments: envs === null ? null : envs.map((e) => ({ name: e.name, check_secrets: e.check_secrets })) },
    },
    'verifier.post_deploy': {
      id: 'verifier.post_deploy',
      gloss: `The ${DEPLOYMENT_GATE} gate needs a required ${BEHAVIOR} check exercising a user operation through the target's variable; it lists only ${DEPLOYMENT_GATE} and covers nothing.`,
      data: { kinds: [...POST_DEPLOY_ORDER], gate_kind: DEPLOYMENT_GATE, required: BEHAVIOR, variable: 'SURETY_TARGET_<NAME>', environments: envs === null ? null : envs.map((e) => ({ name: e.name, targets: e.targets })) },
    },
  };
  if (opts.authoring) {
    out['verifier.authoring_result'] = {
      id: 'verifier.authoring_result',
      gloss: 'Your result carries these fields beside summary and proposal (result-schema.json).',
      data: { fields: ['governed_changes', 'deferred_criteria', ...(opts.retrofit ? ['adopted_tests'] : [])], no_execution_authority: NO_EXECUTION_AUTHORITY },
      result_fields: { governed_changes: AUTHORING_RESULT_FIELDS.governed_changes!, deferred_criteria: AUTHORING_RESULT_FIELDS.deferred_criteria! },
    };
    if (opts.retrofit) {
      out['verifier.adoption_rule'] = {
        id: 'verifier.adoption_rule',
        gloss: 'Adopt an existing test only by copying its acceptance logic under the protected root, with its dependency boundary declared.',
        data: { field: 'adopted_tests', dispositions: [...BOUNDARY_DISPOSITIONS], protected_root: root, rule: ADOPTION_RULE },
        result_fields: {
          adopted_tests: {
            type: 'array',
            description: 'Each existing test you adopted: the files copied from, what it became under the protected root, the criteria it covers and its dependency boundary.',
            items: {
              type: 'object',
              required: [...ADOPTED_TEST_FIELDS],
              additionalProperties: false,
              properties: {
                from: strings,
                to: str,
                criteria: { type: 'array', items: { type: 'string', pattern: CRITERION_PATTERN } },
                dependency_boundary: {
                  type: 'array',
                  items: { type: 'object', required: ['path', 'disposition'], additionalProperties: false, properties: { path: str, disposition: { enum: [...BOUNDARY_DISPOSITIONS] } } },
                },
              },
            },
          },
        },
      };
    }
  }
  return out;
}

// ---- The Builder (B.5; D6 §6.4) -----------------------------------------------------------

export interface BuilderStageFacts {
  number: number;
  goal: string;
  tasks: string[];
  implements: string[];
  integration_obligations: string[];
  depends_on: number[];
  // The module map's interfaces of the modules of the stages it depends
  // on, from the plan's approved bundle; null when the map could not be
  // read (unknown, never none).
  dependency_interfaces: { stage: number; module: string; name: string; kind: string; path: string | null; description: string }[] | null;
}

export function builderElements(s: BuilderStageFacts | null): Built {
  if (s === null) return {};
  return {
    'builder.tasks': { id: 'builder.tasks', gloss: "Do this stage's tasks, and only them.", data: { stage: s.number, goal: s.goal, tasks: s.tasks } },
    'builder.implements': {
      id: 'builder.implements',
      gloss: "The candidate is judged by the protected checks of these requirements' criteria; their approved texts are in requirements/.",
      data: { implements: s.implements },
    },
    'builder.integration_obligations': { id: 'builder.integration_obligations', gloss: 'What your change must keep or provide for the stages around it.', data: { integration_obligations: s.integration_obligations } },
    'builder.dependency_interfaces': {
      id: 'builder.dependency_interfaces',
      gloss: 'The interfaces the stages you depend on created, which your code uses as they are.',
      data: { depends_on: s.depends_on, interfaces: s.dependency_interfaces },
    },
  };
}
