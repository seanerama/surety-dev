// What the Verifier of `check_correction` work is told about writing the
// project's checks (BS3 §3, "the role packages": the Verifier's package
// names the requirement index's criteria and D3 Appendix B's definition
// reference; E87 item 10's principle that each role's package says what its
// gate reads; SEAM.md §237). Pure: a function of what the store holds of the
// effective protected version, the project and its requirement index.
//
// Everything here is written from the engine's own closed schema and scope
// rule, never copied by hand: a definition's members from
// DEFINITION_REFERENCE (whose keys are the members `parseDefinition`
// accepts), the kinds from KIND_INVENTORY, the gate kinds the engine
// evaluates from SCOPE_KINDS. The example definition is parsed by
// `parseDefinition` against the version's governed values before it is
// shown, and left out if it does not parse.
//
// Never here: a check's content, a program's path, the toolchain's paths
// (`read_paths`, `path`) or the governed `env` values. Programs are named by
// the name a definition uses.

import { DEFINITION_REFERENCE, GOVERNED_FILE, type Governed, KEY_FORM, type TreeEntry, parseDefinition } from './schema.js';
import { KIND_INVENTORY, SCOPE_KINDS, TIER_RANK, type Tier } from './scope.js';
import { seamPackageOmitted } from '../testing/seam.js';

export interface CheckWritingFacts {
  // The effective version's governed values as discovery read them; null
  // when they cannot be read (no effective version, or none recorded).
  governed: Governed | null;
  tier: string;
  modules: { name: string; tier_override: string | null; sensitive_areas: string[] }[];
  // `criteria` null: no index row registered the requirement.
  requirements: { key: string; text: string | null; text_ref: string; criteria: string[] | null; sensitive_areas: string[] }[];
  // The project's stages as the scope rule reads them (D3 §4.2): each
  // stage's number, status and the keys of the requirements it implements.
  // null: the plan could not be read, so which stage implements what is
  // unknown (never "none").
  stages: { number: number; status: string; implements: string[] }[] | null;
  // The project's environments (BS4 §3; SEAM.md §335): each by name, with
  // its current configuration's targets and the secret references its
  // checks may receive. `targets` or `check_secrets` null: not readable, so
  // unknown. The whole list null or absent: not read, so unknown, never
  // "none".
  environments?: { name: string; targets: string[] | null; check_secrets: string[] | null; runtime?: { path: string; sha256: string | null } | null }[] | null;
}

// The gate kinds the engine evaluates (store/transitions/gates.ts,
// COMPUTED_GATES): the scopes of D3 §4.2 and, since M4, `alpha_complete`
// (D4 §5.5), which reads only the environment-bound checks.
export const DEPLOYMENT_GATE = 'alpha_complete';
// The scopes a gate route evaluates: `phase` is the engine's own phase
// step's (plan/phase.ts), reached through no route and needing no listing of
// its own beyond a phase-only check's.
const ROUTE_SCOPES: readonly string[] = SCOPE_KINDS.filter((k) => k !== 'phase');
export const EVALUATED_GATE_KINDS: readonly string[] = Object.freeze([...ROUTE_SCOPES, DEPLOYMENT_GATE]);

const code = (s: string): string => `\`${s}\``;

// The definition members the package's elements state (src/packages/reads.ts:
// verifier.kinds, verifier.covers, verifier.gate_kinds_floor,
// verifier.requires, verifier.secrets), and so not restated here.
const ELEMENT_MEMBERS: readonly string[] = ['kind', 'covers', 'gate_kinds', 'requires', 'secrets'];
const EXAMPLE_ELEMENTS = ['verifier.kinds', 'verifier.covers', 'verifier.gate_kinds_floor', 'verifier.requires', 'verifier.post_deploy'];
const examplesShown = (): boolean => EXAMPLE_ELEMENTS.every((id) => !seamPackageOmitted(id));
const list = (xs: readonly string[]): string => xs.map(code).join(', ');

const reqNumber = (key: string): number => Number(key.slice(1)) || 0;
const critOrder = (a: string, b: string): number => {
  const [ra, ma] = a.slice(1).split('.').map(Number);
  const [rb, mb] = b.slice(1).split('.').map(Number);
  return (ra ?? 0) - (rb ?? 0) || (ma ?? 0) - (mb ?? 0);
};

