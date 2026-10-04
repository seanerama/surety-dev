// Developer tests for memory admission, option B (E75 item 3; D2 §3.7): every
// admitted domain, the new one included, at its configured maximum beyond
// host_reserve_memory, against the host's available memory plus what the
// running domains already hold; an unreadable value holds, never counts as
// zero. The store is a stub giving the running domains; each domain's
// "cgroup" is a scratch directory holding a memory.current file. Nothing is
// allocated.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { envelopeHold, setEnvelope } = await import(join(dist, 'store', 'transitions', 'envelope.js'));

const MiB = 1024 * 1024;
const available = () => Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024;

function fixture(t, held) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-envelope-'));
  t.after(() => {
    setEnvelope(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const rows = held.map((bytes, i) => {
    const path = join(dir, `dom_${i}`);
    mkdirSync(path);
    if (bytes !== null) writeFileSync(join(path, 'memory.current'), `${bytes}\n`);
    return { id: `dom_${i}`, cgroup_path: path };
  });
  const db = { prepare: () => ({ all: () => rows }) };
  return { dir, db };
}

const settings = (dir, memoryMax, reserve) => ({ max_concurrent_domains: 8, host_reserve_memory: reserve, host_reserve_disk: 0, domain_memory_max: memoryMax, domain_writable_bytes: 0, home: dir });

test('each admitted domain is reserved at its maximum: one fits, a second is held, though the first uses little now', (t) => {
  // The maximum is a little under half of what is available, beyond a small
  // reserve: one domain fits; two at their maximum do not, whatever the
  // first uses now (16 MiB).
  const max = Math.floor((available() * 0.45) / MiB) * MiB;
  const reserve = Math.floor((available() * 0.15) / MiB) * MiB;
  const none = fixture(t, []);
  setEnvelope(settings(none.dir, max, reserve));
  assert.equal(envelopeHold(none.db), null, 'the first domain is admitted');
  const one = fixture(t, [16 * MiB]);
  setEnvelope(settings(one.dir, max, reserve));
  const hold = envelopeHold(one.db);
  assert.equal(hold?.code, 'resource_envelope', 'a second domain is held: both could grow to their maximum');
  assert.equal(hold.subject.limit, 'host_reserve_memory');
  assert.equal(hold.subject.needed, reserve + 2 * max);
  assert.equal(hold.subject.admitted, 2);
  assert.equal(hold.subject.held_by_running, 16 * MiB, "the running domain's present use is counted once, inside its maximum");
});

test('a running domain whose memory.current cannot be read holds admission; never counted as zero', (t) => {
  const { dir, db } = fixture(t, [null]);
  setEnvelope(settings(dir, MiB, 0));
  const hold = envelopeHold(db);
  assert.equal(hold?.code, 'resource_envelope');
  assert.equal(hold.subject.held_by_running, null);
  assert.match(hold.reason, /memory.current/);
});

test('small maxima: several domains fit while the room holds them all', (t) => {
  const { dir, db } = fixture(t, [8 * MiB, 8 * MiB]);
  setEnvelope(settings(dir, 64 * MiB, 64 * MiB));
  assert.equal(envelopeHold(db), null, 'three domains of 64 MiB beyond a 64 MiB reserve fit');
});
