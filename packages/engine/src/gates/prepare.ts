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
import { isAncestor, listTree, readRefs } from '../git/repo.js';
import { presentModules } from '../checks/scope.js';
import type { RefFact } from '../store/transitions/gates.js';
import { pausePoint, seamPresenceFault } from '../testing/seam.js';
import { type RefJudgement, type RegistryGeneration, allUnread, judgeRefs, sameGeneration } from './refs.js';
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

// ---- module presence (D3 §4.1; SEAM.md §224) ----------------------------------------------

export interface PresenceModules {
  basis: string;
  modules: { id: string; paths: string[] }[];
}

// The modules with at least one tracked path at `revision`, read with engine
// git (ls-tree; nothing is run). null when git could not say: unread, never
// empty. A project with no module reads nothing.
export async function readPresenceAt(rt: Runtime, project: string, repo: string, revision: string, mods: PresenceModules): Promise<string[] | null> {
  if (mods.modules.length === 0) return [];
  if (seamPresenceFault(project)) return null;
  const entries = await listTree(repoContext(repo), revision);
  if (entries === null) return null;
  return presentModules(entries.keys(), mods.modules);
}

// Every candidate of the project whose presence is unread under the module
// definitions in force: read and recorded. A failed read records nothing,
// and is read again by the next caller.
export async function ensurePresence(rt: Runtime, project: string): Promise<void> {
  const due = await rt.read<PresenceModules & { candidates: { id: string; revision: string }[] }>('presence.due', { project });
  if (due.candidates.length === 0) return;
  const repo = await rt.read<{ repo: string } | null>('project.repo', { project });
  if (!repo) return;
  for (const c of due.candidates) {
    const modules = await readPresenceAt(rt, project, repo.repo, c.revision, due);
    if (modules !== null) await rt.engine('presence.record', { candidate: c.id, modules, basis: due.basis });
  }
}

// The presence of the revision a due nomination will name, read before the
// nomination is intended and frozen into it, so its finalizer can register
// from it (D3 §2.5, L2). A failed read freezes nothing: the finalizer then
// records `checks_due`.
export async function ensureNominationPresence(rt: Runtime, project: string): Promise<void> {
  const due = await rt.read<(PresenceModules & { revision: string }) | null>('presence.nomination', { project });
  if (due === null) return;
  const repo = await rt.read<{ repo: string } | null>('project.repo', { project });
  if (!repo) return;
  const modules = await readPresenceAt(rt, project, repo.repo, due.revision, due);
  if (modules !== null) await rt.engine('presence.nomination_record', { project, revision: due.revision, modules, basis: due.basis });
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
// registry's generation is read before and after git; only a read across
// which it held still is judged, so the engine's own journaled write is
// never reported. If it moved during the read, the read is made again, at
// most three times; if it never held still, every ref is unread. A ref git
// did not list is absent only when verified (git/repo.ts refAbsent). An
// unsuccessful read records nothing and is passed on as unread.
export async function readGateRefs(rt: Runtime, project: string, candidate: string, repo: string): Promise<RefFact[]> {
  const ctx = repoContext(repo);
  let before = await rt.read<RegistryGeneration[]>('gate.ref_registry', { project, candidate });
  let judged: RefJudgement[] | null = null;
  for (let attempt = 0; attempt < 3 && judged === null; attempt++) {
    const found = await readRefs(ctx, before.map((r) => r.ref));
    const after = await rt.read<RegistryGeneration[]>('gate.ref_registry', { project, candidate });
    // Judged only against a generation that held still across the read.
    if (found === null || sameGeneration(before, after)) judged = judgeRefs(before, after, found);
    else before = after;
  }
  // The registry moved during every read: nothing read can be judged, so
  // every ref is unread and nothing is recorded (m2).
  judged ??= allUnread(before);
  const changes = judged.flatMap((j) => (j.change === null ? [] : [j.change]));
  if (changes.length > 0) await rt.engine('gate.observe_refs', { project, changes });
  return judged.map((j) => j.fact);
}

// The facts of one evaluation of `candidate`. Never throws for what git or a
// file cannot say; what it could not read is named in `unreadable`.
export async function gateFacts(rt: Runtime, project: string, candidate: string): Promise<GateFacts> {
  await ensureAncestry(rt, project);
  // The candidates' module presence (D3 §4.1), for every gate kind: the
  // candidate's registration and content hash need its deployment scope.
  await ensurePresence(rt, project).catch((err) => log('module presence', err, { project }));
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
