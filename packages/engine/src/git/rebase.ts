// The engine's rebase (D1 §7.5; SEAM.md §43). When the integration branch
// moved since a run's base was taken, the run's changes are applied to the
// head the engine expects: path by path, in an index of its own, from the
// changes between the merge base and the run's commit. A path the head
// changed too, another way, is a conflict. No merge machinery runs, so no
// merge driver the repository names can run (E25 item 3); what the engine
// makes of two changes to one file is its own (a conflict).

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { SHA, gitOk, repoContext } from './exec.js';
import { diffTrees, listTree } from './repo.js';

const ZERO = '0000000000000000000000000000000000000000';

export async function rebaseTree(repo: string, base: string, commit: string, head: string, scratch: string): Promise<{ tree: string; conflict: null } | { tree: null; conflict: string } | 'unknown'> {
  const ctx = repoContext(repo);
  const changes = await diffTrees(ctx, base, commit);
  const atHead = await listTree(ctx, head);
  if (changes === null || atHead === null) return 'unknown';
  const records: string[] = [];
  for (const c of changes) {
    const theirs = atHead.get(c.path);
    const wasThere = c.oldMode !== '000000';
    const unchangedAtHead = wasThere ? theirs !== undefined && theirs.mode === c.oldMode && theirs.oid === c.oldOid : theirs === undefined;
    const sameAsOurs = c.status === 'D' ? theirs === undefined : theirs !== undefined && theirs.mode === c.newMode && theirs.oid === c.newOid;
    if (sameAsOurs) continue;
    if (!unchangedAtHead) return { tree: null, conflict: c.path };
    records.push(c.status === 'D' ? `0 ${ZERO}\t${c.path}` : `${c.newMode} ${c.newOid}\t${c.path}`);
  }
  const index = join(scratch, `rebase-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if ((await gitOk(ctx, ['read-tree', head], { env })) === null) return 'unknown';
    if (records.length > 0) {
      const applied = await gitOk(ctx, ['update-index', '-z', '--index-info'], { env, input: `${records.join('\0')}\0` });
      if (applied === null) return { tree: null, conflict: changes[0]!.path };
    }
    const tree = (await gitOk(ctx, ['write-tree'], { env }))?.trim() ?? '';
    if (!SHA.test(tree)) return { tree: null, conflict: changes[0]?.path ?? '(the tree)' };
    return { tree, conflict: null };
  } finally {
    rmSync(index, { force: true });
  }
}
