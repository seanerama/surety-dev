// The adopted tests' dependency boundary (D6 §8.3; B13; reading 11; B.7;
// SEAM.md §383), checked when a Verifier's authoring proposal is captured
// in an adopted project: nothing under the protected root resolves an
// import outside it except an entry its `adopted_tests` declare
// `application`. A copy that still imports the original suite or its helpers
// would delegate its acceptance decision to Builder-owned files; it is
// refused by name. The engine reads the proposal's tree with git and runs
// nothing; no general semantic dependency analyzer is claimed (only the
// static and literal-dynamic module specifiers below are read: a computed
// specifier, a loader hook, a `node_modules` resolution or a runner
// configuration that reaches outside is not seen; D6 §8.3 claims no more).
// A symbolic link under the root is refused by name.

import { posix } from 'node:path';

import { gitOk, repoContext } from '../git/exec.js';

export interface AdoptedTest {
  from: string[];
  to: string;
  criteria: string[];
  dependency_boundary: { path: string; disposition: 'copied' | 'replaced' | 'application' }[];
}

export interface BoundaryError {
  file: string;
  import: string;
  resolved: string | null;
  why: string;
}

const SOURCE = /\.(mjs|cjs|js|jsx|ts|mts|cts|tsx)$/;
const SPECIFIERS = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function specifiersOf(text: string): string[] {
  const out = new Set<string>();
  for (const re of SPECIFIERS) for (const m of text.matchAll(re)) out.add(m[1]!);
  return [...out];
}

// The validity of a declared `adopted_tests` list (B.7): a list of objects
// with `from`, `to`, `criteria` and the boundary's dispositions.
export function adoptedTestsValid(v: unknown): v is AdoptedTest[] {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  const strings = (x: unknown) => Array.isArray(x) && x.every((y) => typeof y === 'string');
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        isObj(t) &&
        Object.keys(t).every((k) => ['from', 'to', 'criteria', 'dependency_boundary'].includes(k)) &&
        strings(t.from) &&
        typeof t.to === 'string' &&
        strings(t.criteria) &&
        Array.isArray(t.dependency_boundary) &&
        t.dependency_boundary.every((b) => isObj(b) && Object.keys(b).every((k) => k === 'path' || k === 'disposition') && typeof b.path === 'string' && ['copied', 'replaced', 'application'].includes(b.disposition as string)),
    )
  );
}

// Every import under the protected roots of `tree` that resolves outside
// them and is not a declared `application` entry. null: the tree could not
// be read (the caller records that as an error, never as none).
export async function boundaryErrors(repo: string, tree: string, roots: string[], adopted: AdoptedTest[]): Promise<BoundaryError[] | null> {
  const ctx = repoContext(repo);
  const declared = new Set(adopted.flatMap((t) => t.dependency_boundary.filter((b) => b.disposition === 'application').map((b) => posix.normalize(b.path))));
  const listing = await gitOk(ctx, ['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...roots]);
  if (listing === null) return null;
  const inRoots = (p: string) => roots.some((r) => p.startsWith(r.endsWith('/') ? r : `${r}/`));
  const errors: BoundaryError[] = [];
  for (const entry of listing.split('\0').filter((e) => e.length > 0)) {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    // A symbolic link under the protected root could point anywhere: the
    // copy would no longer be what the fingerprint covers (the slice-32
    // review's M3). Refused, named.
    if (mode === '120000') {
      errors.push({ file: path, import: '', resolved: null, why: `${path} is a symbolic link under the protected root; an adopted check's files are copies, never links` });
      continue;
    }
    if (type !== 'blob' || !SOURCE.test(path)) continue;
    const text = await gitOk(ctx, ['cat-file', 'blob', oid!]);
    if (text === null) return null;
    for (const spec of specifiersOf(text)) {
      if (spec.startsWith('/')) {
        errors.push({ file: path, import: spec, resolved: null, why: 'an absolute path is outside the protected root' });
        continue;
      }
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), spec));
      if (resolved.startsWith('../')) {
        errors.push({ file: path, import: spec, resolved: null, why: 'it resolves outside the repository' });
        continue;
      }
      if (inRoots(resolved)) continue;
      if (declared.has(resolved)) continue;
      errors.push({ file: path, import: spec, resolved, why: `${resolved} is outside the protected root and not declared application on the dependency boundary` });
    }
  }
  return errors;
}
