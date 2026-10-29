// The kind of output a build produces (the static-preview shapes of
// 2026-10-29, §5): `static_site`, `node_service` or `unknown`. Derived only
// from what the engine can read, never guessed:
//
// (a) before any candidate, from the approved specification and the
//     approved architecture (`architectureKind`): the specification's
//     environments (TPL §7, "Runtime and start command"), its header's
//     **Targets:**, and the module map's surfaces, UI targets and
//     technologies and interfaces (B.3). ADRs are prose and are not read.
// (b) once a candidate exists, from its tracked tree at its revision
//     (`treeKind`, read by `readTreeKind` from the object store, never
//     a work tree, as deploy/artifact.ts projects trees): an `index.html` at
//     the root and no `package.json` start script is a static site; a
//     `package.json` whose `scripts.start` is a command is a Node service;
//     anything else is unknown.
//
// The tree decides when both exist (`combineKinds`), and a disagreement is
// served in the reason. A tree that cannot be read gives `unknown`, with
// why; the architecture's answer is never put in its place.

import { git, repoContext } from '../git/exec.js';
import type { ModuleMap } from '../plan/schemas.js';
import type { SpecRepresentation } from '../spec/semantics.js';

export const OUTPUT_KINDS = ['static_site', 'node_service', 'unknown'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export interface KindAnswer {
  kind: OutputKind;
  // A sentence: what the kind was derived from, or why it is not known.
  reason: string;
}

// A revision's tree as read: its kind, or why it could not be read. A
// commit's tree never changes, so the answer is the revision's, whatever
// candidate names it.
export type TreeAnswer = { revision: string; kind: OutputKind; reason: string } | { revision: string; unread: string };

// The UI technologies a web browser runs as they are (D7 A.2): HTML/CSS and
// three.js. Any other (a framework that needs a build or a server, or a
// native toolkit) is not a static site of the artifact's files.
export const BROWSER_TECHNOLOGIES: readonly string[] = Object.freeze(['html_css', 'three_js']);
const RUNTIME_FIELD = 'Runtime and start command';
// Node named in a runtime statement: `node`, `Node.js`, `nodejs`, `npm`.
const NODE = /\bnode(?:\.?js)?\b|\bnpm\b/i;
// A runtime statement that says there is none: static files, no server.
const NO_SERVER = /\bstatic\b|^\s*(?:none|n\/a|no runtime|no server)\b/i;
const list = (xs: string[]): string => xs.join(', ');

// (a) The approved specification's and architecture's answer.
export function architectureKind(input: { spec: SpecRepresentation | null; map: ModuleMap | null }): KindAnswer {
  const { spec, map } = input;
  if (spec === null && map === null) return { kind: 'unknown', reason: 'No approved specification or architecture states what the build produces.' };
  // The specification's environments that state a runtime and start command.
  const runtimes = (spec?.environments ?? [])
    .map((e) => ({ name: e.name, value: (e.fields[RUNTIME_FIELD] ?? '').trim() }))
    .filter((r) => r.value !== '' && r.value !== '-' && r.value !== '—');
  const node = runtimes.filter((r) => NODE.test(r.value));
  const other = runtimes.filter((r) => !NODE.test(r.value) && !NO_SERVER.test(r.value.replace(/`/g, '')));
  if (other.length > 0) {
    const r = other[0]!;
    return { kind: 'unknown', reason: `The approved specification's environment ${r.name} states the runtime and start command ${JSON.stringify(r.value)}, which names neither Node nor a static site.` };
  }
  if (node.length > 0) {
    const r = node[0]!;
    return { kind: 'node_service', reason: `The approved specification's environment ${r.name} states the runtime and start command ${JSON.stringify(r.value)}, which names Node.` };
  }
  if (map === null) return { kind: 'unknown', reason: 'No approved architecture (module map) states the modules, and the approved specification names no runtime.' };
  const services = map.modules.filter((m) => m.surface === 'api' || m.interfaces.some((f) => f.kind === 'http')).map((m) => m.name);
  if (services.length > 0) {
    return { kind: 'unknown', reason: `The approved architecture names the service module${services.length === 1 ? '' : 's'} ${list(services)}, and neither it nor the approved specification names the runtime that serves ${services.length === 1 ? 'it' : 'them'}.` };
  }
  const ui = map.modules.filter((m) => m.surface === 'ui');
  if (ui.length === 0) return { kind: 'unknown', reason: 'The approved architecture names no ui module and no service module, and the approved specification names no runtime.' };
  const notBrowser = ui.flatMap((m) => (m.targets ?? []).filter((t) => t.target !== 'web' || !BROWSER_TECHNOLOGIES.includes(t.ui_technology)).map((t) => `${m.name} (${t.target}, ${t.ui_technology})`));
  const untargeted = ui.filter((m) => (m.targets ?? []).length === 0).map((m) => m.name);
  if (notBrowser.length > 0) return { kind: 'unknown', reason: `The approved architecture's ui module targets ${list(notBrowser)} are not a web browser running HTML/CSS or three.js as they are.` };
  if (untargeted.length > 0) return { kind: 'unknown', reason: `The approved architecture's ui module${untargeted.length === 1 ? '' : 's'} ${list(untargeted)} name${untargeted.length === 1 ? 's' : ''} no target or technology.` };
  const cli = map.modules.filter((m) => m.surface === 'cli').map((m) => m.name);
  if (cli.length > 0) return { kind: 'unknown', reason: `The approved architecture names the command-line module${cli.length === 1 ? '' : 's'} ${list(cli)} beside its ui modules.` };
  const nonWeb = (spec?.targets ?? []).filter((t) => t !== 'web');
  if (nonWeb.length > 0) return { kind: 'unknown', reason: `The approved specification's **Targets:** name ${list(nonWeb)} beside the web.` };
  const techs = [...new Set(ui.flatMap((m) => (m.targets ?? []).map((t) => t.ui_technology)))];
  return {
    kind: 'static_site',
    reason: `The approved architecture's ui module${ui.length === 1 ? '' : 's'} ${list(ui.map((m) => m.name))} target${ui.length === 1 ? 's' : ''} the web browser (${list(techs)}), no module is a service, and the approved specification names no server runtime.`,
  };
}

// (b) A tree's answer from its root entries: whether `index.html` is a
// regular file there, and `package.json`'s text (null when there is none).
export function treeKind(root: { indexHtml: boolean; packageJson: string | null }, where: string): KindAnswer {
  if (root.packageJson !== null) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(root.packageJson);
    } catch {
      return { kind: 'unknown', reason: `${where} has a package.json at its root that is not JSON.` };
    }
    const start = typeof pkg === 'object' && pkg !== null ? (pkg as { scripts?: { start?: unknown } }).scripts?.start : undefined;
    if (typeof start === 'string' && start.trim() !== '') return { kind: 'node_service', reason: `${where} has a package.json start script (${JSON.stringify(start)}).` };
    if (root.indexHtml) return { kind: 'static_site', reason: `${where} has index.html at its root and no package.json start script.` };
    return { kind: 'unknown', reason: `${where} has a package.json with no start script and no index.html at its root.` };
  }
  if (root.indexHtml) return { kind: 'static_site', reason: `${where} has index.html at its root and no package.json.` };
  return { kind: 'unknown', reason: `${where} has neither index.html at its root nor a package.json start script.` };
}

// The output kind from both answers: the tree's when a candidate exists
// (its disagreement with the architecture named), else the architecture's.
export function combineKinds(arch: KindAnswer, tree: TreeAnswer | null, candidate: { id: string; revision: string } | null): KindAnswer {
  if (candidate === null) return arch;
  if (tree === null || tree.revision !== candidate.revision) {
    return { kind: 'unknown', reason: `The tree of candidate ${candidate.id} at ${candidate.revision.slice(0, 7)} has not been read, so what it holds is not known.` };
  }
  if ('unread' in tree) return { kind: 'unknown', reason: `The tree of candidate ${candidate.id} at ${candidate.revision.slice(0, 7)} could not be read (${tree.unread}).` };
  if (arch.kind !== tree.kind && arch.kind !== 'unknown') {
    return { kind: tree.kind, reason: `${tree.reason} The approved architecture says otherwise (${arch.reason.replace(/\.$/, '')}); the candidate's tree decides.` };
  }
  return { kind: tree.kind, reason: tree.reason };
}

// The bytes of a root package.json read at most (a manifest larger than
// this is not judged).
export const PACKAGE_JSON_MAX = 1024 * 1024;

// Answers already read, by repository and revision: a commit's tree never
// changes, so an answer read once stands (a failed read is not kept).
const answered = new Map<string, TreeAnswer>();

// (b) on the main thread: a revision's tree read from the object store.
export async function readTreeKind(repo: string, revision: string, deadlineSeconds = 30): Promise<TreeAnswer> {
  const key = `${repo}\0${revision}`;
  const kept = answered.get(key);
  if (kept) return kept;
  const where = `The candidate's tree at ${revision.slice(0, 7)}`;
  const unread = (why: string): TreeAnswer => ({ revision, unread: why });
  try {
    if (!/^[0-9a-f]{40}$/.test(revision)) return unread(`${JSON.stringify(revision)} is not a commit`);
    const ctx = repoContext(repo);
    const listed = await git(ctx, ['ls-tree', '-z', '--full-tree', revision, '--', 'index.html', 'package.json'], { deadlineSeconds });
    if (listed.code !== 0) return unread(`git ls-tree ${listed.timedOut ? 'passed its deadline' : `failed: ${listed.stderr.trim() || `exit ${String(listed.code)}`}`}`);
    let indexHtml = false;
    let pkg: { oid: string; mode: string } | null = null;
    for (const record of listed.stdout.split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
      const path = record.slice(tab + 1);
      const regular = type === 'blob' && (mode === '100644' || mode === '100755');
      if (path === 'index.html' && regular) indexHtml = true;
      if (path === 'package.json' && regular) pkg = { oid, mode };
    }
    let text: string | null = null;
    if (pkg !== null) {
      const size = await git(ctx, ['cat-file', '-s', pkg.oid], { deadlineSeconds });
      if (size.code !== 0 || !/^\d+\s*$/.test(size.stdout)) return unread(`the size of package.json could not be read`);
      if (Number(size.stdout.trim()) > PACKAGE_JSON_MAX) return unread(`package.json is larger than ${PACKAGE_JSON_MAX} bytes`);
      const blob = await git(ctx, ['cat-file', 'blob', pkg.oid], { deadlineSeconds, outputCap: PACKAGE_JSON_MAX + 1024 });
      if (blob.code !== 0) return unread('package.json could not be read');
      text = blob.bytes.toString('utf8');
    }
    const kind = treeKind({ indexHtml, packageJson: text }, where);
    const answer: TreeAnswer = { revision, kind: kind.kind, reason: kind.reason };
    answered.set(key, answer);
    return answer;
  } catch (err) {
    return unread(err instanceof Error ? err.message : String(err));
  }
}
