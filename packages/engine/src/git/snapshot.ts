// The snapshot of a run's workspace and its validation (D1 §7.3; build spec
// §6 correction 15; SEAM.md §28; ../contract/snapshot-validation.json).
//
// The snapshot is `git add -A` into an index of its own, started from the
// tree of the workspace's current base; the workspace's real index and HEAD
// are neither used nor changed. Validation judges the snapshot tree against
// the base (what the role may change, links, kinds, caps: `diff_violation`)
// and what lies outside the diff (the workspace's HEAD, index and .git file,
// the repository's configuration and hooks, every registered ref, every
// other managed checkout: `ref_violation`). One rule decides the class: a
// violation found in the captured diff is a diff violation, one found outside
// it a ref violation. Whatever cannot be read is not taken for clean.

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, posix } from 'node:path';

import { type GitContext, SHA, gitOk, repoContext, worktreeContext } from './exec.js';
import { type Baseline, type TreeEntry, blobSizes, catBlob, checkoutBaseline, contentHash, diffTrees, listTree, readAllRefs, readHeadFile } from './repo.js';
import { workspaceLink } from './worktree.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const scratchIndex = (scratch: string, what: string) => join(scratch, `${what}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// The tree of what the workspace holds, or null if it cannot be taken.
export async function snapshotTree(ctx: GitContext, base: string, scratch: string): Promise<string | null> {
  const index = scratchIndex(scratch, 'snapshot');
  const env = { GIT_INDEX_FILE: index };
  try {
    if ((await gitOk(ctx, ['read-tree', base], { env })) === null) return null;
    if ((await gitOk(ctx, ['add', '-A', '--', '.'], { env })) === null) return null;
    const tree = (await gitOk(ctx, ['write-tree'], { env }))?.trim() ?? '';
    return SHA.test(tree) ? tree : null;
  } finally {
    rmSync(index, { force: true });
  }
}

// What lies outside a run workspace's diff, as the engine left it before the
// role was launched (correction 15).
export interface MetadataBaseline {
  adminDir: string;
  head: string;
  index_hash: string;
  gitlink: string;
  config: string | null;
  hooks: string | null;
}

export async function indexHash(ctx: GitContext): Promise<string | null> {
  const staged = await gitOk(ctx, ['ls-files', '--stage', '-z']);
  return staged === null ? null : sha256(staged);
}

// The index hash a fresh checkout of `tree` has: the same entries as
// `ls-files --stage` lists, computed from the tree.
export async function indexHashOfTree(ctx: GitContext, tree: string): Promise<string | null> {
  const entries = await listTree(ctx, tree);
  if (entries === null) return null;
  const sorted = [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return sha256(sorted.map((e) => `${e.mode} ${e.oid} 0\t${e.path}\0`).join(''));
}

export async function captureMetadata(repo: string, path: string): Promise<MetadataBaseline | null> {
  const link = workspaceLink(repo, path);
  if (link === null) return null;
  const head = readHeadFile(link.adminDir);
  if (head === null || !('detached' in head)) return null;
  const index = await indexHash(worktreeContext(repo, link.adminDir, path));
  if (index === null) return null;
  return {
    adminDir: link.adminDir,
    head: head.detached,
    index_hash: index,
    gitlink: link.gitlink,
    config: contentHash(join(repo, '.git', 'config')),
    hooks: contentHash(join(repo, '.git', 'hooks')),
  };
}

export interface Violation {
  klass: 'diff_violation' | 'ref_violation' | 'infra_error';
  text: string;
}

export interface Caps {
  files: number;
  bytes: number;
  fileBytes: number;
}

export interface PlanFile {
  phase: number;
  path: string;
  stages: { number: number; goal: string }[];
}

// What each role may change (F §4.1; SEAM.md §28).
const ARCHITECT_PREFIXES = ['.surety/adrs/', '.surety/architecture/', '.surety/roadmap/', '.surety/phases/'];
const PROTECTED_ROOTS = ['.surety/checks/'];
const IDENTITY_FILE = '.surety/project.json';
const PLAN_FILE = /^\.surety\/phases\/phase-([0-9]+)\.json$/;

function pathRule(role: string, path: string): string | null {
  if (PROTECTED_ROOTS.some((root) => path.startsWith(root))) return `${path} is under the protected root ${PROTECTED_ROOTS.find((r) => path.startsWith(r))}, which no ${role} may change`;
  if (path === IDENTITY_FILE) return `${path} is the project's identity file, which no role may change`;
  if (role === 'builder' && path.startsWith('.surety/')) return `${path} is under .surety/, which a builder may not change`;
  if (role === 'architect' && !ARCHITECT_PREFIXES.some((prefix) => path.startsWith(prefix))) return `${path} is not under ${ARCHITECT_PREFIXES.join(', ')}, the only paths an architect may change`;
  return null;
}

// Does a symbolic link at `path` with `target` lead outside the workspace,
// directly or through other links of the tree? Resolved component by
// component within the workspace, following the tree's own links.
function escapes(entries: Map<string, TreeEntry>, targets: Map<string, string>, path: string, target: string): boolean {
  const resolveFrom = (dir: string[], link: string, hops: number): string[] | null => {
    if (hops > 40) return null;
    if (link.startsWith('/')) return null;
    const out = [...dir];
    const parts = link.split('/').filter((p) => p !== '' && p !== '.');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part === '..') {
        if (out.length === 0) return null;
        out.pop();
        continue;
      }
      out.push(part);
      const here = out.join('/');
      const entry = entries.get(here);
      if (entry && entry.mode === '120000') {
        const next = targets.get(here);
        if (next === undefined) return null;
        out.pop();
        const resolved = resolveFrom(out, next, hops + 1);
        if (resolved === null) return null;
        out.splice(0, out.length, ...resolved);
      }
    }
    return out;
  };
  return resolveFrom(posix.dirname(path) === '.' ? [] : posix.dirname(path).split('/'), target, 0) === null;
}

