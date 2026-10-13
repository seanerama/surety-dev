// The adoption route's main-thread step (D6 §8.1 step 1; A.8; B11; E6, E18;
// SEAM.md §§377, 378; Sean, 2026-10-12): `POST /v1/projects/adopt`.
//
// 1. The branch's head is read: the adoption baseline revision A, unpushed
//    commits included (E18).
// 2. A repository that already carries Surety records (`.surety/` in A's
//    tree, or any `refs/surety/*` ref) is refused, `adoption_surety_records`,
//    naming what was found (Sean, 2026-10-12: strip, then adopt).
// 3. The size and deployment signals are read at A as observed evidence;
//    a signal that cannot be read is `{unknown: <reason>}`, never zero, empty
//    or none. A's application-source projection digest is read (refused if
//    unreadable: conformance could never be established on an unknown).
// 4. The `adoption.observed` barrier.
// 5. The bootstrap commit is prepared on the branch as it is now; a head
//    other than A refuses the adoption, `adoption_branch_moved`, with nothing
//    created. The journal's ref update compares against the same head, so a
//    branch that moves later fails the bootstrap rather than pinning a
//    revision that was never the head (D6-R01).
// The store transaction (adopt/records.ts) records A before the bootstrap
// commit is intended, and never changes it (migration 0025's trigger).
//
// Host calls: git reads only (ls-tree, rev-list --count, the refs, a CI
// file's blob), through the engine's git path; nothing is written to the
// repository here.

import { basename, extname } from 'node:path';

import { prepareBootstrap } from '../projects/commands.js';
import { gitOk, repoContext } from '../git/exec.js';
import { catBlob, readAllRefs, readRef } from '../git/repo.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import { pausePoint, seamAdoptionSignalFault } from '../testing/seam.js';
import { projectionDigest } from './projection.js';

export type Signal<T> = T | { unknown: string };

export interface AdoptionSignals {
  files: Signal<number>;
  bytes: Signal<number>;
  commits: Signal<number>;
  languages: Signal<string[]>;
  test_files: Signal<string[]>;
  ci_files: Signal<string[]>;
  deploy_files: Signal<string[]>;
}

const FIELDS = ['name', 'tier', 'dev_repo_path', 'integration_branch', 'idea'];

const LANGUAGES: Record<string, string> = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#',
  '.php': 'PHP', '.swift': 'Swift', '.sh': 'Shell', '.bash': 'Shell', '.sql': 'SQL', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.md': 'Markdown', '.json': 'JSON',
  '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.xml': 'XML', '.txt': 'Text',
};

const languageOf = (path: string): string | null => {
  const ext = extname(path).toLowerCase();
  if (ext === '') return null;
  return LANGUAGES[ext] ?? ext;
};

// D6 §8.1 step 1: test conventions, CI and deployment files (names only).
export const isTestFile = (path: string): boolean => {
  const segments = path.split('/');
  const name = segments.at(-1)!;
  return segments.slice(0, -1).some((s) => s === 'test' || s === 'tests') || /_test\.[^/]+$/.test(name) || /\.test\.[^/]+$/.test(name) || /\.spec\.[^/]+$/.test(name);
};
export const isCiFile = (path: string): boolean => path.startsWith('.github/workflows/');
export const isDeployFile = (path: string): boolean => {
  const name = basename(path);
  return name === 'Dockerfile' || name.startsWith('docker-compose') || name === 'Procfile' || name.includes('.env');
};