// One example definition for this project (D3 Appendix B's form): its first
// criterion, its first program, its definitions directory and the evaluated
// gate kinds; null when no valid one can be made (no program, no governed
// values, or the parser refuses it).
export function exampleDefinition(f: CheckWritingFacts): { file: string; program: string; definition: Record<string, unknown> } | null {
  const g = f.governed;
  if (g === null) return null;
  const programs = Object.keys(g.check_commands).sort();
  const name = programs[0];
  if (name === undefined) return null;
  const criteria = f.requirements
    .flatMap((r) => r.criteria ?? [])
    .sort(critOrder);
  const criterion = criteria[0] ?? null;
  const key = criterion === null ? 'smoke' : criterion.toLowerCase().replace('.', '-');
  if (!KEY_FORM.test(key)) return null;
  // The root that holds the definitions directory (one always does).
  const root = g.protected_paths.find((r) => g.check_discovery.definitions.startsWith(r)) ?? g.protected_paths[0];
  if (root === undefined) return null;
  const program = `${root}run/${key}${name === 'node' ? '.mjs' : ''}`;
  const definition: Record<string, unknown> = {
    schema: 1,
    key,
    kind: criterion === null ? 'smoke' : 'acceptance',
    command: [name, program],
    timeout_s: Math.min(120, g.runner_config.direct.timeout_max_s),
    ...(criterion === null ? {} : { covers: { criteria: [criterion] } }),
    gate_kinds: [...ROUTE_SCOPES],
    inputs: [program],
  };
  const file = `${g.check_discovery.definitions}${key}.json`;
  const entries: TreeEntry[] = [{ path: program, type: 'blob', mode: '100644', oid: '0'.repeat(40) }];
  const parsed = parseDefinition(file, key, JSON.stringify(definition), g, entries);
  if (parsed.definition === null || parsed.errors.length > 0) return null;
  return { file, program, definition };
}

// One example of an environment-bound definition (D4 §5.1's form): a
// `post_deploy_behavior` check of the project's first program, listing only
// `alpha_complete` and requiring the environment and the artifact's digest;
// null when no valid one can be made (the parser refuses it).
export function examplePostDeployDefinition(f: CheckWritingFacts): { file: string; program: string; definition: Record<string, unknown> } | null {
  const g = f.governed;
  if (g === null) return null;
  const name = Object.keys(g.check_commands).sort()[0];
  if (name === undefined) return null;
  const root = g.protected_paths.find((r) => g.check_discovery.definitions.startsWith(r)) ?? g.protected_paths[0];
  if (root === undefined) return null;
  const key = 'user-operation';
  const program = `${root}post-deploy/${key}${name === 'node' ? '.mjs' : ''}`;
  const definition: Record<string, unknown> = {
    schema: 1,
    key,
    kind: 'post_deploy_behavior',
    command: [name, program],
    timeout_s: Math.min(60, g.runner_config.direct.timeout_max_s),
    gate_kinds: [DEPLOYMENT_GATE],
    requires: ['environment', 'artifact_digest'],
    inputs: [program],
  };
  const file = `${g.check_discovery.definitions}${key}.json`;
  const entries: TreeEntry[] = [{ path: program, type: 'blob', mode: '100644', oid: '0'.repeat(40) }];
  const parsed = parseDefinition(file, key, JSON.stringify(definition), g, entries);
  if (parsed.definition === null || parsed.errors.length > 0) return null;
  return { file, program, definition };
}

