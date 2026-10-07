// Helpers for the M3 rows of slice 18, "what an execution establishes"
// (M216 to M223, and the cases slices 15 to 17 deferred to it; SEAM.md
// §§203 to 214): the runner self-test's switch and its record, recovery
// registrations, the test's own signal to a verified check program, the
// project's NOW, and host-side reads that what a check started is gone.
//
// SAFETY (E64; BS3 §4 rule 1; SEAM.md §§127, 128, 141). The one signal a
// test sends here is `killVerifiedProgram`: SIGKILL to a single host pid
// that the test has just read from the check domain's own `cgroup.procs`
// and confirmed, from `/proc/<pid>/cmdline`, to be the test-owned check
// program holding at the test's own release name, after `assertContained`
// has read the program contained. Never a negative pid, never 0 or 1, never
// -1, never any other process.

import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '../engine.mjs';
import { eventsOfType } from '../journal.mjs';
import { readProject } from '../reads.mjs';
import { signalPid, signallable } from '../proc.mjs';
import { procsOf } from '../sandbox/cgroup.mjs';
import { hostProcess } from '../sandbox/procs.mjs';
import { assertContained, parseMountinfo } from '../sandbox/view.mjs';
import { withStore } from '../store.mjs';
import { executionsOf, release } from './fixtures.mjs';

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// ---- the runner self-test (SEAM.md §208) -----------------------------------------------------

// The start arguments of a sandbox-lane engine that runs the runner
// self-test as a production start does; `forced` is {case: 'failed' |
// 'not_exercised'}, the harness's forcing of a case's recorded result.
export const selfTestArgs = (forced = {}) => [
  '--harness-runner-self-test',
  'run',
  ...Object.entries(forced).flatMap(([name, result]) => ['--harness-runner-self-test-case', `${name}=${result}`]),
];

// D3 §2.8's mandatory cases, by the names SEAM.md §208 fixes, in this order.
export const SELF_TEST_CASES = Object.freeze([
  'exit_zero',
  'exit_nonzero',
  'prints_passed_exits_nonzero',
  'foreign_signal',
  'deadline',
  'term_handled_after_cancel',
  'missing_program',
  'input_immutable',
  'orphan_stdout_closed',
  'egress',
]);

// The active host qualification row, its check_runner parsed; null when there is none.
export const activeQualification = (home) => {
  const row = withStore(home, (db) => db.prepare(`SELECT * FROM "host_qualifications" WHERE "status" = 'active'`).get());
  return row ? { ...row, check_runner: json(row.check_runner) } : null;
};

// Wait for this start's runner self-test to be recorded on the active host
// qualification (SEAM.md §208: check_runner is written once, when every case
// has been recorded). `notRow` is a previous start's row, which this start's
// is not. Returns the row.
export const waitSelfTest = (fx, { notRow = null, timeoutMs = 300_000 } = {}) =>
  waitFor(
    () => {
      const q = activeQualification(fx.home);
      if (!q || q.check_runner === null || q.check_runner === undefined) return undefined;
      if (notRow !== null && q.id === notRow) return undefined;
      return Array.isArray(q.check_runner.self_test) && q.check_runner.self_test.length > 0 ? q : undefined;
    },
    { timeoutMs, intervalMs: 500, what: "this start's runner self-test to be recorded on host_qualifications.check_runner" },
  );

export const selfTestEntry = (q, name) => q.check_runner.self_test.find((e) => e.case === name);

// Recorded mountinfo lines as mountsOfPid in fixtures.mjs reads a live
// process's: each mount with its mount id and parent id.
export const mountsOfLines = (lines) =>
  parseMountinfo(lines).map((m) => {
    const [id, parent] = m.line.split(' ');
    return { ...m, id, parent };
  });

// ---- recovery registrations (SEAM.md §204) ---------------------------------------------------

// The registrations that retry `original` (an execution row), following
// retry_of, in sequence.
export function retriesOf(rows, original) {
  const chain = [];
  let last = original.id;
  for (;;) {
    const next = rows.find((x) => x.retry_of === last);
    if (!next) return chain;
    chain.push(next);
    last = next.id;
  }
}

