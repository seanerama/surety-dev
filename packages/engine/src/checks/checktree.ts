// The check tree (D3 §2.4): what an execution's workspace is made from, for
// one (project, source revision, protected version), under
// `$SURETY_HOME/checktrees/<project>/<tree>/`, engine-owned and never named
// by policy.
//
//   src/        the candidate-source projection: every tracked file of the
//               revision but those under the version's roots and the
//               governed file, wherever it lies; the overlay's lower layer.
//   protected/  the protected inputs of the version's checks, by the object
//               ids of their input manifests; each execution binds only its
//               own check's manifest from here.
//
// With engine git only: entries into a private index (`update-index
// --index-info`) and `checkout-index --prefix`, which writes no `.git`, runs
// no repository code (filter drivers are switched off by git/exec.ts) and
// contacts no remote. A tree is built in a private staging directory, made
// read-only, and becomes visible only once complete; a failed build removes
// its partial state. It is shared by the executions of its triple and
// removed when none still needs it. Main thread only.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { git, repoContext } from '../git/exec.js';
import { GOVERNED_FILE, type ManifestEntry, isProtectedPath } from './schema.js';

export interface CheckTree {
  root: string;
  src: string;
  protected: string;
}

const PROJECT_ID = /^proj_[0-9A-Z]{26}$/;
const TREE_NAME = /^[0-9a-f]{40}-pv_[0-9A-Z]{26}$/;

export const checktreesDir = (home: string): string => join(home, 'checktrees');

export class MaterializationFailed extends Error {}

function treePath(home: string, project: string, revision: string, version: string): string {
  const name = `${revision}-${version}`;
  if (!PROJECT_ID.test(project) || !TREE_NAME.test(name)) throw new MaterializationFailed(`not a check tree's name: ${project}/${name}`);
  return join(checktreesDir(home), project, name);
}

// Its files read-only, as a tree's are (D3 §2.4), keeping their execute
// bit. Directories stay writable by the engine alone (the tree lies under the
// engine home): the workspace overlay above them must let a check create
// files, whose writes are discarded with the domain (E89 item 2).
function seal(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) seal(p);
    else chmodSync(p, st.mode & 0o111 ? 0o555 : 0o444);
  }
}

function unseal(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isDirectory()) unseal(p);
    else if (!s.isSymbolicLink()) chmodSync(p, 0o644);
  }
}

// Remove a directory of the engine's own under `checktrees/`, never anything
// else: the path must resolve inside this home's `checktrees/` and be a
// project's tree or a staging directory.
export function removeTreeDir(home: string, dir: string): void {
  const base = realpathSync(checktreesDir(home));
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  const rel = relative(base, real);
  const parts = rel.split(sep);
  if (rel.startsWith('..') || parts.length !== 2 || !PROJECT_ID.test(parts[0]!) || !(TREE_NAME.test(parts[1]!) || /^\.staging-[0-9a-f]{16}$/.test(parts[1]!))) {
    throw new Error(`refused to remove ${dir}: not a check tree of this engine home`);
  }
  unseal(real);
  rmSync(real, { recursive: true, force: true });
}

async function checkoutInto(repo: string, scratch: string, lines: string[], prefix: string): Promise<void> {
  mkdirSync(prefix, { recursive: true });
  const index = join(scratch, `checktree-index-${randomBytes(8).toString('hex')}`);
  const ctx = repoContext(repo);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (lines.length > 0) {
      const add = await git(ctx, ['update-index', '-z', '--index-info'], { env, input: lines.join('') });
      if (add.code !== 0) throw new MaterializationFailed(`git update-index: ${add.stderr.trim().slice(0, 300) || (add.timedOut ? 'deadline' : 'failed')}`);
      const out = await git(ctx, ['-c', 'core.autocrlf=false', '-c', 'core.symlinks=true', 'checkout-index', '-a', '-f', `--prefix=${prefix}/`], { env });
      if (out.code !== 0) throw new MaterializationFailed(`git checkout-index: ${out.stderr.trim().slice(0, 300) || (out.timedOut ? 'deadline' : 'failed')}`);
    }
  } finally {
    rmSync(index, { force: true });
  }
}

// The tree of (project, revision, version), built now or reused.
// `manifests` are the input manifests the protected half must hold.
export async function materialize(args: {
  home: string;
  scratch: string;
  repo: string;
  project: string;
  revision: string;
  version: string;
  roots: string[];
  manifests: ManifestEntry[][];
  maxEntries: number;
}): Promise<CheckTree> {
  const root = treePath(args.home, args.project, args.revision, args.version);
  const made = { root, src: join(root, 'src'), protected: join(root, 'protected') };
  if (existsSync(join(root, 'src')) && existsSync(join(root, 'protected'))) return made;
  const parent = join(checktreesDir(args.home), args.project);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.staging-${randomBytes(8).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const ctx = repoContext(args.repo);
    const listed = await git(ctx, ['ls-tree', '-r', '-z', '--full-tree', args.revision]);
    if (listed.code !== 0) throw new MaterializationFailed(`the revision ${args.revision} cannot be read: ${listed.stderr.trim().slice(0, 200) || (listed.timedOut ? 'deadline' : 'failed')}`);
    const source: string[] = [];
    let entries = 0;
    for (const record of listed.stdout.split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
      const path = record.slice(tab + 1);
      // Submodules stay unsupported (D2 Q4): never in the projection.
      if (type !== 'blob') continue;
      // The candidate's own copy of the protected paths is never mounted,
      // and the governed file is absent wherever it lies (D3 §1.5, B01).
      if (path === GOVERNED_FILE || path.endsWith(`/${GOVERNED_FILE}`) || isProtectedPath(path, args.roots)) continue;
      if (++entries > args.maxEntries) throw new MaterializationFailed(`the revision has more than checktree_max_entries (${args.maxEntries}) entries`);
      source.push(`${mode} ${oid}\t${path}\0`);
    }
    await checkoutInto(args.repo, args.scratch, source, join(staging, 'src'));
    const inputs = new Map<string, ManifestEntry>();
    for (const m of args.manifests) for (const e of m) inputs.set(e[0], e);
    await checkoutInto(
      args.repo,
      args.scratch,
      [...inputs.values()].map(([path, , mode, oid]) => `${mode} ${oid}\t${path}\0`),
      join(staging, 'protected'),
    );
    seal(staging);
    try {
      renameSync(staging, root);
    } catch (err) {
      // Another build of the same triple won: it is the same content.
      if (existsSync(join(root, 'src'))) {
        removeTreeDir(args.home, staging);
        return made;
      }
      throw err;
    }
    return made;
  } catch (err) {
    try {
      removeTreeDir(args.home, staging);
    } catch {
      // nothing more to remove
    }
    if (err instanceof MaterializationFailed) throw err;
    throw new MaterializationFailed((err as Error).message);
  }
}

// The tree goes once no execution of its triple still needs it.
export function releaseTree(home: string, project: string, revision: string, version: string): void {
  const root = treePath(home, project, revision, version);
  if (!existsSync(root)) return;
  removeTreeDir(home, root);
}

// The trees built for a project, by their triple.
export function listTrees(home: string, project: string): { revision: string; version: string }[] {
  if (!PROJECT_ID.test(project)) return [];
  let names: string[];
  try {
    names = readdirSync(join(checktreesDir(home), project));
  } catch {
    return [];
  }
  return names.filter((n) => TREE_NAME.test(n)).map((n) => ({ revision: n.slice(0, 40), version: n.slice(41) }));
}
