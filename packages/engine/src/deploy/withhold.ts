// What a read of a service of unknown supervision keeps (D4 §7.3; E116;
// SEAM.md §314). After an engine restart, or a lost control channel, the
// engine cannot know which secrets the surviving service holds, so nothing
// free-form the host returns about it is published: a read keeps its match
// result, digests and numeric identifiers, and of its detail only the name
// of the field that did not hold. Pure; the developer tests call it.

import type { IdentityRead } from './adapter.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const isInstance = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && Number.isInteger((v as { pid: unknown }).pid) && Number.isInteger((v as { start_time: unknown }).start_time);

export function withheldRead(r: IdentityRead): IdentityRead {
  const field = typeof r.detail?.field === 'string' && /^[a-z_]{1,32}$/.test(r.detail.field) ? r.detail.field : null;
  return {
    target: r.target,
    method: r.method,
    expected: typeof r.expected === 'string' && DIGEST.test(r.expected) ? r.expected : 'unread',
    read: typeof r.read === 'string' && DIGEST.test(r.read) ? r.read : 'unread',
    match: r.match,
    instance: isInstance(r.instance) ? { pid: (r.instance as { pid: number }).pid, start_time: (r.instance as { start_time: number }).start_time } : 'unread',
    generation: Number.isInteger(r.generation) ? r.generation : 'unread',
    at: r.at,
    ...(r.duration_ms !== undefined ? { duration_ms: Number.isFinite(r.duration_ms) ? r.duration_ms : null } : {}),
    detail: r.detail === null || r.detail === undefined ? null : { ...(field !== null ? { field } : {}), withheld: 'redaction_unavailable' },
  } as IdentityRead;
}