// The environment names a CI file declares (`environment: <name>`, or
// `name: <name>` in an `environment:` block): what the signals suggest is
// deployed (E6: recorded unknown by name, never read or deployed to).
export function ciEnvironments(text: string): string[] {
  const out = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)environment:\s*(.*?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const inline = m[2]!.replace(/^['"]|['"]$/g, '');
    if (inline !== '' && /^[A-Za-z0-9_.-]+$/.test(inline)) {
      out.add(inline);
      continue;
    }
    const brace = /name:\s*['"]?([A-Za-z0-9_.-]+)/.exec(inline);
    if (brace) {
      out.add(brace[1]!);
      continue;
    }
    const indent = m[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      const ind = l.length - l.trimStart().length;
      if (ind <= indent) break;
      const n = /^\s*name:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(l);
      if (n) {
        out.add(n[1]!);
        break;
      }
    }
  }
  return [...out].sort();
}

// The statements an idea brief lists under "## First version": the owner's
// approved text a reverse-engineered requirement may be bound to (D6 §8.1
// step 2; SEAM.md §379, the Verifier's reading).
export function firstVersionItems(idea: string | undefined): string[] {
  if (idea === undefined) return [];
  const out: string[] = [];
  let inside = false;
  for (const line of idea.split('\n')) {
    if (/^##\s+/.test(line)) {
      inside = /^##\s+First version\s*$/i.test(line.trim());
      continue;
    }
    if (!inside) continue;
    const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (item) out.push(item[1]!);
  }
  return out;
}

export const ADOPTED_IDEA = (name: string): string =>
  `# Idea: ${name}\n\nThis project was adopted from an existing repository. Its intent is pending: the owner has not yet stated it.\n`;

function signal<T>(name: string, read: () => T | null, why: string): Signal<T> {
  if (seamAdoptionSignalFault(name)) return { unknown: `the ${name} signal could not be read (harness fault)` };
  const v = read();
  return v === null ? { unknown: why } : v;
}

const unreadable = (path: string) => new Refusal(409, 'repo_unreadable', `${path} is not a git repository the engine can read.`, 'Give the path of a readable git repository; nothing was created.', { path });
const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the request and send it again; nothing was created.', { field });

// After the adoption's transaction (A recorded and the bootstrap commit
// intended in it), before its answer and before the journal drives the
// bootstrap: the journal's `intent_committed` point for that commit, as an
// intent recorded through the journal reaches it (SEAM.md §§33, 377). Only
// when the adoption committed.
export async function settleAdopt(rt: Runtime, prepared: unknown): Promise<void> {
  const id = (prepared as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return;
  if (!(await rt.read<boolean>('project.adopted', { project: id }))) return;
  await pausePoint('journal.commit_tree.intent_committed');
}

export async function prepareAdopt(rt: Runtime, body: unknown): Promise<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!FIELDS.includes(key)) throw new Refusal(400, 'unknown_field', `"${key}" is not a field of an adoption.`, `Send only ${FIELDS.join(', ')}.`, { field: key });
  for (const field of FIELDS.slice(0, 4)) if (typeof b[field] !== 'string' || (b[field] as string).length === 0) throw invalid(field, 'must be a non-empty string');
  const repo = b.dev_repo_path as string;
  const branch = b.integration_branch as string;
  const name = b.name as string;
  if (b.idea !== undefined && (typeof b.idea !== 'string' || b.idea.trim() === '')) throw invalid('idea', "must be the brief's text, a non-empty string");
  if (!repo.startsWith('/')) throw invalid('dev_repo_path', 'must be an absolute path');
  if (/[\0\n]/.test(branch)) throw invalid('integration_branch', 'is not a branch name');
  const ctx = repoContext(repo);
  if ((await gitOk(ctx, ['rev-parse', '--git-dir'])) === null) throw unreadable(repo);

  // 1. A: the branch's head as observed.
  const observed = await readRef(ctx, `refs/heads/${branch}`);
  if (observed.state === 'unknown') throw unreadable(repo);
  if (observed.state === 'missing') throw invalid('integration_branch', `is no branch of ${repo}`);
  const A = observed.oid;

  // 2. Surety records already in the repository (Sean, 2026-10-12).
  const refs = await readAllRefs(ctx);
  if (refs === null) throw unreadable(repo);
  const suretyTree = await gitOk(ctx, ['ls-tree', '--name-only', A, '--', '.surety']);
  if (suretyTree === null) throw unreadable(repo);
  const found = [...(suretyTree.trim() !== '' ? ['.surety/'] : []), ...[...refs.keys()].filter((r) => r.startsWith('refs/surety/')).sort()];
  if (found.length > 0) {
    throw new Refusal(
      409,
      'adoption_surety_records',
      `The repository ${repo} already carries Surety records (${found.join(', ')}), so it cannot be adopted as it is.`,
      'Remove the Surety records in a commit of your own (the .surety/ directory and every refs/surety/* ref), then adopt that commit; nothing was created.',
      { found, path: repo, revision: A },
    );
  }

  // 3. The signals at A, as observed evidence.
  const listing = await gitOk(ctx, ['ls-tree', '-r', '-l', '-z', '--full-tree', A]);
  const entries = listing === null ? null : listing.split('\0').filter((e) => e.length > 0).map((e) => {
    const tab = e.indexOf('\t');
    const meta = e.slice(0, tab).trim().split(/\s+/);
    return { type: meta[1] ?? '', size: meta[3] ?? '-', path: e.slice(tab + 1) };
  });
  const commitsOut = await gitOk(ctx, ['rev-list', '--count', A]);
  const paths = entries?.map((e) => e.path) ?? null;
  const why = 'the tree at A could not be listed';
  const signals: AdoptionSignals = {
    files: signal('files', () => entries?.length ?? null, why),
    bytes: signal('bytes', () => (entries === null ? null : entries.some((e) => e.type === 'blob' && !/^[0-9]+$/.test(e.size)) ? null : entries.reduce((n, e) => n + (e.type === 'blob' ? Number(e.size) : 0), 0)), why),
    commits: signal('commits', () => (commitsOut !== null && /^[0-9]+\s*$/.test(commitsOut) ? Number(commitsOut.trim()) : null), 'the commits reachable from A could not be counted'),
    languages: signal('languages', () => (paths === null ? null : [...new Set(paths.map(languageOf).filter((l): l is string => l !== null))].sort()), why),
    test_files: signal('test_files', () => paths?.filter(isTestFile).sort() ?? null, why),
    ci_files: signal('ci_files', () => paths?.filter(isCiFile).sort() ?? null, why),
    deploy_files: signal('deploy_files', () => paths?.filter(isDeployFile).sort() ?? null, why),
  };
  const threshold = rt.config.values.adoption_full_max_files as number;
  // The recommendation is derived from the size signal; with the size
  // unknown there is no recommendation (null, shown so), never a guess.
  const recommended = typeof signals.files === 'number' ? (signals.files <= threshold ? 'full' : 'scoped') : null;
  const sourceDigest = await projectionDigest(ctx, A);
  if (sourceDigest === null) throw unreadable(repo);
  // The environments the CI files name, and the tags as releases.
  const environments = new Set<string>();
  for (const path of Array.isArray(signals.ci_files) ? signals.ci_files : []) {
    const text = await catBlob(ctx, A, path);
    if (text !== null) for (const env of ciEnvironments(text)) environments.add(env);
  }
  const tags = [...refs.entries()].filter(([r]) => r.startsWith('refs/tags/')).map(([r, oid]) => ({ name: r.slice('refs/tags/'.length), revision: oid })).sort((x, y) => x.name.localeCompare(y.name));
  const idea = b.idea as string | undefined;

  // 4. Between the observation and the pin.
  await pausePoint('adoption.observed');

  // 5. The bootstrap on the branch as it is now; A must still be its head.
  const prepared = await prepareBootstrap(rt, { name, tier: b.tier, dev_repo_path: repo, integration_branch: branch, idea: idea ?? ADOPTED_IDEA(name) });
  if (prepared.head !== A) {
    throw new Refusal(
      409,
      'adoption_branch_moved',
      `The branch ${branch} moved from ${A} to ${String(prepared.head)} after the adoption observed it, so no revision was pinned.`,
      'Adopt again: the engine pins the head it observes; nothing was created.',
      { branch, observed: A, found: prepared.head },
    );
  }
  return {
    ...prepared,
    adoption: {
      pinned_revision: A,
      branch,
      signals,
      recommended_mode: recommended,
      threshold,
      source_digest: sourceDigest,
      idea_given: idea !== undefined,
      // The repository's code as the retrofit sessions' input (D6 §8.2):
      // its tracked paths at A, named in their packages (at most 500).
      tracked_paths: (paths ?? []).slice(0, 500),
      tracked_paths_total: paths === null ? { unknown: why } : paths.length,
      idea_first_version: firstVersionItems(idea),
    },
    environments: [...environments].sort(),
    tags,
  };
}
