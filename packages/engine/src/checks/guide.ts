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

import { DEFINITION_REFERENCE, GATE_KINDS, GOVERNED_FILE, type Governed, KEY_FORM, POST_DEPLOY, type TreeEntry, parseDefinition } from './schema.js';
import { KIND_INVENTORY, SCOPE_KINDS, TIER_RANK, type Tier } from './scope.js';
import { checkSecretVariable, targetVariable } from './variables.js';

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
  environments?: { name: string; targets: string[] | null; check_secrets: string[] | null }[] | null;
}

// The gate kinds the engine evaluates (store/transitions/gates.ts,
// COMPUTED_GATES): the scopes of D3 §4.2 and, since M4, `alpha_complete`
// (D4 §5.5), which reads only the environment-bound checks.
export const DEPLOYMENT_GATE = 'alpha_complete';
export const EVALUATED_GATE_KINDS: readonly string[] = Object.freeze([...SCOPE_KINDS, DEPLOYMENT_GATE]);

const code = (s: string): string => `\`${s}\``;
const list = (xs: readonly string[]): string => xs.map(code).join(', ');
const andList = (xs: readonly string[]): string => (xs.length <= 1 ? list(xs) : `${list(xs.slice(0, -1))} and ${code(xs[xs.length - 1]!)}`);
const jsonList = (xs: readonly string[]): string => `[${xs.map((x) => `"${x}"`).join(', ')}]`;

