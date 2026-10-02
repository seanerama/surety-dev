// The protected set of a revision and its fingerprint (RN R2; build spec §6
// correction 3; D1 §§2.4, 5.2; SEAM.md §66). The governed settings live in
// `.surety/checks/protected-policy.json`; the protected roots are the path
// prefixes its `protected_paths` names (default `.surety/checks/`), and the
// governed file itself is always protected (E34 item 1). The fingerprint is
// SHA-256 of the JSON text of the sorted [path, blob id] pairs of every
// file under the roots: no field of any file is projected into it.
//
// Main thread only: these read git.

import { createHash } from 'node:crypto';

import { type GitContext, repoContext } from '../git/exec.js';
import { catBlob, listTree } from '../git/repo.js';

export const GOVERNED_FILE = '.surety/checks/protected-policy.json';
export const GOVERNED_KEYS = ['protected_paths', 'check_commands', 'check_discovery', 'runner_config', 'result_collection', 'required_checks'] as const;
export const DEFAULT_ROOTS = ['.surety/checks/'];

// The roots a governed file names: its `protected_paths` when that is a
// list of path prefixes, otherwise the default.
export function rootsOf(text: string | null): string[] {
  if (text === null) return [...DEFAULT_ROOTS];
  try {
    const value = JSON.parse(text) as { protected_paths?: unknown };
    const paths = value?.protected_paths;
    if (Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p.length > 0)) return [...new Set(paths as string[])].sort();
  } catch {
    // an unreadable governed file names no roots of its own
  }
  return [...DEFAULT_ROOTS];
}

export const isProtected = (path: string, roots: readonly string[]): boolean => path === GOVERNED_FILE || roots.some((root) => path.startsWith(root));

export function fingerprintOf(pairs: [string, string][]): string {
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// The [path, blob id] pairs of the protected set of `rev` under `roots`,
// sorted by path; null if the tree cannot be read.
export async function protectedPairs(ctx: GitContext, rev: string, roots: readonly string[]): Promise<[string, string][] | null> {
  const entries = await listTree(ctx, rev);
  if (entries === null) return null;
  const pairs: [string, string][] = [];
  for (const entry of entries.values()) {
    if (entry.type !== 'blob' || !isProtected(entry.path, roots)) continue;
    pairs.push([entry.path, entry.oid]);
  }
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// The governed file's text at `rev`, null if it has none.
export async function governedText(ctx: GitContext, rev: string): Promise<string | null> {
  const entries = await listTree(ctx, rev);
  if (entries === null) throw new Error(`the tree of ${rev} cannot be read`);
  if (!entries.has(GOVERNED_FILE)) return null;
  const text = await catBlob(ctx, rev, GOVERNED_FILE);
  if (text === null) throw new Error(`the governed file of ${rev} cannot be read`);
  return text;
}

// The protected set of `rev`: its roots (those given, or the ones its own
// governed file names) and its fingerprint. Null if git cannot say.
export async function protectedSetAt(repo: string, rev: string, roots?: readonly string[]): Promise<{ roots: string[]; fingerprint: string } | null> {
  const ctx = repoContext(repo);
  let own: string[];
  try {
    own = roots ? [...roots] : rootsOf(await governedText(ctx, rev));
  } catch {
    return null;
  }
  const pairs = await protectedPairs(ctx, rev, own);
  if (pairs === null) return null;
  return { roots: own, fingerprint: fingerprintOf(pairs) };
}
