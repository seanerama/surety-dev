// M343, the M4 acceptance report (M4 slice 30, manifest slice 30; no
// engine, nothing paid). M4 plan §3.8 M343; BS4 §13; D4 §11, Appendix C,
// C.2; E40; SEAM.md §337. M3's form: M240 (M2's: M141).
//
// The report (`docs/acceptance/reports/M4-report.md`) is the Verifier's,
// written after the lanes pass on `main`. Until then it is a skeleton: what
// is already recorded is cited, and every fact a run not yet made must
// supply is a placeholder `[[PENDING <label>: not yet run; from <source>]]`.
// Case (a) holds the report to BS4 §13's list in either state, with every
// D4 Appendix C statement read from D4 itself and its row from the plan's
// §4.1, D4 §11's class C verbatim, and the not-claimed list's carried items.
// Case (b) FAILS while any placeholder remains (as M141 and M240 did, E88:
// "nothing described as passing that was not run"), after checking that the
// skeleton is honest: it says M4 is not accepted and reports no
// acceptance-run, exhaustion-lane, qualification or real-lane result.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';
import { ADAPTER_CASES } from './harness/deploy/qualify.mjs';

const REPORT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M4-report.md');
const NOT_CLAIMED = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M4-not-claimed.md');
const RECORDS = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M4-real-lane');
const D4 = join(REPO_ROOT, 'docs', 'design', 'sdlc-design-D4-deployment.md');
const PLAN = join(REPO_ROOT, 'docs', 'acceptance', 'sdlc-M4-acceptance-plan.md');
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

// D4 Appendix C's statements, read from D4 itself, and the plan's §4.1 map of each to its row.
function statements() {
  const ids = [...readFileSync(D4, 'utf8').matchAll(/^\| (D4-[AIOVNSRT]\d{2}) [a-z0-9-]+ \|/gm)].map((m) => m[1]);
  assert.equal(ids.length, 63, `D4 Appendix C has 63 statements (found ${ids.length})`);
  const map = new Map();
  for (const line of readFileSync(PLAN, 'utf8').split('\n')) {
    const m = /^\| (D4-[^|]+) \| (M3\d\d) \|$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',').map((s) => s.trim())) map.set(part, m[2]);
  }
  for (const id of ids) assert.ok(map.has(id), `the plan's §4.1 maps ${id} to a row`);
  return ids.map((id) => ({ id, row: map.get(id) }));
}

// D4 §11's class C paragraph, which the report carries verbatim.
function classC() {
  const line = readFileSync(D4, 'utf8').split('\n').find((l) => l.startsWith('**Class C.**'));
  assert.ok(line, 'D4 §11 has its class C paragraph');
  return line.replace('**Class C.** ', '').trim();
}

const ERRATA = ['E122', 'E123', 'E124', 'E125', 'E126', 'E127', 'E128', 'E129', 'E130', 'E131'];
const NUMERIC = ['deploy_orchestration_deadline', 'artifact_max_entries', 'artifact_max_bytes', 'artifacts_max_bytes', 'artifact_prepare_deadline', 'adapter_read_deadline'];

