// Deployment compatibility on the main thread (deploy/compatibility.ts):
// the candidate's tree read from the object store, since git never runs on
// the store worker. The evaluations themselves are recorded in the
// transactions that trigger them; this reads what they and the reads need:
// the current candidate's tree for a configuration's preparation
// (deploy/commands.ts) and for a read that computes its answer
// (api/server.ts), and the revision a nomination is about to make
// (journal/nominate.ts).

import { type TreeAnswer, readTreeKind } from './output-kind.js';

interface Target {
  repo: string | null;
  candidate: { id: string; revision: string } | null;
  tree_known: boolean;
  recorded: boolean;
  current: boolean;
}

export interface Reader {
  read<T = unknown>(name: string, args?: unknown): Promise<T>;
  setting?(name: string): unknown;
}

const deadlineOf = (rt: Reader): number => {
  const v = typeof rt.setting === 'function' ? rt.setting('git_deadline') : undefined;
  return typeof v === 'number' && v > 0 ? v : 30;
};

// A revision's tree, or why it was not read.
export async function treeAt(rt: Reader, repo: string | null, revision: string): Promise<TreeAnswer> {
  if (repo === null) return { revision, unread: 'the project records no repository' };
  return readTreeKind(repo, revision, deadlineOf(rt));
}

// The current candidate's tree, when no evaluation has recorded it yet;
// null with no candidate or with its tree already recorded.
export async function candidateTree(rt: Reader, project: string): Promise<TreeAnswer | null> {
  const t = await rt.read<Target>('deploy.compatibility_target', { project });
  if (t.candidate === null || t.tree_known) return null;
  return treeAt(rt, t.repo, t.candidate.revision);
}

// For a read (GET /v1/projects, /v1/projects/:p, an environment's): the
// trees a read must compute with because no current evaluation records
// them. A read writes nothing (D1 §12; M70): the answer is computed for it
// on the store worker from these.
export async function treesForRead(rt: Reader, project: string | null): Promise<TreeAnswer[]> {
  const targets =
    project === null
      ? await rt.read<{ project: string; repo: string | null; candidate: { id: string; revision: string } }[]>('deploy.compatibility_targets', {})
      : await rt.read<Target>('deploy.compatibility_target', { project }).then((t) => (t.candidate !== null && !t.current ? [{ project, repo: t.repo, candidate: t.candidate }] : []));
  const out: TreeAnswer[] = [];
  for (const t of targets) out.push(await treeAt(rt, t.repo, t.candidate.revision));
  return out;
}
