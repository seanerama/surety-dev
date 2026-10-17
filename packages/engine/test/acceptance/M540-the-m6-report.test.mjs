// M540, the M6 acceptance report (M6 slice 46, manifest slice 46; no engine,
// nothing paid). M6 plan §3.8 M540; BS6 §13, §1; D7 §15, §13, Appendix C;
// E156 Q2, Q4, Q5, Q6; SEAM.md §545. M5's form: M445.
//
// The report (`docs/acceptance/reports/M6-report.md`) is the Verifier's,
// written after the lanes pass on `main`, the exhaust lane runs at the final
// revision and the two real runs are made. Until then it is a skeleton:
// every fact a run must supply is a placeholder
// `[[PENDING <label>: not yet run; from <source>]]`. Case (a) holds the
// report to BS6 §13's list and the plan row's in either state: every row
// M501 to M546 with its lane as the plan states it; every D7 Appendix C row
// (read from D7 itself) with the plan row that carries it (read from the
// plan's §4.1); the per-act table with its columns (E156 Q6) and M535's four
// central acts; the Designers' usage and the preview's memory.peak against
// the two trial defaults (E156 Q4); M519's defects before M535 (E156 Q5).
// Case (b) FAILS while any placeholder remains or the status is `skeleton`
// ("nothing described as passing that was not run"), after checking that
// the skeleton is honest: it says M6 is not accepted.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const REPORT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M6-report.md');
const D7 = join(REPO_ROOT, 'docs', 'design', 'sdlc-design-D7-designer.md');
const PLAN = join(REPO_ROOT, 'docs', 'acceptance', 'sdlc-M6-acceptance-plan.md');
const PLACEHOLDER = /\[\[PENDING [^\]]+\]\]/g;

