// M445, the M5 acceptance report (M5 slice 38, manifest slice 38; no
// engine, nothing paid). M5 plan §3.8 M445; BS5 §13; D6 §11, Appendix C,
// C.2; E40; SEAM.md §458. M4's form: M343.
//
// The report (`docs/acceptance/reports/M5-report.md`) is the Verifier's,
// written after the lanes pass on `main` and the two real runs are made.
// Until then it is a skeleton: every fact a run must supply is a placeholder
// `[[PENDING <label>: not yet run; from <source>]]`. Case (a) holds the
// report to BS5 §13's list in either state, with every D6 Appendix C
// statement read from D6 itself and its row from the plan's §4.1. Case (b)
// FAILS while any placeholder remains or the status is `skeleton` (as M343
// did until M4's runs: "nothing described as passing that was not run"),
// after checking that the skeleton is honest: it says M5 is not accepted.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';

const REPORT = join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M5-report.md');
const D6 = join(REPO_ROOT, 'docs', 'design', 'sdlc-design-D6-idea-to-alpha.md');
const PLAN = join(REPO_ROOT, 'docs', 'acceptance', 'sdlc-M5-acceptance-plan.md');
const PLACEHOLDER = /\[\[PENDING [^\]]+\]\]/g;

const text = () => readFileSync(REPORT, 'utf8');
const headings = (md) => [...md.matchAll(/^## \d+\. (.+)$/gm)].map((m) => m[1]);
const statusOf = (md) => /^\*\*Status:\*\* (skeleton|final)\b/m.exec(md)?.[1] ?? null;

// BS5 §13's contents, each a section of the report.
const SECTIONS = [
  /^What M5 claims/,
  /^Revisions/,
  /^The host$/,
  /trust entries/,
  /host qualification/,
  /D6 draft 3's approval and Astra's review/,
  /configuration in force[\s\S]*numerics[\s\S]*readings/,
  /Every Appendix C statement/,
  /C\.2 migrations/,
  /kernel, sandbox and project lanes/,
  /project-lane journeys and their pace reads/,
  /exhaustion lane/,
  /rehearsals/,
  /\(M443\)/,
  /\(M444\)/,
  /human acts as they were made/,
  /pace reads of the real runs/,
  /memory\.peak/,
  /not_exercised/,
  /What M5 does not claim/,
  /Limits of the instruments/,
];

function statements() {
  const ids = [...new Set([...readFileSync(D6, 'utf8').matchAll(/^\| (D6-[A-Z]+\d{2}) [a-z0-9-]+/gm)].map((m) => m[1]))];
  assert.equal(ids.length, 67, `D6 Appendix C has 67 statements (found ${ids.length})`);
  const map = new Map();
  for (const line of readFileSync(PLAN, 'utf8').split('\n')) {
    const m = /^\| (D6-[^|]+) \| (M4\d\d)/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',')) map.set(part.replace(/\s*\(new\)/, '').trim(), m[2]);
  }
  return ids.map((id) => ({ id, row: map.get(id) }));
}

describe('M445 the M5 acceptance report records what BS5 §13 lists, and claims nothing it has not run', () => {
  test("(a) BS5 §13's contents, each a section; every D6 Appendix C statement with its plan row; the not-claimed list beside it once final", () => {
    assert.ok(existsSync(REPORT), 'the report exists');
    const md = text();
    const hs = headings(md);
    for (const want of SECTIONS) assert.equal(hs.filter((h) => want.test(h)).length, 1, `one section matching ${want} (headings: ${hs.join(' | ')})`);
    for (const { id, row } of statements()) {
      assert.ok(row, `the plan's §4.1 maps ${id} to a row`);
      assert.match(md, new RegExp(`^\\| ${id} [a-z0-9-]+ \\| ${row} \\|`, 'm'), `${id} is listed with its row ${row}`);
    }
    if (statusOf(md) === 'final') assert.ok(existsSync(join(REPO_ROOT, 'docs', 'acceptance', 'reports', 'M5-not-claimed.md')), 'M5-not-claimed.md beside the final report');
  });

  test('(b) the report is final: no placeholder is left (a skeleton fails here, and says M5 is not accepted)', () => {
    const md = text();
    const status = statusOf(md);
    assert.ok(['skeleton', 'final'].includes(status), `the report says whether it is a skeleton or final (${status})`);
    const left = md.match(PLACEHOLDER) ?? [];
    if (status === 'skeleton') assert.match(md, /M5 is not accepted/, 'a skeleton says M5 is not accepted');
    assert.equal(status, 'final', 'the report is final (it is written after the lanes pass on main and the real runs are made)');
    assert.deepEqual(left, [], 'no placeholder is left');
  });
});
