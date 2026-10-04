// M141, the M2 acceptance report's qualified facts (M2 slice 14, manifest
// slice 14; no engine, nothing paid). M2 plan §3.9 M141; BS §10; D2 §8;
// E40; SEAM.md §163.
//
// The report (`docs/acceptance/reports/M2-report.md`) is the Verifier's,
// written after the real lane has run. Until then it is a skeleton: what is
// already true is filled, and every real-lane fact is a placeholder of the
// form `[[PENDING <label>: <what>; from <source>]]`. Case (a) holds the
// report to M141's list in either state. Case (b) FAILS while any
// placeholder remains (the driver's provisional decision on the report's
// question 3, 2026-10-04: "nothing described as passing that was not run"):
// the row is met only by a final report, so this file fails in `--slice 14`
// and in `npm test` until the real lane has run and the report is written.
// Before it fails it still checks that the skeleton is honest (it says M2 is
// not accepted and claims no real-lane result); a final report must have no
// placeholder left and cite the real lane's records, which must exist.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const REPORT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M2-report.md');
const RECORDS = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M2-real-lane');
const D2 = join(REPO_ROOT, 'docs', 'design', 'sdlc-design-D2-backends-and-isolation.md');
const PLACEHOLDER = /\[\[PENDING [^\]]+\]\]/g;