// What the Verifier is told about environment-bound checks (D4 §§5.1, 5.2,
// 5.4, 7.2; J4; BS4 §3; SEAM.md §335): the kinds, that `alpha_complete`
// needs a required `post_deploy_behavior` check, how a definition of one is
// written, where it runs, how it reaches its target and its secrets, and the
// project's environments with their targets' variables.
export function deploymentChecksText(f: Pick<CheckWritingFacts, 'environments'> & Partial<Pick<CheckWritingFacts, 'tier'>>): string[] {
  // The kinds, the gate, `requires`, `secrets`, the target's variable and
  // each environment's targets and secret references are the package's
  // elements (`verifier.post_deploy`, `verifier.requires`,
  // `verifier.secrets`; src/packages/reads.ts): stated there only.
  const out: string[] = [
    '',
    '### Checks against a deployed environment',
    '',
    "- When the owner deploys a candidate to one of the project's environments, the engine verifies the running service with its environment-bound checks; without the required one nothing is deployed and no candidate becomes `alpha_deployed`.",
    "- That check must be required: when the governed file lists `required_checks`, only the checks named there are required, so its key must be among them, which only the owner can add (say so in your summary); when it lists none, every check discovered is required.",
    '- It runs only in a deployment\'s verification, between two reads the engine makes of the running service itself; from any other trigger it is recorded not run (`environment_unbound`). Write it to pass against the service the requirements describe.',
    "- Its sandbox holds its protected inputs and none of the candidate's source: it judges the service from outside, through the target's address. Name no `egress` on it, so that it reaches its environment's targets and nothing else. The service's answers are untrusted input to the check.",
    "- Exercise a user operation the requirements specify (a request and the answer it must give), not only that the service answers: a check that only probes that the service is up passes for a service that does the wrong thing. Never write a secret's value into a check.",
  ];
  const envs = f.environments;
  if (envs === undefined || envs === null) out.push("- Which environments the project has could not be read here, so their target names are unknown: write no environment-bound check, and say so in your summary.");
  else if (envs.length === 0) out.push("- No environment is configured for this project yet, so the target's name is unknown: write no environment-bound check, and say so in your summary.");
  else for (const e of envs) if (e.targets === null) out.push(`- Environment ${code(e.name)}: it has no configuration this package could read, so its targets are unknown; write no environment-bound check for it, and say so in your summary.`);
  return out;
}

// When a check is required, as the one scope rule decides it (D3 §4.2;
// src/checks/scope.ts): a check covering no criterion joins every scope of
// a gate kind it lists; a check naming criteria joins a `stage` scope only
// when the stage implements their requirement, and the Alpha scope once the
// requirement is delivered. Then the project's plan, from the store: which
// stage implements which requirement, and which no stage implements yet.
export function scopeRuleText(f: Pick<CheckWritingFacts, 'stages' | 'requirements'>): string[] {
  const out: string[] = [
    '',
    '### Which gates require a check',
    '',
    "- A check that covers no criterion (a `smoke` check, say) and lists `stage` in its `gate_kinds` is required at every stage's gate, from the first stage on.",
    "- Such a check must therefore pass on the first stage's candidate, before later stages' code exists: it must not require code that no stage has delivered yet. Keep it to what exists from the first stage on, and put each requirement's behaviour in a check naming that requirement's criteria.",
    "- A check that names criteria is required at a stage's gate only when that stage implements the criteria's requirement; at the `alpha_authorize` gate, only once the requirement is delivered (every stage implementing it integrated).",
  ];
  const known = f.stages ?? null;
  if (known === null) {
    out.push("- The project's stage plan could not be read, so which stage implements which requirement is unknown here; write each check against its own requirement's code only, and say in your summary that the plan was unknown.");
    return out;
  }
  const stages = [...known].sort((a, b) => a.number - b.number);
  if (stages.length === 0) out.push('- The project has no stage planned yet.');
  for (const s of stages) {
    out.push(
      s.implements.length > 0
        ? `- Stage ${s.number} implements ${s.implements.join(', ')} (${s.status}).`
        : `- Stage ${s.number} implements no requirement (${s.status}).`,
    );
  }
  const planned = new Set(stages.flatMap((s) => s.implements));
  const unplanned = f.requirements.map((r) => r.key).filter((k) => !planned.has(k)).sort((a, b) => reqNumber(a) - reqNumber(b) || a.localeCompare(b));
  if (unplanned.length > 0) {
    out.push(
      `- No stage implements ${unplanned.join(', ')} yet. A check naming ${unplanned.length === 1 ? 'its' : 'their'} criteria is required at no stage's gate until a stage implements ${unplanned.length === 1 ? 'it' : 'them'}, and the code ${unplanned.length === 1 ? 'it names' : 'they name'} may not exist in a candidate yet.`,
    );
  }
  return out;
}

const higher = (t: string | null, than: string): boolean => (TIER_RANK[t ?? ''] ?? 0) > (TIER_RANK[than] ?? 0);

