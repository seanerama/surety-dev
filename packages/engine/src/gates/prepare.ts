// What a gate evaluation needs from git and from the record files before its
// transaction (D1 §§9.1, 9.3; SEAM.md §§70, 72), read on the main thread with
// no transaction open:
//
// - whether each stage's integrated revision is an ancestor of each
//   candidate's revision, asked of git once and recorded (an immutable fact),
//   so that delivery can be computed inside a transaction;
// - the protected fingerprint of the integration branch's head, under the
//   effective roots, so that a protected set nobody authorized is seen;
// - whether the bytes of each record a candidate's executions name are
//   whole, so that evidence that is gone is reported missing.

import { repoContext } from '../git/exec.js';
import { isAncestor } from '../git/repo.js';
import { protectedSetAt } from '../protected/set.js';
import { readRecordBytes } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';

const known = new Map<string, boolean>();

export async function ensureAncestry(rt: Runtime, project: string): Promise<void> {
  const pairs = await rt.read<{ ancestor: string; descendant: string }[]>('ancestry.pairs', { project });
  if (pairs.length === 0) return;
  const repo = await rt.read<{ repo: string } | null>('project.repo', { project });
  if (!repo) return;
  const ctx = repoContext(repo.repo);
  const found: { ancestor: string; descendant: string; is_ancestor: boolean }[] = [];
  for (const p of pairs) {
    const key = `${p.ancestor}:${p.descendant}`;
    let value = known.get(key);
    if (value === undefined) {
      const answer = await isAncestor(ctx, p.ancestor, p.descendant);
      // Unknown is not recorded: it is asked again next time.
      if (answer === null) continue;
      value = answer;
      known.set(key, value);
    }
    found.push({ ...p, is_ancestor: value });
  }
  if (found.length > 0) await rt.engine('ancestry.record', { project, pairs: found });
}

export interface GateFacts {
  headFingerprint: string | null;
  head: string | null;
  // What could not be read (E41 item 2): an unknown is never a pass, so each
  // of these makes the evaluation not satisfied.
  unreadable: { head: boolean; ancestry: boolean; records: string[] };
}

// The facts of one evaluation of `candidate`. Never throws for what git or a
// file cannot say; what it could not read is named in `unreadable`.
export async function gateFacts(rt: Runtime, project: string, candidate: string): Promise<GateFacts> {
  await ensureAncestry(rt, project);
  const unknownPairs = await rt.read<{ ancestor: string; descendant: string }[]>('ancestry.pairs', { project });
  const revision = await rt.read<string | null>('candidate.revision', { candidate });
  const unreadable = { head: false, ancestry: revision !== null && unknownPairs.some((p) => p.descendant === revision), records: [] as string[] };
  const facts = await rt.read<{ repo: string; head: string | null; roots: string[] | null; records: { id: string; path: string | null; sha256: string | null; bytes: number | null; missing_at: string | null }[] }>(
    'gate.facts',
    { project, candidate },
  );
  for (const r of facts.records) {
    if (r.path === null) continue;
    try {
      const bytes = await readRecordBytes(rt.home, { path: r.path, sha256: r.sha256, bytes: r.bytes });
      if (bytes === null && r.missing_at === null) await rt.engine('record.audited', { record: r.id, whole: false, why: 'its bytes are missing or do not have the recorded hash' });
      else if (bytes !== null && r.missing_at !== null) await rt.engine('record.audited', { record: r.id, whole: true });
    } catch (err) {
      log('evidence read', err, { record: r.id });
      unreadable.records.push(r.id);
    }
  }
  let headFingerprint: string | null = null;
  if (facts.head !== null && facts.roots !== null) headFingerprint = (await protectedSetAt(facts.repo, facts.head, facts.roots))?.fingerprint ?? null;
  unreadable.head = headFingerprint === null;
  return { headFingerprint, head: facts.head, unreadable };
}
