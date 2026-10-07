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
import { isAncestor, readAllRefs } from '../git/repo.js';
import type { RefFact } from '../store/transitions/gates.js';
import { pausePoint } from '../testing/seam.js';
import { type RegistryGeneration, judgeRefs, sameGeneration } from './refs.js';
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

// The ancestry facts a due nomination's registration needs, asked of git
// and recorded before the nomination is intended (D3 §2.5, L2). An answer git
// cannot give is not recorded: the finalizer then records `checks_due`.
export async function ensureNominationAncestry(rt: Runtime, project: string): Promise<void> {
  const pairs = await rt.read<{ ancestor: string; descendant: string }[]>('ancestry.nomination_pairs', { project });
  if (pairs.length === 0) return;
  const repo = await rt.read<{ repo: string } | null>('project.repo', { project });
  if (!repo) return;
  const ctx = repoContext(repo.repo);
  const found: { ancestor: string; descendant: string; is_ancestor: boolean }[] = [];
  for (const p of pairs) {
    const answer = await isAncestor(ctx, p.ancestor, p.descendant);
    if (answer !== null) found.push({ ...p, is_ancestor: answer });
  }
  if (found.length > 0) await rt.engine('ancestry.record', { project, pairs: found });
}

export interface GateFacts {
  headFingerprint: string | null;
  head: string | null;
  // What could not be read (E41 item 2): an unknown is never a pass, so each
  // of these makes the evaluation not satisfied.
  unreadable: { head: boolean; ancestry: boolean; records: string[] };
  // The gate's own reads of its registered refs (D3 §5 X1).
  refs: RefFact[];
}

// Read the integration branch's ref and the candidate's nomination ref, and
// record a change the registry cannot account for as an integrity
// observation before the evaluation's transaction (D3 §5 X1; N02). The
// registry's generation is read before and after git; if it moved during
// the read, the read is made again (at most three times) and judged against
// both generations, so the engine's own journaled write is never reported.
// An unsuccessful read records nothing and is passed on as unread.
async function readGateRefs(rt: Runtime, project: string, candidate: string, repo: string): Promise<RefFact[]> {
  const ctx = repoContext(repo);
  let before = await rt.read<RegistryGeneration[]>('gate.ref_registry', { project, candidate });
  let found: Map<string, string> | null = null;
  let after = before;
  for (let attempt = 0; attempt < 3; attempt++) {
    found = await readAllRefs(ctx);
    after = await rt.read<RegistryGeneration[]>('gate.ref_registry', { project, candidate });
    if (found === null || sameGeneration(before, after)) break;
    before = after;
  }
  const judged = judgeRefs(before, after, found);
  const changes = judged.flatMap((j) => (j.change === null ? [] : [j.change]));
  if (changes.length > 0) await rt.engine('gate.observe_refs', { project, changes });
  return judged.map((j) => j.fact);
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
  const refs = await readGateRefs(rt, project, candidate, facts.repo);
  // The protected fingerprint at the integration branch's ref as read (D3
  // §5 X1), not at the registry's expected value. Absent or unread, the
  // head is not shown authorized (SEAM.md §66).
  // Known residual (driver's ruling, slice 16 O2): when these facts are read
  // before an engine-owned ref update and the evaluation's transaction runs
  // after its finalizer, this fingerprint is of the earlier generation; the
  // gate fails closed (PROTECTED_PATH_UNAUTHORIZED) and may emit a false
  // `protected.unauthorized_detected`. Not reconciled here.
  const integration = refs.find((r) => r.ref.startsWith('refs/heads/'));
  const head = integration?.read === 'value' ? integration.oid : null;
  let headFingerprint: string | null = null;
  if (head !== null && facts.roots !== null) headFingerprint = (await protectedSetAt(facts.repo, head, facts.roots))?.fingerprint ?? null;
  unreadable.head = headFingerprint === null;
  // A test may hold the evaluation here, its facts read and its
  // transaction not begun (SEAM.md §193).
  await pausePoint('gate.facts_read');
  return { headFingerprint, head, unreadable, refs };
}
