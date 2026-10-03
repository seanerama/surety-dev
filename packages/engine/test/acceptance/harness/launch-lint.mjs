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
// Builder names a helper; the Verifier adds it here (SEAM.md §121).
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

export const ALLOWED = [
  { where: 'invoke/', why: 'the choke point' },
  { where: 'git/exec.ts', why: 'the git runner' },
  { where: 'testing/', why: 'the seam folder' },
  ...D2_HELPERS,
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
