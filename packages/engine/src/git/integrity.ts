// Repository integrity (D1 §§1.4, 7.6, 8.1 step 3; SEAM.md §32): at startup
// and at every tick, before anything of a project is dispatched, every
// registered ref and every managed checkout is read and compared with what
// the engine expects; the retained workspace of an ended work-item run at
// startup only (Sean's ruling, 2026-10-14; integrityFacts). A registered ref somewhere else than its expected
// commit, and than any commit the engine's own journal is moving it to, is
// an out-of-band change; so is a managed checkout that differs from its
// baseline, unless it is an active run's workspace (the validator's). A
// repository that cannot be read is observed as such, never as clean. A
// checkout of the integration branch the developer made is managed from the
// first time integrity sees it; one switched away is no longer managed.

import { join } from 'node:path';

import type { Runtime } from '../runtime.js';
import type { IntegrityFacts, IntegrityReport } from '../store/transitions/integrity.js';
import { type GitContext, repoContext, worktreeContext } from './exec.js';
import { checkoutBaseline, listWorktrees, readRefs } from './repo.js';
import { canonicalPath, worktreeMetadata } from './worktree.js';

const same = (a: string, b: string) => a === b || (canonicalPath(a) ?? a) === (canonicalPath(b) ?? b);

// `startup`: the evaluation at startup (D1 §1.4 step 5), which also reads
// the retained workspaces of ended work-item runs (store/transitions/
// integrity.ts integrityFacts); a tick's does not.
export async function observeIntegrity(rt: Pick<Runtime, 'engine' | 'home' | 'scratch'>, project: string, opts: { startup?: boolean } = {}): Promise<void> {
  const facts = await rt.engine<IntegrityFacts>('integrity.facts', { project, ...(opts.startup === true ? { startup: true } : {}) });
  const ctx = repoContext(facts.repo);
  const refs = await readRefs(ctx, facts.registry.map((r) => r.ref));
  const list = refs === null ? null : await listWorktrees(ctx);
  // A registered ref git did not list and whose absence is not verified
  // (a broken or unreadable loose ref, D3 §5 X1, N02) is not taken for
  // deleted: the repository is observed as not readable, as when the listing
  // fails, never as clean and never as a deletion.
  const unknownRef = refs !== null && [...refs.values()].some((r) => r.state === 'unknown');
  if (refs === null || list === null || unknownRef) {
    await rt.engine('integrity.record', { project, unreadable: true } satisfies IntegrityReport);
    return;
  }
  const report: Required<IntegrityReport> = { project, unreadable: false, refs: [], checkouts: [], released: [], added: [] };
  for (const row of facts.registry) {
    const read = refs.get(row.ref)!;
    const found = read.state === 'ok' ? read.oid : null;
    if (found === row.expected_oid) continue;
    if (found !== null && (facts.moving[row.ref] ?? []).includes(found)) continue;
    report.refs.push({ registry: row.id, expected: row.expected_oid, found });
  }
  const owned = canonicalPath(join(rt.home, 'workspaces')) ?? join(rt.home, 'workspaces');
  // Each managed checkout's baseline, read side by side (a bounded number of
  // git processes at once): with several runs of a project at once (D6 K2)
  // a project has many retained workspaces, and the step is a prerequisite
  // of every tick (D1 §8.1 step 3). The report keeps the checkouts' order.
  const results = await mapBounded(facts.checkouts, INTEGRITY_PARALLEL, async (c) => {
    if (c.active) return null;
    let context;
    if (c.kind === 'integration_worktree') {
      const entry = list.find((w) => same(w.path, c.path));
      if (!entry || entry.branch !== facts.ref) return { released: c.id };
      if (same(c.path, facts.repo)) context = repoContext(facts.repo);
      else {
        const admin = worktreeMetadata(facts.repo, c.path);
        if (admin === null || admin === 'unknown') return null;
        context = worktreeContext(facts.repo, admin, c.path);
      }
    } else {
      if (c.adminDir === null) return null;
      context = worktreeContext(facts.repo, c.adminDir, c.path);
    }
    const now = await checkoutBaseline(context, rt.scratch);
    if (now === null) return null;
    const baseline = JSON.parse(c.baseline) as { head: string; index_hash: string; tracked_tree_hash: string };
    const same3 = (b: { head: string; index_hash: string; tracked_tree_hash: string }) => now.head === b.head && now.index_hash === b.index_hash && now.tracked_tree_hash === b.tracked_tree_hash;
    // An adoption of this checkout's edits in flight: the branch it has
    // checked out is being moved by the engine onto exactly what it holds.
    if (c.pending !== null && now.tracked_tree_hash === c.pending.tree && c.pending.heads.includes(now.head) && c.pending.indexes.includes(now.index_hash)) return null;
    if (!same3(baseline)) return { changed: { id: c.id, expected: c.baseline, found: now } };
    return null;
  });
  for (const r of results) {
    if (r === null) continue;
    if ('released' in r) report.released.push(r.released);
    else report.checkouts.push(r.changed);
  }
  for (const w of list) {
    if (w.branch !== facts.ref) continue;
    const at = canonicalPath(w.path) ?? w.path;
    if (at.startsWith(`${owned}/`)) continue;
    if (facts.checkouts.some((c) => c.kind === 'integration_worktree' && same(c.path, w.path))) continue;
    const context = same(w.path, facts.repo) ? repoContext(facts.repo) : (() => {
      const admin = worktreeMetadata(facts.repo, w.path);
      return admin === null || admin === 'unknown' ? null : worktreeContext(facts.repo, admin, w.path);
    })();
    if (context === null) continue;
    const baseline = await checkoutBaseline(context, rt.scratch);
    if (baseline !== null) report.added.push({ path: w.path, baseline });
  }
  await rt.engine('integrity.record', report);
}

const INTEGRITY_PARALLEL = 8;

// `fn` over `items`, at most `limit` at once; the results in the items' order.
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

// The developer's checkouts of the integration branch, with what each holds:
// what a project installed or created on the repository starts managing.
export async function integrationCheckouts(rt: Runtime | { home: string; scratch: string }, repo: string, branch: string): Promise<{ path: string; baseline: { head: string; index_hash: string; tracked_tree_hash: string } }[] | null> {
  const list = await listWorktrees(repoContext(repo));
  if (list === null) return null;
  const owned = canonicalPath(join(rt.home, 'workspaces')) ?? join(rt.home, 'workspaces');
  const out = [];
  for (const w of list) {
    if (w.branch !== `refs/heads/${branch}`) continue;
    const at = canonicalPath(w.path) ?? w.path;
    if (at.startsWith(`${owned}/`)) continue;
    const admin = same(w.path, repo) ? null : worktreeMetadata(repo, w.path);
    if (admin === 'unknown') return null;
    const context = admin === null ? repoContext(repo) : worktreeContext(repo, admin, w.path);
    const baseline = await checkoutBaseline(context, rt.scratch);
    if (baseline === null) return null;
    out.push({ path: w.path, baseline });
  }
  return out;
}

// The git context of a developer's checkout of the integration branch, by
// its path: the repository itself, or a linked worktree by its metadata.
export async function checkoutContext(repo: string, path: string): Promise<GitContext | null> {
  if (same(path, repo)) return repoContext(repo);
  const admin = worktreeMetadata(repo, path);
  if (admin === null || admin === 'unknown') return null;
  return worktreeContext(repo, admin, path);
}
