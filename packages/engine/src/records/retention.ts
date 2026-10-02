// Retention and the audit of referenced records (D1 §§14.3, 16.1 step 5;
// SEAM.md §58). A published record nothing live refers to expires once its
// retention has passed: the row is kept, the bytes are removed. At startup,
// every published record something refers to is checked: one whose bytes
// are missing or not of its hash is reported, never served as empty.

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { nowIso } from '../clock.js';
import { type Runtime, log } from '../runtime.js';
import { readRecordBytes, recordsDir } from './files.js';

// The tick's expiry of records (D1 §14.3). The row is changed first; the
// bytes are removed after, so a crash between the two leaves a file nothing
// names, never a row that names a removed file as if it were there.
export async function expireRecords(rt: Runtime): Promise<void> {
  const due = await rt.read<{ id: string }[]>('records.expirable', { now: nowIso() });
  for (const r of due) {
    try {
      const { path } = await rt.engine<{ path: string | null }>('record.expire', { record: r.id });
      if (path !== null) rmSync(join(recordsDir(rt.home), path), { force: true });
    } catch (err) {
      log('record expiry', err, { record: r.id });
    }
  }
}

// The `recovery` step's audit of referenced records.
export async function auditRecords(rt: Runtime): Promise<void> {
  const referenced = await rt.read<{ id: string; path: string; sha256: string; bytes: number; missing_at: string | null }[]>('records.referenced');
  for (const r of referenced) {
    const bytes = await readRecordBytes(rt.home, r);
    if (bytes === null) await rt.engine('record.audited', { record: r.id, whole: false, why: 'its bytes are missing or do not have the recorded hash' });
    else if (r.missing_at !== null) await rt.engine('record.audited', { record: r.id, whole: true });
  }
}
