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

import { DEFINITION_REFERENCE, GATE_KINDS, GOVERNED_FILE, type Governed, KEY_FORM, type TreeEntry, parseDefinition } from './schema.js';
import { KIND_INVENTORY, SCOPE_KINDS, TIER_RANK, type Tier } from './scope.js';

export interface CheckWritingFacts {
  // The effective version's governed values as discovery read them; null
  // when they cannot be read (no effective version, or none recorded).
  governed: Governed | null;
  tier: string;
  modules: { name: string; tier_override: string | null; sensitive_areas: string[] }[];
  // `criteria` null: no index row registered the requirement.
  requirements: { key: string; text: string | null; text_ref: string; criteria: string[] | null; sensitive_areas: string[] }[];
}

const code = (s: string): string => `\`${s}\``;
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
    gate_kinds: [...SCOPE_KINDS],
    inputs: [program],
  };
  const file = `${g.check_discovery.definitions}${key}.json`;
  const entries: TreeEntry[] = [{ path: program, type: 'blob', mode: '100644', oid: '0'.repeat(40) }];
  const parsed = parseDefinition(file, key, JSON.stringify(definition), g, entries);
  if (parsed.definition === null || parsed.errors.length > 0) return null;
  return { file, program, definition };
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
    `- Gate kinds: the engine evaluates ${list(SCOPE_KINDS)}. A check joins the required set of each gate kind its \`gate_kinds\` lists; list both for a check that should decide both. The others (${list(GATE_KINDS.filter((k) => !(SCOPE_KINDS as readonly string[]).includes(k)))}) are accepted but not evaluated.`,
    g.required_checks === null
      ? '- Every check discovered is required: the governed file lists no `required_checks`.'
      : `- Only the checks the governed file's \`required_checks\` lists are required: ${g.required_checks.length > 0 ? list(g.required_checks) : 'none'}. A check you add is not required unless the owner lists it.`,
  );
  out.push(
    '',
    '### How a check runs',
    '',
    "- The engine runs the command in a sandbox, at the candidate's source with the protected roots replaced by the check's declared inputs (the candidate's own copy of the protected files is never seen), from its `cwd` relative to the repository's root.",
    "- The verdict is the exit status of the command's own process: 0 passes, anything else fails. Make the command exit nonzero on every condition the check cares about, a skipped or empty test run and a child's failure included.",
    "- Run the candidate's code as a child process and judge what it observably does (its output and exit status), so that candidate code that ends the process early cannot pass the check.",
    '- The protected inputs are read-only; anything the check writes is discarded when it ends; nothing but its exit status and its output is kept.',
  );
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
  out.push('', '### The checks in force', '', ...(checkList.length > 0 ? checkList : ['(none listed)']));
  out.push(
    '',
    '### Your result',
    '',
    "- Give the `proposal` in your result: its `rationale` (what you changed and why) and `requested_change_kind`: `tightening` when you only add checks or criteria, `loosening` when you remove or weaken any, `unclassifiable` otherwise.",
  );
  return out;
}
