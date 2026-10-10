// M311 (h), the identity read's duration at the artifact bounds (slice 24;
// sandbox lane). M4 plan §3.2 M311 (h); BS4 §11.3 (`adapter_read_deadline`
// kept at 10 s, E121 item 3: measured here and returned to Sean if a read
// takes more than half of it); D4 §3.4 step 4; SEAM.md §§259, 263.
//
// One project whose revision holds 19,999 small files under fill/ and four
// files under pad/ making 256 MiB with server.js. Two environments, each
// projecting server.js and one of them (the rest excluded by exact path):
// `entries` at exactly `artifact_max_entries` (20,000) and `bytes` at exactly
// `artifact_max_bytes` (268,435,456 bytes), both the approved defaults.
// Each is deployed on a real unit and its round's two identity reads are
// made; each read must succeed (`match`, so within `adapter_read_deadline`)
// and record its duration (`duration_ms`, SEAM.md §259 †). The durations are
// written to the test's output for the M4 report; a read over half the
// deadline (5,000 ms) is printed as a matter for Sean, not failed here.
//
// Cost: about 1.5 GiB of transient disk in the test's own directories
// (the repository, two check trees, the sealed copies), removed with them.
// Nothing is exhausted: these are the artifact bounds, not a service's.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257): the only units are the engine's,
// under this test's home's prefix; the test acts on no unit and signals
// nothing; the fixture service and the check program are used in their
// benign routes only. The file ends with the operator's guard (row M313).
// Its first engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { listTree } from './harness/repos.mjs';
import { artifactsOf } from './harness/deploy/kernel.mjs';
import {
  FIXTURE_SERVICE,
  endEnvironment,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  newestOperation,
  operatorGuard,
  releaseCheck,
  requestLong,
  serviceOf,
  ticksUntil,
  verificationOf,
} from './harness/deploy/host.mjs';

const MAX_ENTRIES = 20000;
const MAX_BYTES = 268435456;
const HALF_DEADLINE_MS = 5000;
const SERVER = Buffer.byteLength(FIXTURE_SERVICE);

function revisionFiles() {
  const files = {};
  for (let i = 0; i < MAX_ENTRIES - 1; i++) files[`fill/f${String(i).padStart(5, '0')}.txt`] = `${i}\n`;
  const quarter = MAX_BYTES / 4;
  files['pad/p1.bin'] = 'a'.repeat(quarter);
  files['pad/p2.bin'] = 'b'.repeat(quarter);
  files['pad/p3.bin'] = 'c'.repeat(quarter);
  files['pad/p4.bin'] = 'd'.repeat(quarter - SERVER);
  return files;
}

describe('M311 (h) the identity read\'s duration at artifact_max_entries and at artifact_max_bytes', () => {
  const shared = sharedFixture();
  let guard;
  const measured = {};
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard, { files: revisionFiles() });
    const paths = Object.keys(listTree(ctx.p.repo.path, ctx.candidate.revision)).filter((p) => !p.startsWith('.surety/'));
    for (const [name, keep] of [['entries', 'fill/'], ['bytes', 'pad/']]) {
      const exclude = paths.filter((p) => p !== 'server.js' && !p.startsWith(keep));
      const env = await hostEnvironment(ctx, name, { artifact: { exclude } });
      // The request seals the artifact before it answers: a longer idle bound than the harness's 15 s.
      const asked = await requestLong(ctx.fx.engine, 'POST', `/v1/projects/${ctx.project}/deployments`, { candidate: ctx.candidate.id, environment: env.name });
      assert.ok([200, 201].includes(asked.status) && asked.body?.authorization?.status === 'issued', `the ${name} deployment is issued (${asked.status} ${String(asked.text).slice(0, 300)})`);
      await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env), { timeoutMs: 900_000, what: `the round of ${name} to hold its check` });
      const op = newestOperation(ctx, env);
      const svc = serviceOf(ctx, env, op);
      // Exit 1: the candidate stays developing for the second environment.
      releaseCheck(ctx, svc, { get: ['/hello'], exit: 1 });
      const { row } = await verificationOf(ctx, op, { timeoutMs: 900_000 });
      const artifact = artifactsOf(ctx.fx.home, ctx.project).find((a) => a.digest === op.subject?.artifact_digest);
      measured[name] = { entries: artifact?.entries, bytes: artifact?.bytes, reads: row.identity_reads.map((r) => ({ bracket: r.bracket, match: r.match, duration_ms: r.duration_ms })) };
      await endEnvironment(ctx, env);
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  for (const [name, bound, what] of [['entries', MAX_ENTRIES, 'artifact_max_entries'], ['bytes', MAX_BYTES, 'artifact_max_bytes']]) {
    test(`(h) at ${what} (${bound}): both reads succeed and record their duration`, (t) => {
      const m = measured[name];
      assert.ok(m, `the ${name} environment was deployed and read`);
      assert.equal(name === 'entries' ? m.entries : m.bytes, bound, `the artifact is exactly at ${what}`);
      for (const r of m.reads) {
        assert.equal(r.match, 'match', `the ${r.bracket} read succeeded within adapter_read_deadline (${JSON.stringify(r)})`);
        assert.ok(Number.isFinite(r.duration_ms) && r.duration_ms >= 0, `the ${r.bracket} read records its duration_ms (${r.duration_ms})`);
        const line = `M311 (h) ${what}=${bound}: ${r.bracket} identity read took ${r.duration_ms} ms (adapter_read_deadline 10,000 ms)`;
        t.diagnostic(line);
        console.log(line);
        if (r.duration_ms > HALF_DEADLINE_MS) {
          const note = `M311 (h): over half of adapter_read_deadline (${r.duration_ms} ms > ${HALF_DEADLINE_MS} ms): for Sean (BS4 §11.3; E121 item 3)`;
          t.diagnostic(note);
          console.log(note);
        }
      }
    });
  }
});
