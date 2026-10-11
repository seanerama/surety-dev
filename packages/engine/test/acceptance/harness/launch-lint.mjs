// Source inspection for the invocation boundary (row M74; D1 §15.4: "a
// repository lint test fails on any spawn of a backend binary outside
// engine/invoke/"; SEAM.md §95). Like source-lint.mjs it reads TypeScript as
// text, with that file's lexer, so what it sees is lexical.
//
// The rule. A file under packages/engine/src/ may name a module that can
// start a process only if it is in one of three places:
//   - `invoke/`, the choke point, where a backend is launched, and with D2
//     the launcher (`unshare`, `setpriv`, `ip`) and the domain init;
//   - `git/exec.ts`, the one file that runs git;
//   - `testing/`, the seam folder, whose harness-only code runs the scripted
//     notification sink and kills the engine at a barrier;
// and, since M2 slice 10 (row M109 (c); D2 §3.1; M2 build spec §5), in the
// boundary's own helper modules named in D2_HELPERS, each one file that
// starts one host tool the engine checks for and never a backend. The
// Builder names a helper; the Verifier adds it here (SEAM.md §121). Since
// M4 slice 24 (BS4 §5), also in the one deployment adapter file named in
// D4_ADAPTERS, for `systemd-run` and `systemctl` only.
// "Naming" is any string or template literal that is such a module's name,
// wherever it stands: a static import, `import()`, `require()`, a re-export,
// `process.getBuiltinModule()`. One use is allowed everywhere: a static
// import that binds types only, which starts nothing.
//
// What a clean result proves: outside those three places no file imports,
// requires, loads or re-exports the process-starting modules by name.
// What it does not prove: anything about a module name assembled at run
// time; that `git/exec.ts` runs nothing but git; that code inside `invoke/`
// launches only through the choke function; anything about `dist/`.

import { moduleRefs, tokenize } from './source-lint.mjs';

// Modules, and internal bindings, through which a Node process starts another.
export const PROCESS_MODULES = ['child_process', 'node:child_process', 'cluster', 'node:cluster', 'spawn_sync', 'process_wrap'];

// The boundary's helper modules outside invoke/ that may start a process
// (M2 slice 10, row M109 (c)): one file per helper, with the host tool it
// runs. `boundary/scope.ts` is the build spec's starting name for the
// incarnation scope (§7: `src/boundary/`); a Builder who arranges the
// modules otherwise names the file and the Verifier changes this list.
// M2 slice 11 (SEAM.md §124): the engine enters its scope in place, so the
// scope's helper asks the user manager through `busctl` (StartTransientUnit
// with PIDs) instead of `systemd-run`, which runs a command, and reads the
// manager's view of the scope with `systemctl --user`; the same one file
// runs both, and nothing else outside invoke/ starts a process.
export const D2_HELPERS = [
  { where: 'boundary/scope.ts', why: 'the incarnation scope: busctl --user (StartTransientUnit with PIDs) at start (D2 §3.1; SEAM.md §124)', tool: 'busctl' },
  { where: 'boundary/scope.ts', why: "the incarnation scope: systemctl --user, the manager's view of a scope at start and in recovery (D2 §3.3)", tool: 'systemctl' },
];

// The deployment adapter (M4; BS4 §5, "Process starts", and §7; D4 §2.5;
// D4-A08): `src/deploy/` joins the permitted places only for the host tools
// its `local_service` adapter names, `systemd-run --user` and
// `systemctl --user`, and BS4 §7 puts them in one file. It is listed as that
// one file, in the helpers' form, and not as `deploy/` or
// `deploy/adapters/`: any other file there that names a process-starting
// module is reported (objection 035).
export const D4_ADAPTERS = [
  { where: 'deploy/adapters/local-service.ts', why: 'the local_service adapter: systemd-run --user, the transient unit of a service domain (D4 §§9.2, 9.3)', tool: 'systemd-run' },
  { where: 'deploy/adapters/local-service.ts', why: 'the local_service adapter: systemctl --user, show, list-units and list-jobs, and stop and reset-failed of an exact owned unit (D4 §§2.4, 4.6, 9.3)', tool: 'systemctl' },
];

export const ALLOWED = [
  { where: 'invoke/', why: 'the choke point' },
  { where: 'git/exec.ts', why: 'the git runner' },
  { where: 'testing/', why: 'the seam folder' },
  ...D2_HELPERS,
  ...D4_ADAPTERS,
];

const allowed = (file) => ALLOWED.some(({ where }) => (where.endsWith('/') ? file.startsWith(where) : file === where));

