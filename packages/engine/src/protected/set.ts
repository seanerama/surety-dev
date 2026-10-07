// The protected set of a revision and its fingerprint (RN R2; build spec §6
// correction 3; D1 §§2.4, 5.2; SEAM.md §66). The governed settings live in
// `.surety/checks/protected-policy.json`; the protected roots are the path
// prefixes its `protected_paths` names (default `.surety/checks/`), and the
// governed file itself is always protected (E34 item 1). The fingerprint
// (L6, B01; SEAM.md §196) is SHA-256 of the JSON text of the protected set's
// manifest: the [path, type, mode, object id] of every entry under the roots
// and of the governed file, sorted by path, so a type or mode change is a
// change. No field of any file's content is projected into it. The mode-free
// [path, blob id] form recorded before slice 17 (`legacyFingerprintOf`) is
// read only by the Q11 migration and the harness's legacy fixture; no
// comparison crosses the two schemes (D3 §7.4 Q11).
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

export type ManifestRow = [path: string, type: string, mode: string, oid: string];

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function fingerprintOf(manifest: ManifestRow[]): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

// The mode-free fingerprint of the same set, as recorded before slice 17:
// the sorted [path, blob id] pairs of its blobs.
export function legacyFingerprintOf(manifest: ManifestRow[]): string {
  const pairs = manifest.filter(([, type]) => type === 'blob').map(([path, , , oid]) => [path, oid]);
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// The manifest of the protected set of `rev` under `roots`, sorted by path;
// null if the tree cannot be read.
export async function protectedManifest(ctx: GitContext, rev: string, roots: readonly string[]): Promise<ManifestRow[] | null> {
  const entries = await listTree(ctx, rev);
  if (entries === null) return null;
  const rows: ManifestRow[] = [];
  for (const entry of entries.values()) {
    if (!isProtected(entry.path, roots)) continue;
    rows.push([entry.path, entry.type, entry.mode, entry.oid]);
  }
  return rows.sort(([a], [b]) => byPath(a, b));
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
  const manifest = await protectedManifest(ctx, rev, own);
  if (manifest === null) return null;
  return { roots: own, fingerprint: fingerprintOf(manifest) };
}