// The section of the prompt, as lines. `checkList`: the lines naming the
// checks in force (the same list every reporting role is given, E87).
// `authoring`: a phase's check authoring (D6 §6.2), whose first phase names
// the toolchain in the governed file (the element `verifier.toolchain`);
// the correction Verifier changes no governed value (D3).
export function checkWritingText(f: CheckWritingFacts, checkList: readonly string[], opts: { authoring?: boolean } = {}): string[] {
  const g = f.governed;
  const out: string[] = ['', "## Writing the project's checks", ''];
  out.push(
    "Your work is the project's protected checks: write or correct them so that every criterion of the requirements below is shown met by a check the engine runs. The engine discovers the checks from the files you leave under the protected roots, the change is classified and decided on, and once it is applied the engine runs the checks on every candidate. A gate is satisfied only on their results.",
    '',
    // The driver's ruling on loop run 1 (runs/accept.ts proposedCheckRefusal).
    "A finding you report may name, in `check`, a check this result's proposal adds: the reference is bound when the proposal is applied; if the proposal is rejected, or the applied version does not have that check, the finding stands with no check. A key that is neither a check of the project nor one your proposal adds makes the result invalid.",
  );
  if (g === null) {
    out.push(
      '',
      "The governed values of the project's effective protected version could not be read, so its roots, definitions directory and programs are unknown here. Change nothing; say so in your summary.",
    );
    return out;
  }
  const roots = g.protected_paths;
  out.push(
    '',
    '### Where',
    '',
    `- The protected roots: ${list(roots)}. Change files only under them: a run that changes anything else, the project's source included, is rejected whole.`,
    opts.authoring
      ? `- The governed file ${code(GOVERNED_FILE)}: change only the toolchain this authoring names; every change to it is classified \`unclassifiable\` and waits for the owner.`
      : `- The governed file ${code(GOVERNED_FILE)}: do not change it. Its programs, toolchain, network and output bounds are the owner's; a change to it is classified \`unclassifiable\` and waits for the owner.`,
    `- The definitions directory ${code(g.check_discovery.definitions)}: one JSON file per check, named \`<key>.json\`, and nothing else.`,
    `- Everything else under a root is the checks' own code, expectations and fixtures, in a layout you choose (for example ${code(`${roots[0]}run/`)}).`,
  );
  const programs = Object.keys(g.check_commands).sort();
  out.push('', '### Programs', '');
  if (programs.length === 0 && opts.authoring) {
    out.push("- The governed file names no program yet: the definitions you write run the programs of the toolchain this authoring names, by their names.");
  } else if (programs.length === 0) {
    out.push(
      "- The governed file names no program, so no definition can be valid and no check can run until the owner approves one. Write no definition; say so in your summary.",
    );
  } else {
    out.push(
      `- A definition's command runs one of these programs, named as the command's first string: ${list(programs)}. Name the program, never a path; no other program can be run.`,
    );
  }
  out.push(
    `- A check's \`timeout_s\` is at most ${g.runner_config.direct.timeout_max_s} seconds.`,
    g.runner_config.direct.egress_allow.length === 0
      ? '- A check has no network: the governed file allows no host.'
      : `- A check has no network unless its \`egress\` names hosts from these: ${list(g.runner_config.direct.egress_allow)}.`,
    `- A check's output is recorded up to ${g.result_collection.output_max_bytes} bytes.`,
  );
  // The requirements and their criteria (D3 §4.5).
  out.push('', '### What the checks must cover', '');
  const requirements = [...f.requirements].sort((a, b) => reqNumber(a.key) - reqNumber(b.key) || a.key.localeCompare(b.key));
  if (requirements.length === 0) {
    out.push('- The project has no registered requirement: a check can name no criterion, so a check of a covering kind cannot be valid. Say so in your summary.');
  }
  for (const r of requirements) {
    // A requirement no index row registered: its criteria and its areas are
    // unknown (its areas column holds only the default), never "none".
    const crit =
      r.criteria === null
        ? 'not in the requirement index: its criteria and sensitive areas are not registered, so they are unknown and no check can name a criterion of it'
        : r.criteria.length === 0
          ? 'no criterion'
          : `criteria ${list([...r.criteria].sort(critOrder))}`;
    const areas = r.criteria !== null && r.sensitive_areas.length > 0 ? `; sensitive areas ${list(r.sensitive_areas)}` : '';
    out.push(`- ${r.key}: ${crit}${areas}. Its approved text (also in /surety/context/requirements/):`);
    const text = r.text ?? `(the text is not in the store; it is referenced as ${r.text_ref})`;
    out.push(...text.split('\n').map((line) => `  > ${line}`));
  }
  // Which kinds cover criteria, the tier's kinds and the gate kinds are the
  // package's elements (src/packages/reads.ts), stated there only.
  out.push('', '- Name each criterion exactly as listed.');
  for (const m of [...f.modules].sort((a, b) => a.name.localeCompare(b.name))) {
    if (higher(m.tier_override, f.tier)) {
      const t = m.tier_override as Tier;
      out.push(`- The module ${code(m.name)} raises a scope that includes it to ${t}, which requires each of these kinds: ${list(KIND_INVENTORY[t])}.`);
    }
  }
  const indexed = f.requirements.filter((r) => r.criteria !== null);
  const unindexed = f.requirements.filter((r) => r.criteria === null).map((r) => r.key);
  const areas = [...new Set([...indexed.flatMap((r) => r.sensitive_areas), ...f.modules.flatMap((m) => m.sensitive_areas)])].sort();
  if (areas.length > 0) {
    out.push(`- For each sensitive area named, one required \`sensitivity_floor\` check naming it in \`"covers": {"sensitive_areas": [...]}\`, with no \`tier_floor\`: ${list(areas)}.`);
  } else if (unindexed.length === 0) {
    out.push('- No requirement or module names a sensitive area, so no `sensitivity_floor` check is required.');
  }
  if (unindexed.length > 0) {
    out.push(
      `- The sensitive areas of ${unindexed.join(', ')} are not registered (no requirement index row), so whether a \`sensitivity_floor\` check is required for ${unindexed.length === 1 ? 'it' : 'them'} is unknown; say so in your summary.`,
    );
  }
  out.push(
    `- A check listing ${code('phase')} alone in its gate kinds is a phase-only check: it is registered and run when the phase completes, on the phase's candidate, never at a stage's nomination; every required check of a stage's gate also runs then, as the phase's regression set.`,
    g.required_checks === null
      ? '- Every check discovered is required: the governed file lists no `required_checks`.'
      : `- Only the checks the governed file's \`required_checks\` lists are required: ${g.required_checks.length > 0 ? list(g.required_checks) : 'none'}. A check you add is not required unless the owner lists it.`,
  );
  out.push(...scopeRuleText(f));
  out.push(
    '',
    '### How a check runs',
    '',
    "- The engine runs the command in a sandbox, at the candidate's source with the protected roots replaced by the check's declared inputs (the candidate's own copy of the protected files is never seen), from its `cwd` relative to the repository's root.",
    "- The verdict is the exit status of the command's own process: 0 passes, anything else fails. Make the command exit nonzero on every condition the check cares about, a skipped or empty test run and a child's failure included.",
    "- Run the candidate's code as a child process and judge what it observably does (its output and exit status), so that candidate code that ends the process early cannot pass the check.",
    '- The protected inputs are read-only; anything the check writes is discarded when it ends; nothing but its exit status and its output is kept.',
  );
  out.push(...deploymentChecksText(f));
  out.push('', "### A definition's members (D3 Appendix B)", '', `A definition is one JSON object with only these members, and ${ELEMENT_MEMBERS.map((m) => code(`"${m}"`)).join(', ')} as the sections on what the engine reads state them:`);
  for (const [name, m] of Object.entries(DEFINITION_REFERENCE)) if (!ELEMENT_MEMBERS.includes(name)) out.push(`- \`"${name}"\` (${m.required}): ${m.form}`);
  // The examples combine members those sections state: shown only while
  // every one of them is stated, so that an omission leaves no example
  // standing in for the element (row M442 (b)).
  const example = examplesShown() ? exampleDefinition(f) : null;
  if (example) {
    out.push(
      '',
      `For example, ${code(example.file)}, which runs ${code(example.program)}, a program you write under the roots:`,
      '',
      '```json',
      JSON.stringify(example.definition, null, 2),
      '```',
    );
  }
  const postDeploy = examplesShown() ? examplePostDeployDefinition(f) : null;
  if (postDeploy) {
    out.push(
      '',
      `An environment-bound check, for example ${code(postDeploy.file)}, which runs ${code(postDeploy.program)} against the deployed service through its target's variable:`,
      '',
      '```json',
      JSON.stringify(postDeploy.definition, null, 2),
      '```',
    );
  }
  out.push('', '### The checks in force', '', ...(checkList.length > 0 ? checkList : ['(none listed)']));
  out.push(
    '',
    '### Your result',
    '',
    "- Give the `proposal` in your result: its `rationale` (what you changed and why) and `requested_change_kind`: `tightening` when you only add checks or criteria, `loosening` when you remove or weaken any, `unclassifiable` otherwise.",
  );
  return out;
}

