// Discovery (D3 §1.4): a function of a tree, never a program. Given a commit
// or a tree of a project's repository, the engine reads the governed file and
// lists `check_discovery.definitions` with engine git (`ls-tree`, `cat-file`),
// which runs no repository code and contacts no remote (E25 item 3, E29 item
// 1, E37 item 1; git/exec.ts), and parses each regular-file blob named
// `<key>.json` against the closed schema (checks/schema.ts). Nothing is
// executed, expanded as a pattern or followed. Every refusal is a discovery
// error with its path and code; no definition is dropped silently.
//
// Main thread only: this reads git. The output is frozen where D3 says (the
// initial version at project creation; a proposal at classification) and
// written by a store transition.

import { type GitContext, git, repoContext } from '../git/exec.js';
import { protectedSetAt } from '../protected/set.js';
import {
  type Definition,
  type DiscoveryError,
  type Governed,
  type ManifestEntry,
  type TreeEntry,
  DEFINITIONS_MAX,
  DEFINITION_MAX_BYTES,
  GOVERNED_FILE,
  checkFingerprint,
  parseDefinition,
  parseGoverned,
} from './schema.js';

export interface DiscoveredCheck {
  key: string;
  // The definition's repository path.
  path: string;
  definition: Definition;
  input_manifest: ManifestEntry[];
  fingerprint: string;
  criteria: string[];
  required: boolean;
}

export interface Discovery {
  governed: Governed;
  checks: DiscoveredCheck[];
  // Errors of the tree itself; the criteria are judged against the
  // registered index when the result is written (schema.criterionErrors).
  errors: DiscoveryError[];
}

interface SizedEntry extends TreeEntry {
  size: number | null;
}

// Every entry of the tree, with no blob read: a blob absent from a partial
// clone is no reason the tree cannot be listed (E37 item 1). Sizes are asked
// only of the blobs discovery reads (`sizesOf`).
async function listSized(ctx: GitContext, treeish: string): Promise<SizedEntry[] | null> {
  const r = await git(ctx, ['ls-tree', '-r', '-t', '-z', '--full-tree', treeish]);
  if (r.code !== 0) return null;
  const out: SizedEntry[] = [];
  for (const record of r.stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
    out.push({ mode, type, oid, path: record.slice(tab + 1), size: null });
  }
  return out;
}

// The sizes of blobs, by object id; null if git could not answer.
async function sizesOf(ctx: GitContext, oids: string[]): Promise<Map<string, number> | null> {
  const out = new Map<string, number>();
  const unique = [...new Set(oids)];
  if (unique.length === 0) return out;
  const r = await git(ctx, ['cat-file', '--batch-check'], { input: `${unique.join('\n')}\n` });
  if (r.code !== 0) return null;
  for (const line of r.stdout.split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (oid && type === 'blob' && size !== undefined) out.set(oid, Number(size));
  }
  return unique.every((o) => out.has(o)) ? out : null;
}

// The bytes of each blob, by object id, read in batches; null if git could
// not answer.
async function readBlobs(ctx: GitContext, oids: string[]): Promise<Map<string, Buffer> | null> {
  const out = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  for (let i = 0; i < unique.length; i += 64) {
    const batch = unique.slice(i, i + 64);
    const r = await git(ctx, ['cat-file', '--batch'], { input: `${batch.join('\n')}\n` });
    if (r.code !== 0) return null;
    let at = 0;
    const buf = r.bytes;
    for (const oid of batch) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0) return null;
      const header = buf.subarray(at, nl).toString('utf8').split(' ');
      if (header[0] !== oid || header[1] !== 'blob') return null;
      const size = Number(header[2]);
      out.set(oid, buf.subarray(nl + 1, nl + 1 + size));
      at = nl + 1 + size + 1;
    }
  }
  return out;
}

const fatal = (path: string): Discovery => ({ governed: parseGoverned(null).governed, checks: [], errors: [{ path, code: 'governed_invalid' }] });

