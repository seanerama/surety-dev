// Repository integrity (D1 §§1.4, 7.6, 8.1 step 3; SEAM.md §32): at startup
// and at every tick, before anything of a project is dispatched, every
// registered ref and every managed checkout is read and compared with what
// the engine expects. A registered ref somewhere else than its expected
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
import { checkoutBaseline, listWorktrees, readAllRefs } from './repo.js';
import { canonicalPath, worktreeMetadata } from './worktree.js';

const same = (a: string, b: string) => a === b || (canonicalPath(a) ?? a) === (canonicalPath(b) ?? b);

export async function observeIntegrity(rt: Runtime, project: string): Promise<void> {
  const facts = await rt.engine<IntegrityFacts>('integrity.facts', { project });
  const ctx = repoContext(facts.repo);
  const refs = await readAllRefs(ctx);
  const list = refs === null ? null : await listWorktrees(ctx);
  if (refs === null || list === null) {
    await rt.engine('integrity.record', { project, unreadable: true } satisfies IntegrityReport);
    return;
  }
  const report: Required<IntegrityReport> = { project, unreadable: false, refs: [], checkouts: [], released: [], added: [] };
  for (const row of facts.registry) {
    const found = refs.get(row.ref) ?? null;
    if (found === row.expected_oid) continue;
    if (found !== null && (facts.moving[row.ref] ?? []).includes(found)) continue;
    report.refs.push({ registry: row.id, expected: row.expected_oid, found });
  }
  const owned = canonicalPath(join(rt.home, 'workspaces')) ?? join(rt.home, 'workspaces');
  for (const c of facts.checkouts) {
    if (c.active) continue;
    let context;
    if (c.kind === 'integration_worktree') {
      const entry = list.find((w) => same(w.path, c.path));
      if (!entry || entry.branch !== facts.ref) {
        report.released.push(c.id);
        continue;
      }
      if (same(c.path, facts.repo)) context = repoContext(facts.repo);
      else {
        const admin = worktreeMetadata(facts.repo, c.path);
        if (admin === null || admin === 'unknown') continue;
        context = worktreeContext(facts.repo, admin, c.path);
      }
    } else {
      if (c.adminDir === null) continue;
      context = worktreeContext(facts.repo, c.adminDir, c.path);
    }
    const now = await checkoutBaseline(context, rt.scratch);
    if (now === null) continue;
    const baseline = JSON.parse(c.baseline) as { head: string; index_hash: string; tracked_tree_hash: string };
    const same3 = (b: { head: string; index_hash: string; tracked_tree_hash: string }) => now.head === b.head && now.index_hash === b.index_hash && now.tracked_tree_hash === b.tracked_tree_hash;
    // An adoption of this checkout's edits in flight: the branch it has
    // checked out is being moved by the engine onto exactly what it holds.
    if (c.pending !== null && same3(c.pending)) continue;
    if (!same3(baseline)) {
      report.checkouts.push({ id: c.id, expected: c.baseline, found: now });
    }
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