const text = () => readFileSync(REPORT, 'utf8');
const sections = (md) => {
  const out = new Map();
  let current = null;
  for (const line of md.split('\n')) {
    const h = /^## \d+\. (.+)$/.exec(line);
    if (h) {
      current = h[1];
      out.set(current, []);
    } else if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n')]));
};
const sectionLike = (all, pattern) => {
  const found = [...all.keys()].filter((k) => pattern.test(k));
  assert.equal(found.length, 1, `one section whose heading matches ${pattern} (headings: ${[...all.keys()].join(' | ')})`);
  return all.get(found[0]);
};
const statusOf = (md) => /^\*\*Status:\*\* (skeleton|final)\b/m.exec(md)?.[1] ?? null;

// D2 §8's class C paragraph, which the report carries verbatim (M2 plan §4.4).
function classC() {
  const d2 = readFileSync(D2, 'utf8');
  const line = d2.split('\n').find((l) => l.startsWith('**Class C.**'));
  assert.ok(line, 'D2 §8 has its class C paragraph');
  return line.replace('**Class C.** ', '').trim();
}

const REAL_FILES = ['M139-unauthenticated-canary', 'M136-positive-canary', 'M137-cancellation-canary', 'M138-containment-canary', 'M140-real-backend-journey'];
const A7_ENGINE_KEYS = ['ui_bootstrap', 'max_concurrent_domains', 'host_reserve_memory', 'host_reserve_disk', 'domain_memory_max', 'domain_tasks_max', 'domain_writable_bytes', 'domain_writable_inodes', 'result_max_bytes', 'provider_files_max_bytes', 'collect_entries_max', 'collect_deadline', 'stream_line_max_bytes', 'stream_queue_max_bytes', 'egress_resolve_timeout', 'egress_connect_timeout', 'egress_tunnel_max_seconds', 'egress_tunnels_max', 'egress_buffer_max_bytes', 'egress_log_max_bytes', 'pause_challenge_timeout'];
const BUCKET_C = ['M11', 'M20', 'M27', 'M31', 'M43', 'M58', 'M70', 'M72'];

describe('M141 the M2 acceptance report records what M141 lists, and claims nothing it has not run', () => {
  test('(a) every fact M141 lists has its section: revisions; the host and its tools; the backend; the host qualification with H1 to H13 and P1 to P20; the entry with its evidence; the spend and term_to_exit_ms; every A.7 key; egress; ui_bootstrap; the observer; the real-lane runs; the not_exercised cases; what is not claimed (D2 §8 class A, class B, class C verbatim, bucket C, the M1 instrument limits)', () => {
    const md = text();
    const all = sections(md);
    assert.match(sectionLike(all, /^Revisions/), /`[0-9a-f]{7,40}`/, 'the revisions name commits');
    const host = sectionLike(all, /^The host$/);
    for (const fact of ['host_id', 'Kernel', 'WSL2', 'Distribution', 'util-linux', 'systemd', 'Node', 'git', 'SQLite', '`ip`']) assert.ok(host.includes(fact), `the host section records ${fact}`);
    const backend = sectionLike(all, /^The backend/);
    for (const fact of ['SHA-256', 'version', 'Help hash', 'Model']) assert.ok(backend.toLowerCase().includes(fact.toLowerCase()), `the backend section records ${fact}`);
    const hq = sectionLike(all, /^The host qualification/);
    for (let i = 1; i <= 13; i++) assert.match(hq, new RegExp(`\\| H${i} \\|`), `H${i} has its row with its result and observed value`);
    assert.ok(/P1\b/.test(hq) && /P19\b/.test(hq) && /\| P20 \|/.test(hq), 'P1 to P20 are accounted for, P20 on its own');
    assert.ok(/seeded/i.test(hq) && /control/i.test(hq), 'with the seeded target and the control');
    assert.ok(sectionLike(all, /^The trust entry/).includes('evidence'), 'the entry with its evidence');
    const spend = sectionLike(all, /spend/);
    assert.ok(/estimated/i.test(spend) && /charged/i.test(spend) && spend.includes('term_to_exit_ms'), 'the spend as estimated and as charged, and term_to_exit_ms');
    const config = sectionLike(all, /^The configuration in force/);
    for (const key of A7_ENGINE_KEYS) assert.ok(config.includes(`\`${key}\``), `the configuration records ${key}`);
    assert.ok(/unexpected/i.test(sectionLike(all, /^Egress/)), 'the egress hosts and any unexpected contact');
    assert.ok(sectionLike(all, /bootstrap/i).includes('ui_bootstrap'), 'ui_bootstrap during qualification');
    assert.ok(/H13/.test(sectionLike(all, /observer/i)), "the observer's availability");
    const runs = sectionLike(all, /^The real lane's runs/);
    for (const f of REAL_FILES) assert.ok(runs.includes(f), `the real-lane run of ${f}`);
    const notEx = sectionLike(all, /not_exercised/);
    for (const c of ['M112 (g)', 'M116 (d)', 'M124 (e)', 'M128 (g)', 'M135 (j)', 'M115 (f)', 'M115 (h)', 'P20']) assert.ok(notEx.includes(c), `the not_exercised case ${c} is named`);
    const notClaimed = sectionLike(all, /^What M2 does not claim/);
    assert.ok(/class A/i.test(notClaimed) && /class B/i.test(notClaimed) && /class C/i.test(notClaimed), 'classes A, B and C');
    assert.ok(notClaimed.includes(classC()), "D2 §8's class C, verbatim");
    for (const row of BUCKET_C) assert.ok(notClaimed.includes(row), `bucket C's ${row}`);
    assert.ok(/sync/.test(notClaimed), "the M1 report's instrument limits");
    assert.ok(sectionLike(all, /^The real-backend journey/).length > 0 && sectionLike(all, /^Limits of the instruments/).length > 0 && sectionLike(all, /^Hands-on run/).length > 0, 'the journey, the instruments\' limits and the hands-on run (BS §10)');
  });

  test('(b) the report is final: no pending fact remains and its real-lane records exist (it fails while the report is a skeleton, after checking that the skeleton claims nothing it has not run)', () => {
    const md = text();
    const status = statusOf(md);
    assert.ok(status, 'the report states its status, skeleton or final');
    const pending = md.match(PLACEHOLDER) ?? [];
    const runs = sectionLike(sections(md), /^The real lane's runs/);
    if (status === 'skeleton') {
      assert.match(md, /\*\*M2 is not accepted\.\*\*/, 'a skeleton says plainly that M2 is not accepted');
      assert.ok(pending.length > 0, 'and marks what the real lane is to supply');
      for (const f of REAL_FILES) {
        const row = runs.split('\n').find((l) => l.includes(`\`${f}\``));
        assert.ok(row && row.includes('[[PENDING'), `the run of ${f} is pending, not reported (${row})`);
        assert.ok(!/\b(passed|succeeded)\b/i.test(row.replace(PLACEHOLDER, '')), `and nothing in its row says it passed (${row})`);
      }
      // An honest skeleton is still not the row met.
      assert.fail(`the real lane has not run: the M2 report is a skeleton (${pending.length} pending facts)`);
    } else {
      assert.equal(pending.length, 0, `the real lane has not run: the M2 report is a skeleton (${pending.length} pending facts)`);
      assert.ok(existsSync(RECORDS), `the real lane's records are kept at ${RECORDS}`);
      const kept = readdirSync(RECORDS, { recursive: true }).map(String);
      assert.ok(kept.some((p) => p.endsWith('state.json')), 'with the run directory\'s state.json');
      for (const row of ['M136', 'M137', 'M138', 'M139', 'M140']) assert.ok(kept.some((p) => p.endsWith(`${row}.json`)), `and the observations of ${row}`);
      for (const f of REAL_FILES) {
        const row = runs.split('\n').find((l) => l.includes(`\`${f}\``));
        assert.ok(row && /\d{4}-\d{2}-\d{2}/.test(row), `the run of ${f} has its date and outcome (${row})`);
      }
    }
  });
});