// ---- the phase-authoring package (D6 §6.2; N04, B07, B13; SEAM.md §428) ------------------

// What a phase's `check_authoring` Verifier is given beside the check-writing
// facts (store/reads.ts authoringFacts).
export interface PhaseAuthoringFacts {
  phase_plan: { id: string; phase_number: number; generation: number } | null;
  stages: { number: number; goal: string; modules: string[]; implements: string[]; depends_on: unknown[]; validation: unknown }[];
  interfaces: { module: string; name: string; kind: string; path: string | null; description: string }[] | null;
  architecture: string | null;
  environments: { name: string; fields: Record<string, string> }[] | null;
  follow_up?: { obligation: string; criteria: string[]; reason: string | null; prerequisite: unknown; stages: { number: number; status: string }[] } | null;
  // A gap follow-up's: per stage, what its gate scope lacks.
  gaps?: { stage: number; kinds: string[]; criteria: string[]; areas: string[] }[] | null;
}

// The authoring result's own fields (B.7), beside the Verifier's: its
// governed-change permissions and its deferrals.
export const AUTHORING_RESULT_FIELDS: Record<string, Record<string, unknown>> = {
  governed_changes: {
    type: 'object',
    description:
      "The governed changes your proposal declares: whether it names the toolchain in the governed file's `check_commands` (the first phase's authoring must), and the check programs it adds. A declaration: the class of the change is the classifier's, and a change to `check_commands` goes to the owner.",
    additionalProperties: false,
    properties: { check_commands: { type: 'boolean' }, programs: { type: 'array', items: { type: 'string' } } },
  },
  deferred_criteria: {
    type: 'array',
    description:
      'A criterion of this phase (one its stages validate) whose check you cannot write yet, because the interface it exercises does not exist: its reason and its prerequisite, a stage of this plan by number or an interface of the module map by name. A criterion this phase does not owe is never deferred: its checks are authored with the phase that owes it, and a result deferring it is refused. The engine records an obligation for each and asks for its checks again, once, when the prerequisite integrates; until they exist and pass, the phase and deployment gates name it (AUTHORING_INCOMPLETE).',
    items: {
      type: 'object',
      required: ['criterion', 'reason', 'prerequisite'],
      additionalProperties: false,
      properties: {
        criterion: { type: 'string' },
        reason: { type: 'string' },
        prerequisite: {
          oneOf: [
            { type: 'object', required: ['stage'], additionalProperties: false, properties: { stage: { type: 'integer', minimum: 1 } } },
            { type: 'object', required: ['interface'], additionalProperties: false, properties: { interface: { type: 'string' } } },
          ],
        },
      },
    },
  },
};