// The seq of the first event of `type` whose subject names the check execution.
export const eventSeqAbout = (home, type, execution) => eventsOfType(home, type).find((e) => e.subject?.check_execution === execution)?.seq ?? null;
export const eventsAboutExecution = (home, type, execution) => eventsOfType(home, type).filter((e) => e.subject?.check_execution === execution);
export const eventSeqOfDomain = (home, type, domain) => eventsOfType(home, type).find((e) => e.subject?.domain === domain)?.seq ?? null;

// ---- the project's NOW (SEAM.md §209) --------------------------------------------------------

export async function projectNow(engine, project) {
  const body = await readProject(engine, project);
  assert.ok(body.project.now && typeof body.project.now === 'object', `the project read has now (body: ${JSON.stringify(body.project).slice(0, 300)})`);
  return body.project.now;
}

// ---- release a held check program into a guarded mode ---------------------------------------

// The test's half of the guard (SEAM.md §§141, 198): read from the host that
// the held program is contained, and only then release it.
export function releaseContained(prog, held, name, what = `the ${held.key} check program`) {
  assertContained(held.domain, held.member, what);
  release(prog, name);
}

// ---- the test's one signal (SEAM.md §205; E64) -----------------------------------------------

// SIGKILL to the held check program and to nothing else. The pid is read
// again from the domain's cgroup.procs, and its command line must be the
// test's program holding at `holdName`; anything else, and anything that
// cannot be read, fails the case without sending a signal.
export function killVerifiedProgram(held, holdName) {
  assertContained(held.domain, held.member, `the ${held.key} check program, before the test signals it`);
  const pid = held.member.pid;
  assert.ok(signallable(pid), `the pid ${pid} is one a test may signal (an integer above 1, not the test's own)`);
  assert.ok(procsOf(held.domain.cgroup_path).includes(pid), `host-read just before the signal: pid ${pid} is a member of ${held.domain.cgroup_path}/cgroup.procs`);
  const now = hostProcess(pid);
  assert.ok(now, `host pid ${pid} is still there`);
  assert.equal(now.startTime, held.member.startTime, `host pid ${pid} is the same process the test found (its start time)`);
  assert.ok(
    now.cmdline.some((a) => a.endsWith('/program.mjs')) && now.cmdline.includes('--hold') && now.cmdline.includes(holdName),
    `host pid ${pid} is the test's check program holding at ${holdName} (cmdline ${JSON.stringify(now.cmdline)})`,
  );
  assert.equal(signalPid(pid, 'SIGKILL'), true, `SIGKILL reached host pid ${pid}, the check program`);
  return pid;
}

// ---- host-side reads ---------------------------------------------------------------------

// Host processes whose command line holds an argument containing `marker`.
export function hostProcessesWith(marker) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (args.some((a) => a.includes(marker))) found.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

// Every file under the engine home holding `needle` (raw bytes). A file that
// cannot be read is a failure (what it holds is unknown), except an
// execute-only regular file (mode 0111), the sandbox's own copy of node
// (SEAM.md §152's reading in M132), which is listed apart.
export function homeFilesHolding(home, needle) {
  const bytes = Buffer.from(needle);
  const found = [];
  const executeOnly = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        let content;
        try {
          content = readFileSync(path);
        } catch (err) {
          const st = lstatSync(path);
          if (err.code === 'EACCES' && (st.mode & 0o777) === 0o111) {
            executeOnly.push(path);
            continue;
          }
          throw new Error(`${path} cannot be read (${err.code}): what it holds is unknown`);
        }
        if (content.includes(bytes)) found.push(path);
      }
    }
  };
  walk(home);
  return { found, executeOnly };
}

// The latest execution of a key for a candidate.
export const latestOf = (home, candidate, key) => executionsOf(home, candidate).filter((x) => x.key === key).at(-1);

export const findingsOfProject = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"').all(project));

export const leaseOfExecution = (home, execution) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'check' AND "resource_id" = ? ORDER BY "acquired_at"`).all(execution));
