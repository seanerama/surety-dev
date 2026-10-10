// What an adapter qualification is matched by (D4 §2.6; SEAM.md §248): the
// engine's build, the adapter and its version, the host qualification and
// the `service` profile's fingerprint. The qualification run itself (its
// nine cases) is slice 29's (M338); slice 23 matches a row against these.

import { createHash } from 'node:crypto';

import { ENGINE_VERSION } from '../index.js';

export const engineBuild = (): string => ENGINE_VERSION;

// The `service` profile's fingerprint (D4 §9.2): what a qualification of
// `local_service` covers. Slice 24 builds the profile; until then it is the
// fingerprint of the profile as D4 Q6 fixes its limits.
export function profileFingerprint(): string {
  const profile = {
    profile: 'service',
    mounts: ['/usr', '/bin', '/lib', '/lib64', '/etc (enumerated)', 'runtime', '/surety/app (ro)', '/surety/home', '/tmp', '/surety/state'],
    network: 'loopback',
    restart: 'disabled',
    launch: 'single-use',
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`;
}