describe('M343 the M4 acceptance report records what BS4 §13 lists, and claims nothing it has not run', () => {
  test("(a) BS4 §13's contents: revisions; the host and its tools; the host qualification; the probe's confirmation; the adapter qualification's every case, control and evidence, the service profile's fingerprint and the tools' paths and versions; the configuration with §11.3's values and CD1 to CD4; the identity-read durations and host time; every Appendix C statement's row with its result; the lanes; the exhaustion and real lanes; the not_exercised cases by name; the C.2 migrations; what M4 does not claim from D4 §11 (class C verbatim), with the carried items", () => {
    const md = text();
    const all = sections(md);
    assert.match(sectionLike(all, /^Revisions/), /`[0-9a-f]{7,40}`/, 'the revisions name commits');
    const host = sectionLike(all, /^The host$/);
    for (const fact of ['host_id', 'Kernel', 'WSL2', 'Distribution', 'systemd', '`systemd-run`', 'Node', 'git', 'SQLite']) assert.ok(host.includes(fact), `the host section records ${fact}`);
    const hq = sectionLike(all, /^The host qualification/);
    assert.ok(/H1 to H12/.test(hq) && /self-test/.test(hq), 'the host qualification and the runner self-test');
    const probe = sectionLike(all, /^The probe's confirmation/);
    assert.ok(/\bE122\b/.test(probe) && /\bE95\b/.test(probe), "the probe's confirmation entry (E122; E95)");
    const aq = sectionLike(all, /^The adapter qualification/);
    for (const c of ADAPTER_CASES) assert.ok(aq.includes(`\`${c}\``), `the qualification's case ${c} is named`);
    assert.ok(/control/i.test(aq) && /evidence/i.test(aq), 'with its control and its evidence');
    assert.ok(aq.includes('profile_fingerprint'), "the service profile's fingerprint");
    assert.ok(aq.includes('`systemd-run`') && aq.includes('`systemctl`') && /path/.test(aq) && /version/.test(aq), "the host tools' paths and versions");
    const config = sectionLike(all, /^The configuration in force/);
    for (const key of NUMERIC) assert.ok(config.includes(`\`${key}\``), `§11.3's ${key} as approved`);
    for (const cd of ['CD1', 'CD2', 'CD3', 'CD4']) assert.ok(new RegExp(`\\b${cd}\\b`).test(config), `${cd} as confirmed`);
    assert.ok(/\bE121\b/.test(config), 'as E121 adopted them');
    const durations = sectionLike(all, /identity-read durations/i);
    for (const w of ['host_time_ms', 'duration_ms', 'adapter_read_deadline']) assert.ok(durations.includes(w), `the durations section names ${w}`);
    const ac = sectionLike(all, /Appendix C statement/);
    for (const { id, row } of statements()) {
      const line = ac.split('\n').find((l) => l.startsWith('|') && new RegExp(`\\b${id}\\b`).test(l.split('|')[1] ?? '') && l.includes(`| ${row} |`));
      assert.ok(line, `${id} is named with its row ${row}`);
      const cells = line.split('|').map((c) => c.trim());
      assert.ok(cells.length >= 6 && cells[3].length > 0 && cells[4].length > 0 && cells[5].length > 0, `${id}: its lane, its row's last recorded result and its acceptance result (or PENDING) are stated`);
    }
    const lanes = sectionLike(all, /^The kernel, sandbox and project lanes/);
    assert.ok(lanes.includes('npm test'), 'the kernel, sandbox and project lanes\' run');
    for (const lane of ['kernel', 'sandbox', 'project']) assert.ok(ac.includes(`| ${lane}`), `the ${lane} lane's rows`);
    assert.ok(sectionLike(all, /^The exhaustion lane/).includes('M341'), "the exhaustion lane's M341");
    assert.ok(sectionLike(all, /^The real lane's run/).includes('M342-the-real-deployment-journey'), "the real lane's M342");
    assert.ok(sectionLike(all, /^The real deployment journey/).length > 0, 'the real journey');
    const notEx = sectionLike(all, /not_exercised/);
    for (const c of ['M341', 'M342']) assert.ok(notEx.includes(`**${c}**`), `the not_exercised case ${c} is named`);
    const c2 = sectionLike(all, /^The C\.2 migrations/);
    for (const r of ['M08', 'M01', 'M44', 'M140']) assert.ok(new RegExp(`\\b${r}\\b`).test(c2), `the C.2 migration of ${r}`);
    const notClaimed = sectionLike(all, /^What M4 does not claim/);
    assert.ok(/class A/i.test(notClaimed) && /class B/i.test(notClaimed) && /class C/i.test(notClaimed), 'classes A, B and C');
    assert.ok(notClaimed.includes(classC()), "D4 §11's class C, verbatim");
    for (const [what, pattern] of [
      ['reattachment after an engine restart', /reattachment after an engine restart/i],
      ["a surviving service's old secret versions", /old secret versions/i],
      ['the build execution', /build execution/i],
      ['rollback', /\brollback\b/i],
      ['Beta and Live', /Beta and Live/],
      ['every adapter but local_service', /any adapter but `local_service`/],
      ['enduring effects on a stateful target', /enduring effects[\s\S]*stateful target/i],
      ['a restart of the user manager or the host', /restart of the user's service manager or of the host/i],
      ['a same-runtime, same-argument re-exec', /same-runtime, same-argument re-exec/i],
      ['continuous attestation between a round\'s reads', /continuous attestation/i],
      ['whether a post-deploy check tests the right behaviour', /tests the right behaviour/i],
      ['artifact eviction (question 7)', /artifact eviction[\s\S]*question 7/i],
      ['M315 (b)', /M315 \(b\)/],
      ['M329 (b)', /M329 \(b\)/],
      ['the same-uid ptracer', /same-uid ptracer/i],
      ['M341 off the designated host', /M341 off the designated host/],
    ]) assert.match(notClaimed, pattern, `what M4 does not claim names ${what}`);
    assert.ok(notClaimed.includes('M4-not-claimed.md'), 'and refers to the list behind it');
    const open = sectionLike(all, /^Open decisions/);
    for (const e of ERRATA) assert.ok(new RegExp(`\\b${e}\\b`).test(open), `the open decisions and provisional readings of ${e}`);
    assert.ok(sectionLike(all, /^Hands-on run/).includes('M4-hands-on.sh') && sectionLike(all, /^Limits of the instruments/).length > 0, "the hands-on run and the instruments' limits (BS4 §13)");
    // The list behind section 18 carries every item the errata and the slice-29 review sent to M343.
    const nc = readFileSync(NOT_CLAIMED, 'utf8');
    for (const [what, pattern] of [
      ['M315 (b)', /M315 \(b\)/],
      ['M329 (b)', /M329 \(b\)/],
      ['the same-uid ptracer (D2 §8 class C)', /same-uid ptracer[\s\S]*D2 §8 class C/i],
      ['M341 off the designated host', /M341 off the designated host/],
      ['retention (question 7)', /question 7/],
      ["D4 §11's classes", /D4 §11, class A[\s\S]*D4 §11, class B[\s\S]*D4 §11, class C/],
    ]) assert.match(nc, pattern, `M4-not-claimed.md carries ${what}`);
    for (const e of ['E128', 'E130', 'E131']) assert.ok(new RegExp(`\\b${e}\\b`).test(nc), `M4-not-claimed.md cites ${e}, which carried items to M343`);
  });

  test("(b) the report is final: no pending fact remains and the real lane's records exist (it fails while the report is a skeleton, after checking that the skeleton claims nothing it has not run)", () => {
    const md = text();
    const status = statusOf(md);
    assert.ok(status, 'the report states its status, skeleton or final');
    const pending = md.match(PLACEHOLDER) ?? [];
    const all = sections(md);
    const real = sectionLike(all, /^The real lane's run/);
    const row = real.split('\n').find((l) => l.includes('`M342-the-real-deployment-journey`'));
    if (status === 'skeleton') {
      assert.match(md, /\*\*M4 is not accepted\.\*\*/, 'a skeleton says plainly that M4 is not accepted');
      assert.ok(pending.length > 0, 'and marks what the runs are to supply');
      for (const p of pending) assert.match(p, /: not yet run; from /, `each placeholder says it was not yet run and where its fact will come from (${p})`);
      assert.ok(row && row.includes('[[PENDING') && !/\b(passed|succeeded)\b/i.test(row.replace(PLACEHOLDER, '')), `the real run is pending, not reported (${row})`);
      const conditions = sectionLike(all, /^What M4 claims/).split('\n').filter((l) => /npm test|qualify-adapter|M341|M342|hands-on/.test(l) && l.startsWith('|'));
      assert.ok(conditions.length >= 4, 'the conditions of BS4 §1 are listed');
      for (const l of conditions) assert.ok(l.includes('[[PENDING') && !/\*\*(Met|Passed)/.test(l), `an unmet condition is pending, never reported met (${l.slice(0, 160)})`);
      for (const l of sectionLike(all, /Appendix C statement/).split('\n').filter((x) => /^\| D4-/.test(x))) {
        const acceptance = l.split('|').map((c) => c.trim())[5] ?? '';
        assert.ok(acceptance.startsWith('[[PENDING'), `no acceptance-run result is reported before the run (${l.slice(0, 120)})`);
      }
      const aq = sectionLike(all, /^The adapter qualification/);
      for (const c of ADAPTER_CASES) {
        const line = aq.split('\n').find((l) => l.includes(`\`${c}\``));
        assert.ok(line?.includes('[[PENDING'), `the qualification's ${c} is pending, not reported (${line})`);
      }
      assert.ok(sectionLike(all, /^The exhaustion lane/).includes('[[PENDING'), 'the exhaustion lane is pending, not reported');
      assert.ok(sectionLike(all, /^Hands-on run/).includes('[[PENDING'), 'the hands-on run is pending, not reported');
      // An honest skeleton is still not the row met.
      assert.fail(`the acceptance, exhaustion, qualification and real runs have not been recorded: the M4 report is a skeleton (${pending.length} pending facts)`);
    } else {
      assert.equal(pending.length, 0, `the M4 report is final, with no pending fact (${pending.length} remain)`);
      assert.ok(existsSync(RECORDS), `the real lane's records are kept at ${RECORDS}`);
      const kept = readdirSync(RECORDS, { recursive: true }).map(String);
      assert.ok(kept.some((p) => p.endsWith('state.json')), "with the run directory's state.json");
      assert.ok(kept.some((p) => p.endsWith('M342.json')), 'and the observations of M342');
      assert.ok(row && /\d{4}-\d{2}-\d{2}/.test(row), `the run of M342 has its date and outcome (${row})`);
    }
  });
});
