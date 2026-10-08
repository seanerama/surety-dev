// M240, the M3 acceptance report (M3 slice 22, manifest slice 22; no
// engine, nothing paid). M3 plan §3.8 M240; BS3 §10; D3 §6, Appendix C;
// E40; SEAM.md §238. M2's form: M141.
//
// The report (`docs/acceptance/reports/M3-report.md`) is the Verifier's,
// written after the lanes pass on `main`. Until then it is a skeleton: what
// is already true is filled, and every fact a run not yet made must supply is
// a placeholder `[[PENDING <label>: <what>; from <source>]]`. Case (a) holds
// the report to BS3 §10's list in either state. Case (b) FAILS while any
// placeholder remains (as M141 did, E88: "nothing described as passing that
// was not run"), after checking that the skeleton is honest: it says M3 is
// not accepted and reports no acceptance-run, real-lane or exhaustion result.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';
import { SELF_TEST_CASES } from './harness/checks/execution.mjs';

const REPORT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M3-report.md');
const RECORDS = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M3-real-lane');
const D3 = join(REPO_ROOT, 'docs', 'design', 'sdlc-design-D3-checks.md');
const PLAN = join(REPO_ROOT, 'docs', 'acceptance', 'sdlc-M3-acceptance-plan.md');
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

// D3 Appendix C's statements, read from D3 itself, and the plan's §4.1 map of each to its row.
function statements() {
  const ids = [...readFileSync(D3, 'utf8').matchAll(/^\| (D3-[PRCSFXJ]\d{2}) [a-z0-9-]+ \|/gm)].map((m) => m[1]);
  assert.equal(ids.length, 67, `D3 Appendix C has 67 statements (found ${ids.length})`);
  const plan = readFileSync(PLAN, 'utf8');
  const map = new Map();
  for (const line of plan.split('\n')) {
    const m = /^\| (D3-[^|]+) \| (M2\d\d) \|$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',').map((s) => s.trim())) {
      const range = /^D3-([A-Z])(\d{2}) to D3-\1(\d{2})$/.exec(part);
      if (range) for (let n = Number(range[2]); n <= Number(range[3]); n++) map.set(`D3-${range[1]}${String(n).padStart(2, '0')}`, m[2]);
      else map.set(part, m[2]);
    }
  }
  for (const id of ids) assert.ok(map.has(id), `the plan's §4.1 maps ${id} to a row`);
  return ids.map((id) => ({ id, row: map.get(id) }));
}

// D3 §6's class C paragraph, which the report carries verbatim.
function classC() {
  const line = readFileSync(D3, 'utf8').split('\n').find((l) => l.startsWith('**Class C.**'));
  assert.ok(line, 'D3 §6 has its class C paragraph');
  return line.replace('**Class C.** ', '').trim();
}

const ERRATA = ['E93', 'E94', 'E95', 'E96', 'E97', 'E98', 'E99', 'E100', 'E101'];

