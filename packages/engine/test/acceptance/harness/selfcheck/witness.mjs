// Part 9 of the harness self-check: the slice-2 acceptance files run against
// the witness engine (witness-engine.mjs).
//
//   - Satisfiable: every test of every slice-2 file passes against it. The
//     only failure in each file is the marker test the harness adds whenever
//     it is pointed at the witness, which is what keeps such a run from ever
//     counting as an acceptance run.
//   - They bite: with one defect switched on in the witness, the test that
//     is meant to catch that defect fails.
//
// This shows the tests can be passed and are not vacuous. It does not show
// that the engine passes them, and it validates nothing about the witness.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WITNESS_MARKER } from '../engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ACCEPTANCE = join(here, '..', '..');
const WITNESS = join(here, 'witness-engine.mjs');
const REPORTER = join(here, 'json-reporter.mjs');

// Every file the manifest lists for slice 2.
export const SLICE2_FILES = JSON.parse(readFileSync(join(ACCEPTANCE, 'manifest.json'), 'utf8')).slices['2'];

// [defect switched on in the witness, file, the test that must fail]
export const MUTANTS = [
  ['review_integrates', 'M09-work-transitions', 'review: illegal edges from every status it can reach'],
  ['refused_edge_leaves_a_trace', 'M09-work-transitions', 'verification: illegal edges from every status it can reach'],
  ['grant_not_revoked', 'M09-work-paths', 'a verification item runs eligible → claimed → executing → complete'],
  ['lease_not_released', 'M09-work-paths', 'a review item runs eligible → claimed → executing → complete'],
  ['launch_twice', 'M09-work-paths', 'a verification item runs eligible → claimed → executing → complete'],
  ['env_inherited', 'M09-work-paths', 'a fix item runs eligible → claimed → executing'],
  ['no_ledger_row', 'M02-dispatch-identity', 'two dispatched runs of one role have identities of their own'],
  ['allocate_new_receipt', 'M02-dispatch-identity', 'allocating the receipt of one run again, repeatedly and concurrently, returns that receipt and launches nothing'],
  ['recovery_after_full', 'M06-restart-recovery', 'the recovery step ends a run that was executing and terminates its domain before full mode'],
  ['replacement_after_recovery', 'M06-restart-recovery', 'the recovery step ends a run that was executing and terminates its domain before full mode'],
  ['engine_limit_ignored', 'M07-settings-used-by-scheduler', 'by default the engine runs two projects at once and no more'],
  ['excluded_kind_dispatches', 'M08-scheduler-capability-refusals', 'a work item of an excluded kind that is in the store anyway is never launched, while permitted work is'],
  ['never_launched_charged', 'M08-scheduler-capability-refusals', 'without the harness, a dispatch is refused before launch with backend_refused'],
  ['trigger_duplicates', 'M10-trigger-identity', 'a trigger observed again before completion, after a refusal, after a restart and after success creates nothing'],
  ['repair_unbounded', 'M11-repair-limits', 'work whose every run fails is launched once plus the permitted repairs, then parks with its cause'],
  ['unknown_usage_zero', 'M11-repair-limits', 'a result that is not valid is a failed run, counted once however often it is sent, and a repair that succeeds completes'],
  ['preflight_unbounded', 'M11-repair-limits', 'runs refused before launch are counted on their own and park the work at their limit'],
  ['paused_dispatches', 'M12-scheduling-boundaries', 'a paused project dispatches nothing while the other progresses'],
  ['dispatch_held', 'M12-scheduling-boundaries', 'a held item is never launched while the other project progresses'],
  ['ignore_dispatch_hold', 'M12-scheduling-boundaries', 'an item on dispatch hold is never launched while the other project progresses'],
  ['depends_on_ignored', 'M12-scheduling-boundaries', 'an item is not launched before the work it depends on is complete'],
  ['no_one_run_per_project', 'M12-scheduling-boundaries', 'a project has one run at a time'],
  ['engine_limit_ignored', 'M12-scheduling-boundaries', 'concurrency across projects is bounded by the engine setting'],
  ['late_success_completes', 'M13-stop', 'verification: the role is fenced, the run ends stopped, the work is held, and Resume starts a new run'],
  ['no_parent_link', 'M13-stop', 'review: the role is fenced, the run ends stopped, the work is held, and Resume starts a new run'],
  ['spawn_after_stop', 'M13-stop', 'fix: a run stopped before its role was spawned leaves no role running and holds the work'],
  ['stop_ends_before_termination', 'M13-stop', 'while the boundary still reports the domain running, the stopped run is not ended and the work is not held'],
  ['stop_without_confirm', 'M13-stop', 'Stop needs its confirmation, a stale confirmation does nothing, and a run is stopped only through its own project'],
  ['abandon_no_hold', 'M14-abandon', 'verification: termination is confirmed, the workspace is discarded, and the work waits under a dispatch hold'],
  ['discard_before_termination', 'M14-abandon', 'while the boundary reports the domain running, the workspace stays, and no new trigger is dispatched onto the project'],
  ['late_success_completes', 'M15-deadlines', 'a run past its deadline is cancelled, a late success changes nothing, and other work is not disturbed'],
  ['timeout_ignores_boundary', 'M15-deadlines', 'a deadline is not observed termination: with the boundary still reporting the domain running, the run is quarantined'],
  ['late_step_dispatches', 'M15-deadlines', 'a prerequisite step that overruns its budget suppresses that project for the tick, late completion included'],
  ['tick_budget_ignored', 'M15-deadlines', 'a tick that has used up its budget dispatches nothing more'],
  ['parent_exit_is_termination', 'M16-quarantine', 'the role process exited, but the boundary still reports the domain running'],
  ['quarantine_dispatches', 'M16-quarantine', 'the role process exited, but the boundary still reports the domain running'],
  ['unknown_is_terminated', 'M16-quarantine', 'the boundary cannot read membership'],
  ['acknowledge_clears_quarantine', 'M16-quarantine', 'cancellation fails: the boundary keeps reporting the domain running after Stop'],
  ['clearance_revives_grant', 'M17-quarantine-clearance', 'a stopped run whose cancellation failed ends as stopped when the boundary reports its domain empty'],
  ['cleanup_repeats', 'M17-quarantine-clearance', 'a stopped run whose cancellation failed ends as stopped when the boundary reports its domain empty'],
  ['boundary_read_once', 'M17-quarantine-clearance', 'a stopped run whose cancellation failed ends as stopped when the boundary reports its domain empty'],
  ['restart_forgets_quarantine', 'M16-quarantine', 'the boundary cannot read membership'],
  ['replacement_after_recovery', 'M18-crash-boundaries', 'killed at dispatch.run_created'],
  ['recovery_not_recorded', 'M18-crash-boundaries', 'killed at launch.before_ownership'],
  ['recovery_overwrites_outcome', 'M18-crash-boundaries', 'killed at run_end.before_ended'],
  ['signal_recorded_pid', 'M18-crash-boundaries', 'a recorded pid that now belongs to an unrelated process is not signalled'],
];