const text = () => readFileSync(REPORT, 'utf8');
const headings = (md) => [...md.matchAll(/^## \d+\. (.+)$/gm)].map((m) => m[1]);
const statusOf = (md) => /^\*\*Status:\*\* (skeleton|final)\b/m.exec(md)?.[1] ?? null;
// The body of the section whose heading matches `want`.
function section(md, want) {
  const parts = md.split(/^(?=## \d+\. )/m);
  return parts.find((p) => want.test(/^## \d+\. (.+)$/m.exec(p)?.[1] ?? '')) ?? '';
}

// BS6 §13's contents and the plan row's, each a section of the report.
const SECTIONS = [
  /^What M6 claims/,
  /^Revisions/,
  /^The host$/,
  /trust entries/,
  /host qualification/,
  /adoption of BS6[\s\S]*E156[\s\S]*Q1 to Q8/,
  /D7's decisions/,
  /configuration in force/,
  /^Every row and its result/,
  /Appendix C row[\s\S]*plan row/,
  /^The straddles/,
  /kernel, sandbox and project lanes[\s\S]*split gate/,
  /project-lane journeys and their pace reads/,
  /exhaustion lane[\s\S]*Q8/,
  /rehearsals/,
  /\(M519\)/,
  /M519's defects[\s\S]*before M535[\s\S]*Q5/,
  /\(M535\)/,
  /owner act[\s\S]*who performed it[\s\S]*Q6/,
  /pace reads of the real runs/,
  /Designers' measured usage[\s\S]*memory\.peak[\s\S]*trial defaults[\s\S]*Q4/,
  /design trees approved[\s\S]*review files/,
  /G7's trigger[\s\S]*naming deviation[\s\S]*Q2/,
  /carried defects/,
  /not_exercised/,
  /\(M537\)/,
  /What M6 does not claim/,
  /Limits of the instruments/,
];

// The plan's rows, each with its lane (§3).
function planRows() {
  const rows = new Map();
  for (const line of readFileSync(PLAN, 'utf8').split('\n')) {
    const m = /^\| (M5\d\d) \|.*\| ([a-z, -]+) \| (\d\d) \|$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  assert.equal(rows.size, 46, `the plan has 46 rows, M501 to M546 (found ${rows.size})`);
  return rows;
}

// D7 Appendix C's rows, read from D7, each with the plan row §4.1 carries it by.
function appendixC() {
  const d7 = readFileSync(D7, 'utf8');
  const start = d7.indexOf('## Appendix C.');
  assert.ok(start >= 0, 'D7 has an Appendix C');
  const end = d7.indexOf('\n## ', start + 1);
  const ids = [...new Set([...d7.slice(start, end < 0 ? undefined : end).matchAll(/^\| (M5\d\d) \|/gm)].map((m) => m[1]))];
  assert.equal(ids.length, 35, `D7 Appendix C sketches 35 rows (found ${ids.length})`);
  const map = new Map();
  for (const line of readFileSync(PLAN, 'utf8').split('\n')) {
    const m = /^\| (M5\d\d) \| (M5\d\d) \|/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return ids.map((id) => ({ id, row: map.get(id) }));
}

describe('M540 the M6 acceptance report records what BS6 §13 lists, and claims nothing it has not run', () => {
  test("(a) BS6 §13's contents, each a section; every row with its lane; every D7 Appendix C row with its plan row; the per-act table with M535's four acts; the Designer usage and preview peak against the defaults; M519's defects before M535", () => {
    assert.ok(existsSync(REPORT), 'the report exists');
    const md = text();
    const hs = headings(md);
    for (const want of SECTIONS) assert.equal(hs.filter((h) => want.test(h)).length, 1, `one section matching ${want} (headings: ${hs.join(' | ')})`);

    for (const [id, lane] of planRows()) {
      const esc = lane.replace(/[-,]/g, (c) => `\\${c}`);
      assert.match(md, new RegExp(`^\\| ${id} \\| ${esc} \\|`, 'm'), `${id} is listed with its lane ${lane}`);
    }
    for (const { id, row } of appendixC()) {
      assert.ok(row, `the plan's §4.1 maps D7's ${id} to a row`);
      assert.match(md, new RegExp(`^\\| D7 ${id} \\| ${row} \\|`, 'm'), `D7's ${id} is listed with its plan row ${row}`);
    }

    // E156 Q6: the per-act table, its columns, and M535's four central acts named.
    const acts = section(md, /owner act/);
    assert.match(acts, /^\| Run \| Act \| Route \| Performed by \| Evidence beyond the store's human actor \|$/m, 'the per-act table: run, act, route, who performed it, evidence beyond the human actor');
    assert.match(acts, /Sean, the driver on a quoted instruction, or `unknown`/, 'its performers: Sean, the driver on a quoted instruction, or unknown');
    assert.match(acts, /`human` alone is never counted/, 'an API actor human alone is never counted as Sean\'s act');
    for (const act of [/Designer feedback/, /preview inspection/, /combined approval/, /review confirmation/]) {
      assert.match(acts, new RegExp(`^\\| M535 \\| [^|]*${act.source}`, 'm'), `M535's ${act.source} has its row`);
    }
    for (const evidence of [/owner-acts\.jsonl/, /driver-acts\.jsonl/]) assert.match(acts, evidence, `the evidence names ${evidence.source}`);

    // E156 Q4: the Designers' usage and the preview's peak against the trial defaults.
    const usage = section(md, /Designers' measured usage/);
    for (const want of [/turns/, /billable, cached and output tokens/, /per session and per turn/, /designer_session_budget_billable_tokens`? \(3,000,000/, /preview_memory_max`? \(256 MiB/, /errata/]) assert.match(usage, want, `the usage section names ${want.source}`);

    // E156 Q5: M519's defects and their fixes before M535 started.
    const defects = section(md, /M519's defects/);
    for (const want of [/workaround/, /fix on `main`/, /commit/, /rehearsal passed on the revision M535 ran/]) assert.match(defects, want, `the defects section names ${want.source}`);

    if (statusOf(md) === 'final') assert.ok(existsSync(join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M6-not-claimed.md')), 'M6-not-claimed.md beside the final report');
  });

  test('(b) the report is final: no placeholder is left (a skeleton fails here, and says M6 is not accepted)', () => {
    const md = text();
    const status = statusOf(md);
    assert.ok(['skeleton', 'final'].includes(status), `the report says whether it is a skeleton or final (${status})`);
    const left = md.match(PLACEHOLDER) ?? [];
    if (status === 'skeleton') assert.match(md, /M6 is not accepted/, 'a skeleton says M6 is not accepted');
    assert.equal(status, 'final', 'the report is final (it is written after the lanes pass on main, the exhaust lane runs and the real runs are made)');
    assert.deepEqual(left, [], 'no placeholder is left');
  });
});