describe('M240 the M3 acceptance report records what BS3 §10 lists, and claims nothing it has not run', () => {
  test("(a) BS3 §10's contents: revisions; the host and its tools; the host qualification with the runner self-test's every case; the check profile's fingerprint; the classifier version and authority; every Appendix C statement's row with its result; the lanes; the exhaustion and real lanes; the not_exercised cases by name; what M3 does not claim from D3 §6 (class C verbatim); the open decisions of E93 to E101", () => {
    const md = text();
    const all = sections(md);
    assert.match(sectionLike(all, /^Revisions/), /`[0-9a-f]{7,40}`/, 'the revisions name commits');
    const host = sectionLike(all, /^The host$/);
    for (const fact of ['host_id', 'Kernel', 'WSL2', 'Distribution', 'util-linux', 'systemd', 'Node', 'git', 'SQLite']) assert.ok(host.includes(fact), `the host section records ${fact}`);
    const st = sectionLike(all, /self-test/);
    for (const c of SELF_TEST_CASES) assert.ok(st.includes(`\`${c}\``), `the runner self-test's case ${c} is named`);
    assert.ok(/control/i.test(st), 'with its control');
    assert.ok(sectionLike(all, /profile's fingerprint/).includes('profile_fingerprint'), "the check profile's fingerprint");
    const cl = sectionLike(all, /^The classifier$/);
    assert.ok(cl.includes('classifier_version') && cl.includes('classifier_authority'), 'the classifier version and the authority in force');
    const ac = sectionLike(all, /Appendix C statement/);
    for (const { id, row } of statements()) {
      const line = ac.split('\n').find((l) => l.startsWith('|') && new RegExp(`\\b${id}\\b`).test(l.split('|')[1] ?? '') && l.includes(`| ${row} |`));
      const range = ac.split('\n').find((l) => {
        const m = /^\| D3-([A-Z])(\d{2}) to D3-\1(\d{2})/.exec(l);
        return m && id.startsWith(`D3-${m[1]}`) && Number(id.slice(4)) >= Number(m[2]) && Number(id.slice(4)) <= Number(m[3]) && l.includes(`| ${row} |`);
      });
      assert.ok(line || range, `${id} is named with its row ${row}`);
      const cells = (line ?? range).split('|').map((c) => c.trim());
      assert.ok(cells.length >= 6 && cells[4].length > 0 && cells[5].length > 0, `${id}: its row's last recorded result and its acceptance result (or PENDING) are stated`);
    }
    for (const lane of ['kernel', 'sandbox', 'project']) assert.ok(sectionLike(all, /^The kernel, sandbox and project lanes/).includes('npm test') && ac.includes(lane), `the ${lane} lane's results`);
    assert.ok(sectionLike(all, /^The exhaustion lane/).includes('M205'), "the exhaustion lane's M205 (g)");
    assert.ok(sectionLike(all, /^The real lane's run/).includes('M239-the-real-check-journey'), "the real lane's M239");
    const notEx = sectionLike(all, /not_exercised/);
    for (const c of ['M205 (g)', 'foreign_signal']) assert.ok(notEx.includes(c), `the not_exercised case ${c} is named`);
    const hostFacts = notEx.split('\n').filter((l) => /^- /.test(l) && !/Not written/.test(l));
    assert.ok(!hostFacts.some((l) => /\*\*M239\*\*/.test(l)), 'M239, never run outside Sean\'s command, is not listed among the cases that pass by asserting a host fact (the slice-22 review)');
    const notClaimed = sectionLike(all, /^What M3 does not claim/);
    assert.ok(/class A/i.test(notClaimed) && /class B/i.test(notClaimed) && /class C/i.test(notClaimed), 'classes A, B and C');
    assert.ok(notClaimed.includes(classC()), "D3 §6's class C, verbatim");
    assert.match(notClaimed, /vacuous[^.]*limitation, never evidence of guarded execution/, "the bare node --test's vacuous pass, a limitation (D3 §6 class B; T18)");
    const open = sectionLike(all, /^Open decisions/);
    for (const e of ERRATA) assert.ok(new RegExp(`\\b${e}\\b`).test(open), `the open decisions and provisional readings of ${e}`);
    assert.ok(sectionLike(all, /^Hands-on run/).includes('M3-hands-on.sh') && sectionLike(all, /^Limits of the instruments/).length > 0 && sectionLike(all, /^The real check journey/).length > 0, "the hands-on run, the instruments' limits and the real journey (BS3 §10)");
  });

  test('(b) the report is final: no pending fact remains and the real lane\'s records exist (it fails while the report is a skeleton, after checking that the skeleton claims nothing it has not run)', () => {
    const md = text();
    const status = statusOf(md);
    assert.ok(status, 'the report states its status, skeleton or final');
    const pending = md.match(PLACEHOLDER) ?? [];
    const all = sections(md);
    const real = sectionLike(all, /^The real lane's run/);
    const row = real.split('\n').find((l) => l.includes('`M239-the-real-check-journey`'));
    if (status === 'skeleton') {
      assert.match(md, /\*\*M3 is not accepted\.\*\*/, 'a skeleton says plainly that M3 is not accepted');
      assert.ok(pending.length > 0, 'and marks what the runs are to supply');
      assert.ok(row && row.includes('[[PENDING') && !/\b(passed|succeeded)\b/i.test(row.replace(PLACEHOLDER, '')), `the real run is pending, not reported (${row})`);
      const conditions = sectionLike(all, /^What M3 claims/).split('\n').filter((l) => /npm test|exhaust|real-lane row M239|self-test passed/.test(l));
      for (const l of conditions) assert.ok(l.includes('[[PENDING') && !/\*\*(Met|Passed)/.test(l), `an unmet condition is pending, never reported met (${l.slice(0, 160)})`);
      for (const l of sectionLike(all, /Appendix C statement/).split('\n').filter((x) => /^\| D3-/.test(x))) {
        const acceptance = l.split('|').map((c) => c.trim())[5] ?? '';
        assert.ok(acceptance.startsWith('[[PENDING'), `no acceptance-run result is reported before the run (${l.slice(0, 120)})`);
      }
      for (const row of ['acc-M201', 'acc-M237', 'acc-M239-sandbox', 'acc-M240', 'acc-M241']) assert.ok(md.includes(`[[PENDING ${row}:`), `the acceptance-run result of ${row.slice(4)} is pending, not reported`);
      // An honest skeleton is still not the row met.
      assert.fail(`the acceptance, exhaustion and real runs have not been recorded: the M3 report is a skeleton (${pending.length} pending facts)`);
    } else {
      assert.equal(pending.length, 0, `the M3 report is final, with no pending fact (${pending.length} remain)`);
      assert.ok(existsSync(RECORDS), `the real lane's records are kept at ${RECORDS}`);
      const kept = readdirSync(RECORDS, { recursive: true }).map(String);
      assert.ok(kept.some((p) => p.endsWith('state.json')), "with the run directory's state.json");
      assert.ok(kept.some((p) => p.endsWith('M239.json')), 'and the observations of M239');
      assert.ok(row && /\d{4}-\d{2}-\d{2}/.test(row), `the run of M239 has its date and outcome (${row})`);
    }
  });
});
