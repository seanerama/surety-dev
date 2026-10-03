// The identities the trust table binds (D2 §§4.1, 7.1, A.3): the host an
// entry was qualified on and the mechanisms its isolation and boundary rest
// on. Read in either thread; no process is started here.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// D2 §2.2 and §3.1: the only isolation and boundary an entry can name. The
// store refuses any other value (migrations/0007), so no entry, and no
// production setting, can select the scripted boundary of the harness (D2 §5
// C3; D2-C06).
export const ISOLATION_MECHANISM = 'linux_namespaces_d2';
export const BOUNDARY_MECHANISM = 'cgroup2_user_delegated_d2';

// A stable identity of this installation of the host operating system:
// derived from its machine id, which survives a reboot (the boot id does
// not, and would revoke every entry at each one; M2 plan §2.6). null when it
// cannot be read: an unknown host is never taken for the one an entry names.
let cached: string | null | undefined;
export function hostIdentity(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(id)) {
        cached = `host_${createHash('sha256').update(`surety-host-identity:${id}`).digest('hex').slice(0, 32)}`;
        break;
      }
    } catch {
      // try the next
    }
  }
  return cached;
}