// The harness starts the engine with a constructed environment, so a defect
// cannot be switched on through a variable. Each mutant gets a small entry
// file of its own that names the defect and then loads the witness.
function mutantEntry(work, mutant) {
  const entry = join(work, `witness-${mutant}.mjs`);
  writeFileSync(entry, `process.env.WITNESS_MUTANT = ${JSON.stringify(mutant)};\nawait import(${JSON.stringify(pathToFileURL(WITNESS).href)});\n`);
  return entry;
}

// Run one acceptance file against the witness. Resolves with its finished
// tests (suites left out) as [{ok, name, error}].
function runFile(file, { engine = WITNESS, pattern } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--test', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout'];
    if (pattern) args.push(`--test-name-pattern=${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    args.push(join(ACCEPTANCE, `${file.replace(/\.test\.mjs$/, '')}.test.mjs`));
    const env = { ...process.env, SURETY_WITNESS_ENGINE: engine, SURETY_TEST_TIMEOUT_MS: '300000' };
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('exit', () => {
      const tests = [];
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        const t = JSON.parse(line);
        if (!t.suite) tests.push(t);
      }
      if (tests.length === 0) reject(new Error(`no test results from ${file}: ${err.slice(-500)}`));
      else resolve(tests);
    });
  });
}

// Run jobs a few at a time.
async function pool(jobs, width, work) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const i = next++;
        try {
          results[i] = { value: await work(jobs[i]) };
        } catch (error) {
          results[i] = { error };
        }
      }
    }),
  );
  return results;
}

export async function witnessChecks(check, work, { width = 4 } = {}) {
  const baseline = await pool(SLICE2_FILES, width, (file) => runFile(file));
  for (const [i, file] of SLICE2_FILES.entries()) {
    await check(`witness engine: every test of ${file} passes (only the marker test fails)`, () => {
      if (baseline[i].error) throw baseline[i].error;
      const tests = baseline[i].value;
      const failed = tests.filter((t) => !t.ok);
      assert.deepEqual(
        failed.map((t) => t.name),
        [WITNESS_MARKER],
        `failures:\n  ${failed.map((t) => `${t.name}: ${t.error}`).join('\n  ')}`,
      );
      assert.ok(tests.filter((t) => t.ok).length >= 1, 'at least one test passed');
      assert.equal(tests.filter((t) => t.skipped).length, 0, 'nothing was skipped');
    });
  }

  const mutants = await pool(MUTANTS, width, ([mutant, file, pattern]) => runFile(file, { engine: mutantEntry(work, mutant), pattern }));
  for (const [i, [mutant, file, name]] of MUTANTS.entries()) {
    await check(`witness mutant ${mutant}: "${name}" (${file}) fails`, () => {
      if (mutants[i].error) throw mutants[i].error;
      const target = mutants[i].value.filter((t) => t.name === name);
      assert.equal(target.length, 1, `the named test ran once (ran: ${mutants[i].value.map((t) => t.name).join(' | ')})`);
      assert.equal(target[0].ok, false, 'the test passed against an engine with the defect it must catch');
    });
  }
}