function parsePlan(path: string, phase: number, text: string): PlanFile | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `the phase plan ${path} is not JSON`;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `the phase plan ${path} is not a JSON object`;
  const plan = value as { phase?: unknown; stages?: unknown };
  if (plan.phase !== phase) return `the phase plan ${path} does not say it is phase ${phase}`;
  if (!Array.isArray(plan.stages) || plan.stages.length === 0) return `the phase plan ${path} has no stage`;
  const stages: { number: number; goal: string }[] = [];
  const seen = new Set<number>();
  for (const [i, s] of plan.stages.entries()) {
    const st = s as { number?: unknown; goal?: unknown } | null;
    if (typeof st !== 'object' || st === null) return `stage ${i + 1} of the phase plan ${path} is not an object`;
    if (typeof st.number !== 'number' || !Number.isInteger(st.number) || st.number < 1) return `stage ${i + 1} of the phase plan ${path} has no number`;
    if (typeof st.goal !== 'string' || st.goal.trim() === '') return `stage ${st.number} of the phase plan ${path} has no goal`;
    if (seen.has(st.number)) return `the phase plan ${path} has stage ${st.number} twice`;
    seen.add(st.number);
    stages.push({ number: st.number, goal: st.goal });
  }
  return { phase, path, stages };
}

// The captured diff: what the snapshot tree holds against the base.
export async function validateDiff(repo: string, base: string, tree: string, role: string, caps: Caps): Promise<{ violation: Violation | null; plans: PlanFile[] }> {
  const ctx = repoContext(repo);
  const unknown = (what: string): { violation: Violation; plans: PlanFile[] } => ({ violation: { klass: 'infra_error', text: `the snapshot could not be validated: ${what} could not be read` }, plans: [] });
  const changes = await diffTrees(ctx, base, tree);
  if (changes === null) return unknown('the diff');
  const entries = await listTree(ctx, tree);
  if (entries === null) return unknown('the snapshot tree');
  const reject = (text: string) => ({ violation: { klass: 'diff_violation' as const, text }, plans: [] });

  for (const c of changes) {
    const rule = pathRule(role, c.path);
    if (rule) return reject(`the run changed ${c.path}: ${rule}`);
  }
  const added = changes.filter((c) => c.status !== 'D');
  // The targets of the tree's symbolic links, which a link may lead through.
  const links = new Map<string, string>();
  for (const entry of entries.values()) {
    if (entry.mode !== '120000') continue;
    const target = await gitOk(ctx, ['cat-file', 'blob', entry.oid]);
    if (target === null) return unknown(`the symbolic link ${entry.path}`);
    links.set(entry.path, target);
  }
  for (const c of added) {
    if (c.newMode === '160000') return reject(`${c.path} is a repository of its own (a gitlink), not a regular file or a link`);
    if (c.newMode === '120000') {
      if (escapes(entries, links, c.path, links.get(c.path) ?? '/')) return reject(`${c.path} is a symbolic link that leads outside the workspace (${links.get(c.path)})`);
      continue;
    }
    if (c.newMode !== '100644' && c.newMode !== '100755') return reject(`${c.path} is not a regular file or a link (mode ${c.newMode})`);
  }
  // Caps, over what the run changed.
  const blobs = added.filter((c) => c.newMode === '100644' || c.newMode === '100755');
  if (blobs.length > caps.files) return reject(`the run changed ${blobs.length} files, more than snapshot_max_files (${caps.files})`);
  const sizes = await blobSizes(ctx, [...new Set(blobs.map((c) => c.newOid))]);
  if (sizes === null) return unknown('the sizes of the changed files');
  let total = 0;
  for (const c of blobs) {
    const size = sizes.get(c.newOid);
    if (size === undefined) return unknown(`the size of ${c.path}`);
    if (size > caps.fileBytes) return reject(`${c.path} is ${size} bytes, more than snapshot_max_file_bytes (${caps.fileBytes})`);
    total += size;
  }
  if (total > caps.bytes) return reject(`the run changed ${total} bytes, more than snapshot_max_bytes (${caps.bytes})`);
  // Phase plans: a committed plan is schedulable by construction (D1 §7.8).
  const plans: PlanFile[] = [];
  for (const c of blobs) {
    const m = PLAN_FILE.exec(c.path);
    if (!m) continue;
    const text = await catBlob(ctx, tree, c.path);
    if (text === null) return unknown(c.path);
    const plan = parsePlan(c.path, Number(m[1]), text);
    if (typeof plan === 'string') return reject(`${plan}: it could not be registered`);
    plans.push(plan);
  }
  return { violation: null, plans };
}

