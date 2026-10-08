// The Q11 migration (D3 §7.4 Q11 (a); L6; E91 item 2; SEAM.md §197): at an
// engine start, before anything reads a fingerprint, every protected version
// whose fingerprint is not over the manifest is recomputed from its
// authorized tree: the commit it was authorized from (`authorized_revision`),
// under its own roots. The mode-free value it holds is checked against the
// same listing first, so a recorded revision that is not the one authorized
// is never adopted. A version whose revision the store does not hold, whose
// tree cannot be read or whose recorded value does not match is
// `unreadable`: compared with nothing, its project's gates carry
// PROTECTED_PATH_UNAUTHORIZED. Every such version is tried again at each
// start (no guessing). Main thread: it reads git.
//
// Two passes at a start. Before recovery, the versions in force or once in
// force (authorized). After recovery, the rest: a version whose protected
// application was in flight across the upgrade is not yet authorized, and
// its protected commit may exist only once recovery has written it (its id
// was computed without writing the object), so it is recomputed only then.

import { repoContext } from '../git/exec.js';
import { type Runtime, log } from '../runtime.js';
import { fingerprintOf, legacyFingerprintOf, protectedManifest } from './set.js';

export interface Pending {
  id: string;
  project: string;
  repo: string;
  roots: string[];
  fingerprint: string;
  scheme: string;
  revision: string | null;
  authorized: number;
}

// The outcome for one version: its fingerprint over the manifest, or null
// with why it could not be recomputed.
export async function recompute(v: Pending): Promise<{ fingerprint: string | null; why: string | null }> {
  if (v.revision === null) return { fingerprint: null, why: 'the store does not hold the commit this version was authorized from' };
  const manifest = await protectedManifest(repoContext(v.repo), v.revision, v.roots);
  if (manifest === null) return { fingerprint: null, why: `the authorized tree ${v.revision} cannot be read` };
  // A value recorded under the mode-free scheme must be that tree's: then
  // the manifest is the authorized set's, its modes included.
  if (legacyFingerprintOf(manifest) !== v.fingerprint) {
    return { fingerprint: null, why: `the recorded mode-free fingerprint is not that of ${v.revision}` };
  }
  return { fingerprint: fingerprintOf(manifest), why: null };
}

// `pass` 'before' takes the authorized versions; 'after' every version not
// yet over the manifest that the first pass (`tried`) did not take. Returns
// the versions it took.
export async function migrateFingerprints(rt: Runtime, pass: 'before' | 'after', tried: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const pending = (await rt.read<Pending[]>('protected.fingerprints_to_recompute')).filter((v) => (pass === 'before' ? v.authorized === 1 : !tried.has(v.id)));
  const took = new Set<string>();
  for (const v of pending) {
    took.add(v.id);
    let outcome: { fingerprint: string | null; why: string | null };
    try {
      outcome = await recompute(v);
    } catch (err) {
      outcome = { fingerprint: null, why: (err as Error).message };
    }
    if (outcome.fingerprint === null) log('protected fingerprint', new Error(outcome.why ?? 'unreadable'), { version: v.id });
    await rt.engine('protected.fingerprint_recomputed', { version: v.id, fingerprint: outcome.fingerprint, why: outcome.why });
  }
  return took;
}