// The tier's kind floor at the `alpha_authorize` gate (D3 §4.3;
// src/checks/scope.ts, computeScope): KIND_INVENTORY[tier] is applied at
// each of SCOPE_KINDS separately, over the required checks listing that gate
// kind, so a deployment request's gate needs a required acceptance-origin
// check of each floor kind listing `alpha_authorize` in its `gate_kinds`.
// Sean's real run of M342 (E135): the Verifier's smoke check listed `stage`
// only, and the deployment was refused `ACCEPTANCE_SCOPE_INCOMPLETE`
// (`kind:smoke`); the package had never said so. The project's tier names
// its floor when known; otherwise every tier's.
export const AUTHORIZE_GATE = SCOPE_KINDS.find((k) => k !== 'stage')!;
export function authorizeFloorText(tier: string | undefined): string {
  const known = tier !== undefined && Object.hasOwn(KIND_INVENTORY, tier) ? (tier as Tier) : null;
  const floor =
    known === null
      ? `at least one required acceptance-origin check of each kind the project's tier requires (${(Object.keys(KIND_INVENTORY) as Tier[]).map((t) => `${t}: ${list(KIND_INVENTORY[t])}`).join('; ')})`
      : `at ${known}, at least one required acceptance-origin check of each of the kinds ${list(KIND_INVENTORY[known])}`;
  const exampleKind = (known === null ? KIND_INVENTORY.T1 : KIND_INVENTORY[known]).find((k) => k === 'smoke') ?? KIND_INVENTORY.T1[0]!;
  return (
    `The tier's kind floor is applied at each of ${andList(SCOPE_KINDS)} separately, over the checks listing that gate kind in their \`gate_kinds\`. ` +
    `${code(AUTHORIZE_GATE)}, the gate a deployment request evaluates, therefore needs ${floor}, each listing ${code(AUTHORIZE_GATE)} in its \`gate_kinds\`; ` +
    `a check of a floor kind listing only ${code('stage')} supplies its kind to no deployment, and the request is refused with \`ACCEPTANCE_SCOPE_INCOMPLETE\` naming the kind missing (\`kind:${exampleKind}\`). ` +
    `So a ${code(exampleKind)} check lists \`"gate_kinds": ${jsonList(SCOPE_KINDS)}\`, and so does every other check of a floor kind.`
  );
}
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
    gate_kinds: [...SCOPE_KINDS],
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
  const [identity, behavior] = [POST_DEPLOY.find((k) => k.endsWith('identity'))!, POST_DEPLOY.find((k) => k.endsWith('behavior'))!];
  const out: string[] = [
    '',
    '### Checks against a deployed environment',
    '',
    `- When the owner deploys a candidate to one of the project's environments, the engine verifies the running service with the environment-bound checks: kind ${code(behavior)} (what the service does for its user) and kind ${code(identity)}.`,
    `- The ${code(DEPLOYMENT_GATE)} gate needs at least one required ${code(behavior)} check, and ${code('alpha_authorize')} is not satisfied without one either, so without it nothing is deployed and no candidate becomes \`alpha_deployed\`.`,
    `- A deployment request is refused unless ${code(AUTHORIZE_GATE)} is satisfied, and that gate also applies the tier's kind floor to the checks listing it. ${authorizeFloorText(f.tier)}`,
    "- The `post_deploy_behavior` check must be required: when the governed file lists `required_checks`, only the checks named there are required, so its key must be among them, which only the owner can add (say so in your summary); when it lists none, every check discovered is required.",
    `- Write such a check with \`"gate_kinds": ["${DEPLOYMENT_GATE}"]\` and no other gate kind, and with \`"requires": ["environment", "artifact_digest"]\`. Listed under \`stage\` or \`alpha_authorize\`, it would be required at a gate where it can never run, and that gate would never be satisfied. Give it no \`covers\`: on these kinds discovery refuses it (\`covers_not_allowed\`), and a discovery error leaves every gate of the version unsatisfied.`,
    "- It runs only in a deployment's verification, between two reads the engine makes of the running service itself; from any other trigger it is recorded not run (`environment_unbound`). Write it to pass against the service the requirements describe.",
    '- Its sandbox holds its protected inputs and none of the candidate\'s source: it judges the service from outside, through the target\'s address. Name no `egress` on it, so that it reaches its environment\'s targets and nothing else.',
    `- How it reaches its target: the engine gives it, for each target of the environment, the variable \`SURETY_TARGET_<NAME>\` set to \`http://127.0.0.1:<port>\`, where \`<NAME>\` is the target's name in upper case with any character but a letter or a digit as \`_\`. The service's answers are untrusted input to the check.`,
    "- Exercise a user operation the requirements specify (a request and the answer it must give), not only that the service answers: a check that only probes that the service is up passes for a service that does the wrong thing.",
    `- Secrets: a definition's \`"secrets"\` names deployment secret references (\`deploy/<name>\`) that the environment allows its checks (its \`check_secrets\`); each is given to the check as \`SURETY_SECRET_<NAME>\`. Never write a secret's value into a check.`,
  ];
  const envs = f.environments;
  if (envs === undefined || envs === null) {
    out.push("- Which environments the project has could not be read here, so their target names are unknown: write no environment-bound check, and say so in your summary.");
    return out;
  }
  if (envs.length === 0) {
    out.push("- No environment is configured for this project yet, so the target's name is unknown: write no environment-bound check, and say so in your summary.");
    return out;
  }
  for (const e of envs) {
    if (e.targets === null) {
      out.push(`- Environment ${code(e.name)}: it has no configuration this package could read, so its targets are unknown; write no environment-bound check for it, and say so in your summary.`);
      continue;
    }
    const targets = e.targets.length > 0 ? e.targets.map((t) => `target ${code(t)}, reached as ${code(targetVariable(t))}`).join('; ') : 'no target';
    const secrets =
      e.check_secrets === null
        ? 'which secrets its checks may receive could not be read, so name none'
        : e.check_secrets.length > 0
          ? `its checks may receive ${e.check_secrets.map((r) => `${code(r)} (as ${code(checkSecretVariable(r))})`).join(', ')}`
          : 'its checks may receive no secret';
    out.push(`- Environment ${code(e.name)}: ${targets}; ${secrets}.`);
  }
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
export function checkWritingText(f: CheckWritingFacts, checkList: readonly string[]): string[] {
  const g = f.governed;
  const out: string[] = ['', "## Writing the project's checks", ''];
  out.push(
    "Your work is the project's protected checks: write or correct them so that every criterion of the requirements below is shown met by a check the engine runs. The engine discovers the checks from the files you leave under the protected roots, the change is classified and decided on, and once it is applied the engine runs the checks on every candidate. A gate is satisfied only on their results.",
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
    `- The governed file ${code(GOVERNED_FILE)}: do not change it. Its programs, toolchain, network and output bounds are the owner's; a change to it is classified \`unclassifiable\` and waits for the owner.`,
    `- The definitions directory ${code(g.check_discovery.definitions)}: one JSON file per check, named \`<key>.json\`, and nothing else.`,
    `- Everything else under a root is the checks' own code, expectations and fixtures, in a layout you choose (for example ${code(`${roots[0]}run/`)}).`,
  );
  const programs = Object.keys(g.check_commands).sort();
  out.push('', '### Programs', '');
  if (programs.length === 0) {
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
  out.push(
    '',
    '- Every criterion needs at least one required check of origin `acceptance` naming it in `"covers": {"criteria": [...]}`, of a kind that covers criteria (`acceptance`, `integration`, `property`, `failure_recovery`). Name each criterion exactly as listed.',
  );
  // The kinds the scope's tier requires (D3 §4.3).
  const tier = (Object.hasOwn(KIND_INVENTORY, f.tier) ? f.tier : 'T1') as Tier;
  out.push(
    `- The project's tier is ${f.tier}: every scope requires at least one required acceptance-origin check of each of these kinds: ${list(KIND_INVENTORY[tier])}.`,
  );
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
    `- Gate kinds: the engine evaluates ${andList(EVALUATED_GATE_KINDS)}. A check joins the required set of each gate kind its \`gate_kinds\` lists; list both ${andList(SCOPE_KINDS)} for a check of the workspace that should decide both. ${code(DEPLOYMENT_GATE)} reads only the environment-bound checks (below). The others (${list(GATE_KINDS.filter((k) => !EVALUATED_GATE_KINDS.includes(k)))}) are accepted but not evaluated.`,
    `- ${authorizeFloorText(f.tier)}`,
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
  out.push('', "### A definition's members (D3 Appendix B)", '', 'A definition is one JSON object with only these members:');
  for (const [name, m] of Object.entries(DEFINITION_REFERENCE)) out.push(`- \`"${name}"\` (${m.required}): ${m.form}`);
  const example = exampleDefinition(f);
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
  const postDeploy = examplePostDeployDefinition(f);
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