export interface OtherCheckout {
  kind: string;
  path: string;
  adminDir: string | null;
  baseline: Baseline;
}

// What lies outside the diff (correction 15; D1 §7.3 steps 3 and 4).
export async function validateOutside(args: {
  repo: string;
  path: string;
  metadata: MetadataBaseline;
  registry: { ref: string; expected_oid: string }[];
  moving: Record<string, string[]>;
  others: OtherCheckout[];
  scratch: string;
}): Promise<Violation | null> {
  const { repo, path, metadata } = args;
  const reject = (text: string): Violation => ({ klass: 'ref_violation', text });
  const head = readHeadFile(metadata.adminDir);
  if (head === null) return reject(`the workspace's HEAD cannot be read`);
  if (!('detached' in head)) return reject(`the workspace's HEAD is on ${head.branch}, not detached at ${metadata.head}`);
  if (head.detached !== metadata.head) return reject(`the workspace's HEAD moved from ${metadata.head} to ${head.detached}`);
  const ctx = worktreeContext(repo, metadata.adminDir, path);
  const index = await indexHash(ctx);
  if (index !== metadata.index_hash) return reject(index === null ? `the workspace's index cannot be read` : `the workspace's index was changed`);
  if (contentHash(join(path, '.git')) !== createHash('sha256').update(metadata.gitlink).digest('hex')) return reject(`the workspace's .git file was changed`);
  if (contentHash(join(repo, '.git', 'config')) !== metadata.config) return reject(`the repository's configuration was changed`);
  if (contentHash(join(repo, '.git', 'hooks')) !== metadata.hooks) return reject(`the repository's hooks directory was changed`);
  const refs = await readAllRefs(repoContext(repo));
  if (refs === null) return reject(`the repository's refs cannot be read`);
  for (const row of args.registry) {
    const found = refs.get(row.ref) ?? null;
    if (found === row.expected_oid) continue;
    if (found !== null && (args.moving[row.ref] ?? []).includes(found)) continue;
    return reject(`the registered ref ${row.ref} is ${found === null ? 'gone' : `at ${found}`}, not at ${row.expected_oid}`);
  }
  for (const other of args.others) {
    const ctxOther = other.adminDir ? worktreeContext(repo, other.adminDir, other.path) : repoContext(other.path);
    const now = await checkoutBaseline(ctxOther, args.scratch);
    if (now === null) return reject(`the managed checkout ${other.path} cannot be read`);
    if (now.head !== other.baseline.head || now.index_hash !== other.baseline.index_hash || now.tracked_tree_hash !== other.baseline.tracked_tree_hash) {
      return reject(`the managed checkout ${other.path} differs from its baseline`);
    }
  }
  return null;
}
