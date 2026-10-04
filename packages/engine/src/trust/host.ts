// The identities the trust table binds (D2 §§4.1, 7.1, A.3; SEAM.md §116):
// the host an entry was qualified on and the mechanisms its isolation and
// boundary rest on. Read in either thread; no process is started here.

import { readFileSync } from 'node:fs';

import { seamHostId } from '../testing/seam.js';

// D2 §2.2 and §3.1: the only isolation and boundary an entry can name in M2.
// The store refuses any other value and any change of either
// (migrations/0007), so no entry, and no production setting, can select the
// scripted boundary (D2 §5 C3; D2-C06).
export const ISOLATION_MECHANISM = 'linux-namespaces-1';
export const BOUNDARY_MECHANISM = 'cgroup2-delegated-scope-1';

// The host checks of D2 §6, H13 optional.
export const HOST_CHECKS = Array.from({ length: 13 }, (_, i) => `H${i + 1}`);

// A stable identity of this installation: the trimmed content of
// /etc/machine-id, which survives a reboot (the boot id does not, and would
// revoke every entry at each one; M2 plan §2.6). null when it cannot be read:
// an unknown host is never taken for the one an entry names.
let cached: string | null | undefined;
export function hostIdentity(): string | null {
  // The engine's test mode may name another identity (SEAM.md §150).
  const forced = seamHostId();
  if (forced !== null) return forced;
  if (cached !== undefined) return cached;
  try {
    const id = readFileSync('/etc/machine-id', 'utf8').trim();
    cached = id.length > 0 ? id : null;
  } catch {
    cached = null;
  }
  return cached;
}