// Discovery of `treeish` (a commit or a tree) in `repo`. null when git could
// not read the tree: an unread tree is not an empty one.
export async function discover(repo: string, treeish: string): Promise<Discovery | null> {
  const ctx = repoContext(repo);
  const entries = await listSized(ctx, treeish);
  if (entries === null) return null;
  const errors: DiscoveryError[] = [];
  // The governed file.
  const gov = entries.find((e) => e.path === GOVERNED_FILE);
  let govText: string | null = null;
  if (gov !== undefined) {
    if (gov.type !== 'blob' || gov.mode !== '100644') return { ...fatal(GOVERNED_FILE), errors: [{ path: GOVERNED_FILE, code: 'not_regular_file' }] };
    const size = await sizesOf(ctx, [gov.oid]);
    if (size === null) return null;
    gov.size = size.get(gov.oid)!;
    if (gov.size > DEFINITION_MAX_BYTES) return { ...fatal(GOVERNED_FILE), errors: [{ path: GOVERNED_FILE, code: 'too_large' }] };
    const blobs = await readBlobs(ctx, [gov.oid]);
    if (blobs === null) return null;
    govText = blobs.get(gov.oid)!.toString('utf8');
  }
  const { governed, errors: govErrors } = parseGoverned(govText);
  errors.push(...govErrors);
  // The definitions directory: its direct entries.
  const dir = governed.check_discovery.definitions;
  const direct = new Map<string, SizedEntry>();
  for (const e of entries) {
    if (!e.path.startsWith(dir)) continue;
    const rest = e.path.slice(dir.length);
    if (rest.length === 0) continue;
    const name = rest.split('/')[0]!;
    if (!direct.has(name)) direct.set(name, rest.includes('/') ? { ...e, type: 'tree', mode: '040000', path: `${dir}${name}` } : e);
  }
  const names = [...direct.keys()].sort();
  if (names.length > DEFINITIONS_MAX) errors.push({ path: dir, code: 'too_many' });
  const read: { path: string; stem: string; oid: string }[] = [];
  const sizes = await sizesOf(
    ctx,
    names
      .slice(0, DEFINITIONS_MAX)
      .map((n) => direct.get(n)!)
      .filter((e) => e.type === 'blob' && e.mode === '100644')
      .map((e) => e.oid),
  );
  if (sizes === null) return null;
  for (const name of names.slice(0, DEFINITIONS_MAX)) {
    const e = direct.get(name)!;
    const path = `${dir}${name}`;
    if (e.type !== 'blob' || e.mode !== '100644') {
      errors.push({ path, code: 'not_regular_file' });
      continue;
    }
    if (!name.endsWith('.json')) {
      errors.push({ path, code: 'invalid_value' });
      continue;
    }
    if ((sizes.get(e.oid) ?? Infinity) > DEFINITION_MAX_BYTES) {
      errors.push({ path, code: 'too_large' });
      continue;
    }
    read.push({ path, stem: name.slice(0, -'.json'.length), oid: e.oid });
  }
  const blobs = await readBlobs(
    ctx,
    read.map((r) => r.oid),
  );
  if (blobs === null) return null;
  const plain: TreeEntry[] = entries.map(({ path, type, mode, oid }) => ({ path, type, mode, oid }));
  const checks: DiscoveredCheck[] = [];
  for (const r of read) {
    const text = blobs.get(r.oid)!.toString('utf8');
    const parsed = parseDefinition(r.path, r.stem, text, governed, plain);
    errors.push(...parsed.errors);
    if (parsed.definition === null) continue;
    const d = parsed.definition;
    checks.push({
      key: d.key,
      path: r.path,
      definition: d,
      input_manifest: parsed.manifest,
      fingerprint: checkFingerprint(d, parsed.manifest, governed),
      criteria: d.covers?.criteria ?? [],
      required: governed.required_checks === null || governed.required_checks.includes(d.key),
    });
  }
  // A required key with no definition (D3 §1.1).
  if (governed.required_checks !== null) {
    const defined = new Set([...read.map((r) => r.stem)]);
    governed.required_checks.forEach((key, n) => {
      if (!defined.has(key)) errors.push({ path: `${GOVERNED_FILE}#/required_checks/${n}`, code: 'required_key_without_definition' });
    });
  }
  return { governed, checks, errors };
}

// A tree's protected set as a version records it: the roots and fingerprint
// of protected/set.ts, with what discovery read. null when git cannot say.
export async function protectedVersionAt(repo: string, rev: string): Promise<{ roots: string[]; fingerprint: string; discovery: Discovery } | null> {
  const set = await protectedSetAt(repo, rev);
  if (set === null) return null;
  const discovery = await discover(repo, rev);
  if (discovery === null) return null;
  return { ...set, discovery };
}