// Every place the sources name a process-starting module outside the allowed
// places: [{file, line, what}].
export function inspectLaunches(sources) {
  const violations = [];
  for (const { file, text } of sources) {
    if (allowed(file)) continue;
    const tokens = tokenize(text, file);
    const refs = moduleRefs(tokens);
    tokens.forEach((token, index) => {
      if ((token.kind !== 'string' && token.kind !== 'template') || !PROCESS_MODULES.includes(token.text)) return;
      const ref = refs.find((candidate) => candidate.spec === index);
      const typesOnly = ref?.kind === 'import' && ref.bindings.length > 0 && ref.bindings.every((binding) => binding.typeOnly);
      if (typesOnly) return;
      const how = ref?.kind === 'import' ? 'imports' : ref?.kind === 'export-from' ? 're-exports' : ref?.kind === 'dynamic' ? 'loads' : 'names';
      violations.push({ file, line: token.line, what: `${how} '${token.text}', a module that can start a process, outside ${ALLOWED.map((place) => place.where).join(', ')}` });
    });
  }
  return violations;
}

// The files that do name such a module, allowed or not: so that a clean
// result can be told from an inspection that found nothing to inspect.
export function launchSites(sources) {
  return sources
    .filter(({ file, text }) => tokenize(text, file).some((token) => (token.kind === 'string' || token.kind === 'template') && PROCESS_MODULES.includes(token.text)))
    .map(({ file }) => file);
}

// ---- the deployment tools' sites (M4 slice 28; row M336 (d); D4-A08; D4 §2.5; SEAM.md §316) ----
//
// The rule, beside the one above. A file under packages/engine/src/ names
// `systemd-run` or `systemctl` as a program (a string or template literal
// that is the tool's name, or a path ending in `/<tool>`) only where that
// tool is started on purpose:
//   - `deploy/adapters/local-service.ts`, both tools (D4 §§2.5, 9.3);
//   - for `systemctl`, `boundary/scope.ts`, the incarnation scope's manager
//     view (D2 §3.3; M2's D2_HELPERS, accepted before D4);
//   - for `systemd-run`, `invoke/probes/suite.ts`, M2's qualification probe
//     P17 and its host-side control (D2 §7.2; accepted before D4).
// D4-A08 says "started only from src/deploy/adapters/"; read with D4 §2.5
// ("src/deploy/ joins the places permitted to start a process … only for
// the host tools its adapter names"), it governs deployment code, and the
// two pre-D4 sites stay as D2 placed them (SEAM.md §316 records the reading).
// And within `deploy/`, nothing interposes a shell (BS4 §5 "No shell"): no
// binding of `exec` or `execSync` from a process module (they run a
// shell), no `shell` option, no string naming a shell program.
//
// What a clean result proves: lexically, no other file names either tool as
// a program, and no deploy file reaches a shell by those names. Not: a name
// assembled at run time.

export const TOOL_SITES = {
  'systemd-run': ['deploy/adapters/local-service.ts', 'invoke/probes/suite.ts'],
  systemctl: ['deploy/adapters/local-service.ts', 'boundary/scope.ts'],
};

const namesTool = (text, tool) => text === tool || text.endsWith(`/${tool}`);

export function inspectToolSites(sources) {
  const violations = [];
  for (const { file, text } of sources) {
    const tokens = tokenize(text, file);
    for (const token of tokens) {
      if (token.kind !== 'string' && token.kind !== 'template') continue;
      for (const [tool, where] of Object.entries(TOOL_SITES)) {
        if (namesTool(token.text, tool) && !where.includes(file)) violations.push({ file, line: token.line, what: `names '${tool}' as a program outside ${where.join(', ')}` });
      }
    }
  }
  return violations;
}

const SHELLS = ['sh', 'bash', 'dash', 'zsh'];

export function inspectDeployShell(sources) {
  const violations = [];
  for (const { file, text } of sources) {
    if (!file.startsWith('deploy/')) continue;
    const tokens = tokenize(text, file);
    const refs = moduleRefs(tokens);
    for (const ref of refs) {
      const spec = tokens[ref.spec];
      if (!spec || !PROCESS_MODULES.includes(spec.text)) continue;
      // The import's own tokens: a binding of `exec` or `execSync`, renamed or not.
      for (let j = ref.start; j <= ref.end; j++) {
        const name = tokens[j]?.text;
        if (tokens[j]?.kind !== 'string' && ['exec', 'execSync'].includes(name)) violations.push({ file, line: spec.line, what: `binds '${name}' from '${spec.text}', which runs a shell` });
      }
    }
    tokens.forEach((token, i) => {
      if (token.kind === 'string' || token.kind === 'template') {
        if (SHELLS.some((sh) => token.text === sh || token.text.endsWith(`/${sh}`))) violations.push({ file, line: token.line, what: `names the shell '${token.text}'` });
      } else if (token.text === 'shell' && tokens[i + 1]?.text === ':') violations.push({ file, line: token.line, what: 'passes a `shell` option' });
    });
  }
  return violations;
}