export function phaseAuthoringText(a: PhaseAuthoringFacts): string[] {
  const out: string[] = ['', "## The phase's check authoring", ''];
  // A gap follow-up (the driver's ruling C on the real M443 run): the
  // stages' gates lack checks no one was asked to write.
  if (a.gaps && a.gaps.length > 0) {
    out.push(
      `You author the protected checks that ${a.phase_plan ? `phase ${a.phase_plan.phase_number} (plan ${a.phase_plan.id}, generation ${a.phase_plan.generation})` : 'the phase'} still lacks. Each stage's gate takes only the checks of its own scope (the requirements it implements and its modules), and for these stages the applied checks do not provide what the gate needs: a check of each kind named, covering the stage's requirements, and a check covering each criterion named. Write them against the code as it is; the other checks of the phase are already applied.`,
      '',
      '### What each stage lacks',
      '',
      '```json',
      JSON.stringify(a.gaps, null, 2),
      '```',
    );
    out.push('', "### The plan's stages", '', 'Each stage, with the requirements it `implements` and its `validation`:', '', '```json', JSON.stringify(a.stages, null, 2), '```');
    return out;
  }
  // A deferral's follow-up (the slice-37 review's M6): what it is asked for,
  // and the stages as they stand, not the first authoring's account.
  if (a.follow_up) {
    const f = a.follow_up;
    out.push(
      f.criteria.length > 0
        ? `You author the checks a deferral left owed in ${a.phase_plan ? `phase ${a.phase_plan.phase_number} (plan ${a.phase_plan.id}, generation ${a.phase_plan.generation})` : 'the phase'}: obligation ${f.obligation}, for ${f.criteria.join(', ')}. It was deferred because ${f.reason ?? 'of a reason not recorded'}; its prerequisite (${JSON.stringify(f.prerequisite)}) has integrated, so the interface it exercises now exists in the code. Builders of this phase have run: the stages as they stand now are below. Write the checks for these criteria against the code as it is; the other checks of the phase are already applied.`
        : `You author the protected checks of ${a.phase_plan ? `phase ${a.phase_plan.phase_number} (plan ${a.phase_plan.id}, generation ${a.phase_plan.generation})` : 'the phase'}, owed by obligation ${f.obligation}: ${f.reason ?? 'the authoring was not done before the build'}. Its Builders have run and their stages have integrated: the stages as they stand now are below. Write a definition and a program for every criterion the stages validate, the kinds of each stage's tier and the areas of the sensitivity floor, against the code as it is; until they are applied and pass, the phase and deployment gates carry AUTHORING_INCOMPLETE.`,
      '',
      '### The stages now',
      '',
      '```json',
      JSON.stringify(f.stages, null, 2),
      '```',
    );
    out.push('', "### The plan's stages", '', 'Each stage, with the requirements it `implements` and its `validation`:', '', '```json', JSON.stringify(a.stages, null, 2), '```');
    return out;
  }
  out.push(
    `You author the protected checks of ${a.phase_plan ? `phase ${a.phase_plan.phase_number} (plan ${a.phase_plan.id}, generation ${a.phase_plan.generation})` : 'the phase'} before any of its stages is built: a definition and a program for every criterion its stages validate, the kinds of each stage's tier, the areas of the sensitivity floor, and, in the first phase, the post-deploy checks of the environments below. No Builder of the phase runs until your checks are applied (authoring readiness), so write them against the interfaces the stages will create, named below.`,
    '',
    'Write checks only for the criteria this phase owes, the ones its stages validate. A criterion of a later phase (an interface of the module map no stage of this plan creates, say) is authored with that phase: write no check for it here and do not list it in deferred_criteria.',
    '',
    'A later phase adds checks under new declared inputs; a check whose inputs name a directory, or cover the whole protected tree, changes with any addition under it, and the classifier then sends the addition to the owner. Declare each check\'s `inputs` file by file: its program and the shared helpers it imports.',
  );
  out.push('', "### The plan's stages", '', 'Each stage, with the requirements it `implements` and its `validation` (the criteria, kinds and areas its checks must cover):', '', '```json', JSON.stringify(a.stages, null, 2), '```');
  out.push('', "### The module map's interfaces", '');
  if (a.interfaces === null) out.push("The module map of the plan's approved bundle could not be read, so its interfaces are unknown here; say so in your summary.");
  else if (a.interfaces.length === 0) out.push('The module map names no interface.');
  else for (const i of a.interfaces) out.push(`- \`${i.name}\` (${i.kind}) of module \`${i.module}\`${i.path ? ` at \`${i.path}\`` : ''}: ${i.description}`);
  out.push('', "### The architecture", '');
  out.push(a.architecture ?? "The architecture's text could not be read; say so in your summary.");
  out.push('', '### The environments', '');
  if (a.environments === null) out.push("The approved specification's environments could not be read; say so in your summary.");
  else if (a.environments.length === 0) out.push('The approved specification names no environment.');
  else for (const e of a.environments) out.push(`- \`${e.name}\`: ${Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
  out.push(
    '',
    '### Your result',
    '',
    'Your result follows /surety/context/result-schema.json. /surety/context/authoring.json holds this section\'s facts.',
  );
  return out;
}
