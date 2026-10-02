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

import { ENDINGS, matrixCells, throughIntegration } from '../endings.mjs';
import { WITNESS_MARKER } from '../engine.mjs';
import { BOUNDARIES, KINDS, crashTitle, crashWay, probeCells } from '../probes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ACCEPTANCE = join(here, '..', '..');
const WITNESS = join(here, 'witness-engine.mjs');
const REPORTER = join(here, 'json-reporter.mjs');

// Every file the manifest lists for slice 2, and every file it lists for
// slice 3 that the witness engine can pass (those written with slice 3's
// first Verifier session; the name is kept from when slice 2 was the last).
const MANIFEST = JSON.parse(readFileSync(join(ACCEPTANCE, 'manifest.json'), 'utf8')).slices;
export const SLICE2_FILES = [...MANIFEST['2'], ...MANIFEST['3']];

// The cells of the run-end fault matrix are named by the contract table.
const cell = (title, what, event) => `${title}; ${what} (${event}) fails once: the same facts as with no fault, without a restart`;

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
  // The cases written after the slice-2 review (SEAM.md §22).
  ['waits_for_stdout_eof', 'M16-quarantine', 'a role that completes and exits, leaving a descendant with its output open, ends completed once the descendant is terminated'],
  ['unknown_waits_for_grace', 'M16-quarantine', 'with the boundary reporting unknown, a stopped run is quarantined at once, not after the grace periods'],
  ['resume_hold_no_event', 'M14-abandon', 'Resume of an eligible item on dispatch hold writes exactly one work.resumed event, in the transaction that clears the hold'],
  ['expired_lease_not_reconciled', 'M15-lease-supervision', 'the transaction that enters finalizing fails once: the run still ends, and the project dispatches its next item'],
  ['expired_lease_not_reconciled', 'M15-lease-supervision', 'the transaction that ends the run fails once: the run still ends, and the project dispatches its next item'],
  ['expired_lease_not_reconciled', 'M15-lease-supervision', 'a lease nobody renews expires, and the next tick puts its run through the run-end protocol, although the engine that owns it is alive'],
  ['no_self_renewal', 'M15-lease-supervision', 'a role that sends no heartbeat for longer than lease_ttl keeps its lease, because the engine renews it, and has its result accepted'],
  ['expired_lease_accepted', 'M15-lease-supervision', 'a lease past its expiry is not renewed, the result presented on it is refused, and the tick reconciles the run'],
  ['expired_result_accepted', 'M15-lease-supervision', 'a lease past its expiry is not renewed, the result presented on it is refused, and the tick reconciles the run'],
  ['hooks_run', 'M23-engine-git-runs-no-repository-code', "a post-checkout hook in the repository's hooks directory is not run when the engine creates a workspace"],
  ['hooks_run', 'M23-engine-git-runs-no-repository-code', "a post-checkout hook in a directory the repository's configuration names as core.hooksPath is not run when the engine creates a workspace"],
  ['worktree_probe_literal_path', 'M31-worktree-add-symlinked-home', 'with the engine home behind a symbolic link, a dispatch launches, its worktree_add is recorded as succeeded, and no worktree is left without a workspaces row'],
  // The cases written or changed after the second slice-2 review (SEAM.md §23).
  ['heartbeat_renews_after_end_decided', 'M15-lease-supervision', 'after the engine has decided to end a run, a heartbeat of its role does not move the lease'],
  ['heartbeat_renews_after_end_decided', 'M15-lease-supervision', 'a run past its deadline whose entry into finalizing fails once still ends timed_out, although its role keeps sending heartbeats and never exits by itself'],
  ['expiry_forgets_decided_end', 'M15-lease-supervision', 'a run past its deadline whose entry into finalizing fails once still ends timed_out, although its role keeps sending heartbeats and never exits by itself'],
  ['expiry_forgets_decided_end', 'M15-lease-supervision', 'the transaction that enters finalizing fails once: the run still ends, and the project dispatches its next item'],
  ['no_renewal_while_preparing', 'M15-lease-supervision', 'the engine renews the lease of a run it is preparing: a launch held before the spawn for longer than lease_ttl keeps its lease, and the role is spawned and completes'],
  ['lease_expiry_fails_run', 'M15-lease-supervision', 'a lease nobody renews expires, and the next tick puts its run through the run-end protocol, although the engine that owns it is alive'],
  ['lease_expiry_fails_run', 'M15-lease-supervision', 'a lease past its expiry is not renewed, the result presented on it is refused, and the tick reconciles the run'],
  ['fsmonitor_runs', 'M23-engine-git-runs-no-repository-code', "a program the repository's configuration names as core.fsmonitor is not run when the engine creates a workspace"],
  ['unknown_stops_signalling', 'M16-quarantine', 'with the boundary reporting unknown, a stopped role that ignores SIGTERM is still sent SIGKILL after terminate_grace, and the quarantine clears once the boundary reads again'],
  ['unknown_waits_for_grace', 'M16-quarantine', 'with the boundary reporting unknown, a stopped role that ignores SIGTERM is still sent SIGKILL after terminate_grace, and the quarantine clears once the boundary reads again'],
  ['stdout_eof_is_exit', 'M16-quarantine', 'a role that sends a valid result, closes its stdout and exits 0 later is not signalled before it exits, and ends completed'],
  ['unterminated_line_dropped', 'M16-quarantine', 'a valid result with no line ending, from a role that exits 0 and leaves a descendant holding its stdout, ends completed'],
  ['unterminated_line_dropped', 'M16-quarantine', 'a valid result with no line ending, from a role that exits 0, ends completed'],
  // Slice 3, part 1: what the final slice-2 review carried forward (SEAM.md §24).
  ['remove_settle_not_repeatable', 'M15-run-end-fault-matrix', cell('Abandon from executing', 'the transaction that records the worktree removal, after the removal succeeded on disk', 'git.journal_applied')],
  ['remove_settle_not_repeatable', 'M15-run-end-fault-matrix', cell('Abandon from claimed, at the barrier before the spawn', 'the transaction that finalizes the worktree removal', 'git.journal_finalized')],
  ['retry_forgets_never_launched', 'M15-run-end-fault-matrix', cell('Stop from claimed, at the barrier before the spawn', 'the transaction that ends the run', 'run.ended')],
  ['retry_forgets_never_launched', 'M15-run-end-fault-matrix', cell('Abandon from claimed, at the barrier before the spawn', 'the transaction that returns the work item to its prior status', 'work.advanced')],
  ['refusal_fault_fails_run', 'M15-run-end-fault-matrix', cell('a preflight refusal after a lease was issued', 'the transaction that enters finalizing', 'run.finalizing')],
  ['status_outside_tx', 'M15-run-end-fault-matrix', cell('a role completes', 'the transaction that ends the run', 'run.ended')],
  ['status_outside_tx', 'M15-run-end-fault-matrix', cell('a run passes its deadline', 'the transaction that parks the work item', 'work.parked')],
  ['stop_replaces_decided_end', 'M15-decided-outcome-stands', 'the Stop is refused with illegal_transition, the run ends timed_out and the work is parked behind the deadline blocker'],
  ['heartbeat_renews_while_retrying', 'M15-decided-outcome-stands', 'the Stop is refused with illegal_transition, the run ends timed_out and the work is parked behind the deadline blocker'],
  ['expiry_beats_stop', 'M15-decided-outcome-stands', 'Stop: the run ends stopped, not recovered, and its work is held'],
  ['expiry_beats_stop', 'M15-decided-outcome-stands', 'Abandon: the run ends abandoned, not recovered, its workspace is discarded and its work waits under a dispatch hold'],
  ['expiry_beats_clean_exit', 'M15-decided-outcome-stands', 'a clock jump past lease_ttl that lands after the role has exited, and before the engine has acted on the exit, does not make the run recovered'],
  ['quadratic_reader', 'M16-role-output-long-line', 'a role that writes one line of 64 MiB and then its usage and a valid result ends completed within eight seconds, and nothing after the line is lost'],
  ['token_space_accepted', 'M69-token-interior-whitespace', 'a token file with a space inside the token refuses the start and is never replaced'],
  ['token_space_accepted', 'M69-token-interior-whitespace', 'a token file with a tab inside the token refuses the start and is never replaced'],
  // Slice 3, first session: rows M19 to M25 and the slice-3 cases of earlier rows (SEAM.md §§25–35).
  ["own_edit_is_ref_violation", "M19-own-content-versus-metadata", "a Builder that adds, changes, deletes and renames files and links one to another has exactly that committed, and is never out of band while it works"],
  ["architect_engine_commit", "M19-own-content-versus-metadata", "an Architect that writes its own artifacts has them committed as an intent revision"],
  ["no_check_head", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and commits in its workspace, so that the detached HEAD is no longer at the base has the whole result rejected as a ref violation"],
  ["no_check_head", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and checks out a new branch in its workspace, so that HEAD is no longer detached has the whole result rejected as a ref violation"],
  ["no_check_index", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and stages a file in the workspace's real index has the whole result rejected as a ref violation"],
  ["no_check_config", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and changes the repository's configuration has the whole result rejected as a ref violation"],
  ["no_check_hooks", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and writes a hook into the repository's hooks directory has the whole result rejected as a ref violation"],
  ["no_check_gitlink", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and rewrites its workspace's .git file has the whole result rejected as a ref violation"],
  ["no_check_refs", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and moves the integration branch has the whole result rejected as a ref violation"],
  ["no_check_refs", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and deletes the integration branch has the whole result rejected as a ref violation"],
  ["no_check_other_checkouts", "M19-own-content-versus-metadata", "a Builder that makes a permitted edit and edits a tracked file in another run's retained workspace has the whole result rejected as a ref violation"],
  ["no_role_paths", "M19-own-content-versus-metadata", "a Builder that changes the identity file of a project created through the API has the whole result rejected"],
  ["no_role_paths", "M19-own-content-versus-metadata", "a Builder that creates the identity file in a project that has none has the whole result rejected"],
  ["own_edit_is_ref_violation", "M20-unsafe-diff-and-literal-data", "builder (fix): every path it may change is committed"],
  ["architect_engine_commit", "M20-unsafe-diff-and-literal-data", "architect (assessment): every path it may change is committed"],
  ["no_role_paths", "M20-unsafe-diff-and-literal-data", "builder (fix): a change to .surety/policy.json, with a permitted change beside it, rejects the whole result"],
  ["no_role_paths", "M20-unsafe-diff-and-literal-data", "builder (fix): a change to .surety/checks/acceptance.test.mjs, with a permitted change beside it, rejects the whole result"],
  ["no_role_paths", "M20-unsafe-diff-and-literal-data", "architect (assessment): a change to src/app.js, with a permitted change beside it, rejects the whole result"],
  ["no_role_paths", "M20-unsafe-diff-and-literal-data", "architect (assessment): a change to .surety/spec/spec.md, with a permitted change beside it, rejects the whole result"],
  ["no_role_paths", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds a source change together with a change under the protected root, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_link_check", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds a symbolic link to an absolute path outside the workspace, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_link_check", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds a symbolic link that climbs out of the workspace with `..`, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_link_check", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds a symbolic link to a symbolic link that leads outside the workspace, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_link_check", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds a tracked file replaced by a symbolic link that leads outside the workspace, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_kind_check", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds a git repository of its own inside the workspace, which a snapshot would hold as a gitlink, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_caps", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds one file larger than snapshot_max_file_bytes, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_caps", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds more files than snapshot_max_files, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["no_caps", "M20-unsafe-diff-and-literal-data", "a Builder whose workspace holds more bytes than snapshot_max_bytes, in files each within snapshot_max_file_bytes, beside a permitted edit, has the whole result rejected as a diff violation"],
  ["shell_interpolates", "M20-unsafe-diff-and-literal-data", "files named like options or holding shell syntax are committed under exactly those names, and nothing is run"],
  ["summary_in_trailers", "M20-unsafe-diff-and-literal-data", "a stage goal and a role summary full of shell syntax, options and forged trailers change nothing but the text they are"],
  ["shell_interpolates", "M20-unsafe-diff-and-literal-data", "an integration branch whose name holds shell syntax is a branch like any other"],
  ["absorbs_outside_files", "M20-unsafe-diff-and-literal-data", "what a role wrote outside its workspace is in no commit"],
  ["snapshot_before_termination", "M21-quiescent-snapshot-and-checkpoint", "while the boundary reports the domain running nothing is captured; once it reports terminated the checkpoint is taken, and the validated, recorded and committed trees agree"],
  ["checkpoint_integrates", "M21-quiescent-snapshot-and-checkpoint", "while the boundary reports the domain running nothing is captured; once it reports terminated the checkpoint is taken, and the validated, recorded and committed trees agree"],
  ["checkpoint_rewrites_base", "M21-quiescent-snapshot-and-checkpoint", "while the boundary reports the domain running nothing is captured; once it reports terminated the checkpoint is taken, and the validated, recorded and committed trees agree"],
  ["continuation_from_base", "M21-quiescent-snapshot-and-checkpoint", "the next run starts from the checkpoint commit in a workspace of its own, and its commit, made on the checkpoint, is the one integrated"],
  ["integrates_checked_out_branch", "M22-integration-branch-checked-out-elsewhere", "checked out in the repository's own work tree: the ref does not move, the checkout is left as it was, the work is parked with the way out, and once the branch is freed a retry integrates"],
  ["integrates_checked_out_branch", "M22-integration-branch-checked-out-elsewhere", "checked out in a linked worktree with uncommitted edits: refused the same way, and every edit, staged or not, is still there"],
  ["no_recheck_before_cas", "M22-integration-branch-checked-out-elsewhere", "checked out between the commit and the compare-and-swap: the second check, just before the ref would move, refuses it"],
  ["bootstrap_ignores_checkout", "M22-integration-branch-checked-out-elsewhere", "a project is not created through the API on a repository whose integration branch is checked out; once it is freed, it is"],
  ["integration_touches_checkouts", "M22-integration-branch-checked-out-elsewhere", "with the developer's work tree on another branch, one linked worktree detached and one on a feature branch, the integration goes through and reports nothing out of band"],
  ["ambient_env_inherited", "M23-two-repositories-hostile-environment", "with GIT_*, GH_* and editor variables pointing elsewhere and the engine started inside another repository, each project is committed and integrated in its own repository and nothing reaches the other or the third"],
  ["hooks_run", "M23-no-repository-code-snapshot-commit", "none of git's hooks in the repository's hooks directory is run"],
  ["hooks_run", "M23-no-repository-code-snapshot-commit", "no hook in a directory the repository's configuration names as core.hooksPath is run"],
  ["fsmonitor_runs", "M23-no-repository-code-snapshot-commit", "the program the repository's configuration names as core.fsmonitor is not run"],
  ["filters_run", "M23-no-repository-code-snapshot-commit", "a filter driver named in the repository's configuration (clean and smudge programs) is not run on workspace creation, snapshot or commit, and its files are committed unfiltered"],
  ["filters_run", "M23-no-repository-code-snapshot-commit", "a filter driver named in the repository's configuration (a long-running process filter) is not run on workspace creation, snapshot or commit, and its files are committed unfiltered"],
  ["external_diff_runs", "M23-no-repository-code-snapshot-commit", "an external diff program, a textconv program, a signing program, an editor and a pager named in the repository's configuration are not run"],
  ["feature_branch_observed", "M24-tracked-refs-versus-developer-refs", "a branch and a tag the engine does not track are created, moved and deleted: no observation, no decision, and the project goes on"],
  ["oob_not_blocking", "M24-tracked-refs-versus-developer-refs", "the integration branch moved: observed once, not absorbed, the project blocked, also across a restart"],
  ["oob_absorbed", "M24-tracked-refs-versus-developer-refs", "the integration branch moved: observed once, not absorbed, the project blocked, also across a restart"],
  ["oob_repeated", "M24-tracked-refs-versus-developer-refs", "the integration branch moved: observed once, not absorbed, the project blocked, also across a restart"],
  ["discard_drops_stray", "M24-tracked-refs-versus-developer-refs", "discard puts the branch back through the journal, keeps the stray commit under refs/surety/oob/, and the project goes on from the expected commit"],
  ["adopt_not_recorded", "M24-tracked-refs-versus-developer-refs", "adopt makes the commit found the expected one, records it as an out-of-band revision, and the project goes on from it"],
  ["deleted_ref_as_expected", "M24-tracked-refs-versus-developer-refs", "the integration branch deleted: observed with nothing found, the project blocked, and discard restores it"],
  ["oob_absorbed", "M24-tracked-refs-versus-developer-refs", "a ref the engine created for a checkpoint, moved and then deleted by someone else, is observed each time and never absorbed"],
  ["own_ref_ops_observed", "M24-tracked-refs-versus-developer-refs", "after a bootstrap, a policy change, a checkpoint and an integration, through ticks and a restart, nothing is out of band and every registered ref is where the registry expects it"],
  ["checkout_reset", "M25-checkout-edits-and-unreadable-repository", "an unstaged edit, with HEAD and index where they were, is observed as a checkout change, preserved, and offered stash or adopt"],
  ["checkout_offers_discard", "M25-checkout-edits-and-unreadable-repository", "a staged edit is observed the same way: the index differs from the baseline, the HEAD does not"],
  ["unreadable_is_clean", "M25-checkout-edits-and-unreadable-repository", "it is reported as unreadable, not as clean; nothing is dispatched and no reset is offered; once readable and unchanged, the observation closes and the project goes on"],
  ["unreadable_offers_reset", "M25-checkout-edits-and-unreadable-repository", "it is reported as unreadable, not as clean; nothing is dispatched and no reset is offered; once readable and unchanged, the observation closes and the project goes on"],
  ["no_fresh_integrity", "M25-checkout-edits-and-unreadable-repository", "a ref that was moved while the repository could not be read is found when it can be read again, before anything is dispatched"],
  ["startup_integrity_skipped", "M06-startup-integrity", "a branch moved while the engine was down is found by the integrity step, before full mode and before any dispatch"],
  ["bootstrap_extra_paths", "M07-project-bootstrap-and-policy", "POST /v1/projects commits .surety/project.json to the integration branch, registers the branch, and the project becomes registered"],
  ["bootstrap_accepts_anything", "M07-project-bootstrap-and-policy", "a request the schema refuses, a path that is no repository and a branch that does not exist create nothing"],
  ["unrecorded_policy_effective", "M07-project-bootstrap-and-policy", "a policy file that was in the repository before the project existed is not effective, is left as it is, and never becomes effective through a later change"],
  ["policy_file_merged", "M07-project-bootstrap-and-policy", "a policy file that was in the repository before the project existed is not effective, is left as it is, and never becomes effective through a later change"],
  ["policy_not_committed", "M07-project-bootstrap-and-policy", "is committed through the journal, recorded as a revision, and reported as effective; a second change is the next revision"],
  ["policy_not_used", "M07-project-bootstrap-and-policy", "takes effect: the repair limit, a role deadline and a snapshot cap are the changed ones"],
  ["no_integrated_transition", "M09-integrating-paths", "a stage_build run of the builder that returns a valid result is committed as engine_commit and integrated: eligible → claimed → executing → integrating → integrated"],
  ["no_integrated_transition", "M09-integrating-paths", "a fix run of the builder that returns a valid result is committed as engine_commit and integrated: eligible → claimed → executing → integrating → integrated"],
  ["architect_engine_commit", "M09-integrating-paths", "a replan run of the architect that returns a valid result is committed as intent and integrated: eligible → claimed → executing → integrating → integrated"],
  ["architect_engine_commit", "M09-integrating-paths", "a assessment run of the architect that returns a valid result is committed as intent and integrated: eligible → claimed → executing → integrating → integrated"],
  ["no_progress_ignored", "M11-no-progress-over-snapshot-tree", "work whose every attempt leaves the same rejected tree is launched once plus no_progress_max times, then parks for no progress"],
  ["progress_key_includes_run", "M11-no-progress-over-snapshot-tree", "work whose every attempt leaves the same rejected tree is launched once plus no_progress_max times, then parks for no progress"],
  ["progress_key_constant", "M11-no-progress-over-snapshot-tree", "work whose every attempt leaves a different rejected tree counts no lack of progress, and parks at the repair limit"],
  ["no_role_paths", "M11-no-progress-over-snapshot-tree", "a small repair that succeeds completes work that integrates: the rejected attempt leaves nothing behind, the repair is committed and integrated"],
  ["timeout_is_absent", "M15-git-deadline-and-integrity-step", "a worktree add held open is killed at git_deadline, its operation is marked ambiguous, no role is launched on it, and another project and the API go on"],
  ["git_no_deadline", "M15-git-deadline-and-integrity-step", "a worktree add held open is killed at git_deadline, its operation is marked ambiguous, no role is launched on it, and another project and the API go on"],
  ["integrity_overrun_dispatches", "M15-git-deadline-and-integrity-step", "an integrity step that overruns its budget suppresses that project for the tick, late completion included, while the other project is dispatched"],
  ["quarantine_then_snapshot", "M16-no-snapshot-while-quarantined", "a Builder whose domain cannot be read after its valid result is quarantined as failed, is never snapshotted, and its work is repaired by a new run"],
  ["quarantined_completed", "M16-no-snapshot-while-quarantined", "a Builder whose domain cannot be read after its valid result is quarantined as failed, is never snapshotted, and its work is repaired by a new run"],
  ["recovery_no_snapshot", "M18-snapshot-recovery", "recovery ends the run as recovered, records the snapshot tree of what the role left, and accepts nothing"],
  ["recovery_commits", "M18-snapshot-recovery", "recovery ends the run as recovered, records the snapshot tree of what the role left, and accepts nothing"],
  ["symlink_workspace_adopted", "M31-workspace-path-symlink", "a link at a new run's workspace path, pointing at another run's retained worktree, is refused: the worktree add does not succeed, no role runs there, and the other worktree is untouched"],
  // Slice 3, second session: rows M26 to M34 and the cases of earlier rows that concern the journal's
  // recovery, nomination, the chain of roles and what follows `integrated` (SEAM.md §§39–50). The
  // generated matrices (the probes, the crashes, the fault cells through integration) follow below.
  ['plan_registered_twice', 'M26-plan-and-stage-finalizers', 'the integration of a commit that holds a phase plan registers the plan, one stage row per stage and one stage_build item per stage, and the replan work is complete'],
  ['plan_from_newest', 'M26-plan-and-stage-finalizers', 'the finalizer is delayed while a newer plan is introduced: it registers the committed plan, exactly, and nothing of the newer one'],
  ['finalizer_reads_workspace', 'M26-plan-and-stage-finalizers', 'killed after the integration of a plan was confirmed and before its finalizer: the restart registers the plan once, from the commit, and a second restart registers nothing again'],
  ['recovery_skips_confirmed', 'M26-plan-and-stage-finalizers', 'killed after the integration of a plan was confirmed and before its finalizer: the restart registers the plan once, from the commit, and a second restart registers nothing again'],
  ['plan_not_validated', 'M26-plan-and-stage-finalizers', 'a plan file that is not JSON rejects the whole result: no plan is committed that could not be registered'],
  ['plan_not_validated', 'M26-plan-and-stage-finalizers', 'a plan file that has a stage with no goal rejects the whole result: no plan is committed that could not be registered'],
  ['stage_not_finalized', 'M26-plan-and-stage-finalizers', "the integration of a stage's work marks that stage integrated at the run's commit"],
  ['stage_by_number', 'M26-plan-and-stage-finalizers', 'the finalizer is delayed while a newer plan with a stage of the same number is introduced: the stage the run built is the one finalized, and the newer stage is untouched'],
  ['nomination_ref_mutable', 'M27-nomination-identity-and-cadence', 'T2: the completion of a stage nominates the integrated revision: candidate, immutable ref and lineage succession agree, and the work is being verified'],
  ['nomination_names_run', 'M27-nomination-identity-and-cadence', 'T2: the completion of a stage nominates the integrated revision: candidate, immutable ref and lineage succession agree, and the work is being verified'],
  ['t1_cadence', 'M27-nomination-identity-and-cadence', 'T1: the completion of a stage nominates nothing; the work stays integrated'],
  ['integrated_never_verifying', 'M27-nomination-identity-and-cadence', "T1: a Builder's request, `nominate: true`, is performed by the engine: the integrated revision is nominated by builder_request"],
  ['t2_request_nominates', 'M27-nomination-identity-and-cadence', "T2: a Builder's request before the cadence point is not a nomination: the run is integrated as usual and no candidate exists"],
  ['checkpoint_nominates', 'M27-nomination-identity-and-cadence', 'T1: a checkpoint is never a candidate, although the Builder asked for a nomination with it'],
  ['nominate_any_value', 'M27-nomination-identity-and-cadence', 'a `nominate` that is not a boolean makes the result invalid'],
  ['lineage_not_succeeded', 'M27-nomination-identity-and-cadence', 'a second stage integrated after a nomination is recorded on the successor lineage and nominated as the next candidate; the first candidate, its ref and its lineage are as they were'],
  ['recovery_skips_confirmed', 'M27-nomination-identity-and-cadence', 'killed after the nomination ref was written and confirmed, before the finalizer: the restart writes the candidate, registers the ref and succeeds the lineage, and a second restart writes nothing again (D1-18)'],
  ['nomination_no_verification', 'M27-nomination-identity-and-cadence', 'killed after the nomination ref was written and confirmed, before the finalizer: the restart writes the candidate, registers the ref and succeeds the lineage, and a second restart writes nothing again (D1-18)'],
  ['nomination_not_caught_up', 'M27-nomination-identity-and-cadence', 'killed after a T2 stage was integrated and before it was nominated: the stage is still nominated after the restart, once'],
  ['no_rebase', 'M28-integration-race-and-compare-and-swap', "moved by the engine's own commit: the result is rebased onto the head, the rebased tree is the head's tree plus the run's changes, it is committed on the head through the journal, and the swap is made from the head"],
  ['rebase_overwrites', 'M28-integration-race-and-compare-and-swap', "moved by the engine's own commit: the result is rebased onto the head, the rebased tree is the head's tree plus the run's changes, it is committed on the head through the journal, and the swap is made from the head"],
  ['conflict_takes_ours', 'M28-integration-race-and-compare-and-swap', 'moved to an adopted commit that changes the same file another way: the rebase conflicts, nothing is integrated, the work parks, and no role is launched to resolve it; a person lets the work run again from the new head'],
  ['cas_overwrites', 'M28-integration-race-and-compare-and-swap', 'moved between the journaled intent and the swap: the compare-and-swap fails, the unexpected head is not overwritten, the operation is failed, the registry is not told, and the move is observed out of band'],
  ['merge_driver_runs', 'M28-integration-race-and-compare-and-swap', "a merge driver the repository's configuration names is not run by the rebase"],
  ['extra_attempt', 'M34-operation-attempt-semantics', 'an operation is committed before its first attempt is issued; the attempt is number 1, admitted once, and succeeds when the probe confirms its effect'],
  ['attempt_number_not_unique', 'M34-operation-attempt-semantics', 'the store refuses a second attempt with a number already used, and a second journal event with a sequence number already used'],
  ['successor_not_linked', 'M34-operation-attempt-semantics', 'a failure before any effect leaves the attempt and the operation failed; nothing retries it, not a tick and not a restart; a new operation that does its work names it as its prior and supersedes it'],
  ['blind_retry', 'M34-operation-attempt-semantics', 'an attempt whose command was killed at its deadline is ambiguous, and so is its operation: it is not retried before a probe has reconciled it, and it completes nothing'],
  ['probe_applied_repeats', 'M34-operation-attempt-semantics', 'reconciled succeeded: an attempt whose effect was applied and never recorded is reconciled, not repeated, and its operation has succeeded'],
  ['interval_status_stale', 'M34-operation-attempt-semantics', 'reconciled absent: between the reconciliation and the retry the operation is intended again, with no attempt in flight; the retry is attempt 2 of the same operation'],
  ['interval_status_stale', 'M34-operation-attempt-semantics', 'reconciled partial: with the remainder declared the operation is partial, and completes nothing, until a new attempt has completed it'],
  ['probe_partial_is_applied', 'M34-operation-attempt-semantics', 'reconciled partial: with the remainder declared the operation is partial, and completes nothing, until a new attempt has completed it'],
  ['architect_never_complete', 'M09-after-integrated', 'a replan item runs its whole path: eligible → claimed → executing → integrating → integrated → complete'],
  ['architect_never_complete', 'M09-after-integrated', 'a assessment item runs its whole path: eligible → claimed → executing → integrating → integrated → complete'],
  ['verifying_never_completes', 'M09-after-integrated', 'a stage_build item runs its whole path: eligible → claimed → executing → integrating → integrated → verifying → complete'],
  ['failed_verification_completes', 'M09-after-integrated', "a verification that fails completes nothing: the Builder's work stays verifying until a repaired verification completes"],
  ['integrated_never_verifying', 'M09-after-integrated', 'a fix item runs its whole path, eligible → claimed → executing → integrating → integrated → verifying → complete: it stays integrated until a candidate that holds it is nominated, and is verified with that candidate'],
  ['verification_sweeps_integrated', 'M09-after-integrated', 'work integrated after a nomination is not held by that candidate: it stays integrated when the candidate is verified'],
  ['chain_unbounded', 'M12-chain-of-roles', "work that a run's outcome created is not launched without a human step: the next step is a decision, asked once, while another project's work progresses; once a person continues, it is launched once"],
  ['chain_decision_repeated', 'M12-chain-of-roles', "work that a run's outcome created is not launched without a human step: the next step is a decision, asked once, while another project's work progresses; once a person continues, it is launched once"],
  ['nomination_work_not_chained', 'M12-chain-of-roles', 'cancel at the boundary cancels the work without a launch'],
  ['plan_work_not_chained', 'M12-chain-of-roles', "the work a committed plan registers is work an Architect's run created: its stages are not built without a human step"],
  ['chain_counts_every_run', 'M12-chain-of-roles', 'work a fixture created, the repair of a failed run and a Resume are dispatched without a human step, also right after another run, and also while chained work waits at its boundary'],
  ['fence_ignored', 'M13-stop-during-integration', 'before the swap: the integration is not made, its operation is failed, the branch stays where it was, the work is held, and Resume integrates a new run'],
  ['end_before_reconcile', 'M13-stop-during-integration', 'before the swap: the integration is not made, its operation is failed, the branch stays where it was, the work is held, and Resume integrates a new run'],
  ['issued_effect_abandoned', 'M13-stop-during-integration', 'with the swap made and not yet recorded: the operation in flight is reconciled and finalized, the work is integrated and then held, and nothing is undone'],
  ['integrated_survives_stop', 'M13-stop-during-integration', 'the run ends stopped, the integrated work is held, the integration stands, and Resume starts a new run from the new head'],
  ['verifying_never_completes', 'M13-stop-during-integration', "stopping a candidate's verification run holds the verification work; the Builder's work stays verifying, its ended run cannot be stopped, and it is complete once a resumed verification completes"],
  ['fence_ignored', 'M14-abandon-during-integration', 'before the swap: the integration is not made, its operation is failed, the workspace is discarded, and the work returns to eligible under a dispatch hold'],
  ['issued_effect_abandoned', 'M14-abandon-during-integration', 'with the swap made and not yet recorded: the operation in flight is reconciled and finalized before anything is discarded; the work is integrated, then given back under a dispatch hold'],
  ['integrated_survives_stop', 'M14-abandon-during-integration', 'the run ends abandoned, its workspace is discarded, the integration stands, and the work returns to eligible under a dispatch hold'],
  ['withdrawn_is_retried', 'M15-ambiguous-git-call-reconciled', 'stays ambiguous and blocks its project while the repository does not answer; once it does, the next tick reconciles it absent and withdraws it, and the work is repaired by a new run in a workspace of its own'],
  ['blocker_repeated', 'M15-ambiguous-git-call-reconciled', 'stays ambiguous and blocks its project while the repository does not answer; once it does, the next tick reconciles it absent and withdraws it, and the work is repaired by a new run in a workspace of its own'],
  ['ambiguous_add_keeps_run', 'M15-ambiguous-git-call-reconciled', "a late completion launches nothing: a worktree that turns out complete is adopted as the ended run's retained workspace, and the work is still repaired by a new run"],
  ['projection_lags', 'M04-journal-state-projection', 'after operations of every journal kind, ended well and ended failed, each operation has one projection row at its last journal event'],
  ['journal_row_outside_tx', 'M04-journal-state-projection', 'the transaction that appends `applied` fails once: neither a second event nor a projection that ran ahead is left, and the journal goes on from where it was'],
  ['journal_row_outside_tx', 'M04-journal-state-projection', 'the transaction that appends `confirmed` fails once: neither a second event nor a projection that ran ahead is left, and the journal goes on from where it was'],
  ['journal_row_outside_tx', 'M04-journal-state-projection', 'the transaction that appends `finalized` fails once: neither a second event nor a projection that ran ahead is left, and the journal goes on from where it was'],
  ['immutable_offers_adopt', 'M24-nomination-ref-moved-or-deleted', 'moved: observed once and not absorbed; discard puts it back on the nominated revision through the journal and keeps the stray commit; the candidate is untouched'],
  ['deleted_ref_as_expected', 'M24-nomination-ref-moved-or-deleted', 'deleted: observed with nothing found; discard restores it on the nominated revision'],
  ['second_removal_intent', 'M32-ambiguous-removal-then-crash', 'followed by a crash before the run had ended: recovery completes, the engine reaches full mode, the same operation is retried and the workspace discarded once, and the run ends abandoned'],
  ['blind_retry', 'M32-ambiguous-removal-then-crash', 'with the engine still running: while the repository does not answer the removal stays blocked and the run is not ended; once it answers, the next tick retries the same operation and the run ends abandoned'],
  ['stray_git_ignored', 'M31-git-child-outlives-engine', 'an engine killed during `git worktree add` leaves the child alive: recovery does not act on a probe while that child lives, and no worktree appears afterwards that no row names'],
  ['blocked_operation_dispatches', 'M30-commit-tree-probe', 'commit_tree, journal intended, effect found conflicting (the keep ref put at another commit): it blocks, and nothing is retried, finalized or overwritten'],
];

// The probe matrix (rows M29 to M32): every cell fails against the defect
// that mishandles its outcome.
const PROBE_FILE = { ref_update: 'M29-ref-update-probe', commit_tree: 'M30-commit-tree-probe', worktree_add: 'M31-worktree-add-probe', worktree_remove: 'M32-worktree-remove-probe' };
const PROBE_DEFECT = { absent: 'probe_absent_fails', applied: 'probe_applied_repeats', partial: 'probe_partial_is_applied', conflicting: 'probe_conflict_overwrites', unknown: 'probe_unknown_is_absent' };
for (const kind of KINDS) {
  for (const cell of probeCells(kind)) MUTANTS.push([cell.way === 'withdraw' && cell.outcome === 'absent' ? 'withdrawn_is_retried' : PROBE_DEFECT[cell.outcome], PROBE_FILE[kind], cell.title]);
}
// The crash matrix (row M33): every cell fails against the defect of recovery at its boundary.
const CRASH_DEFECT = { intent_committed: 'probe_absent_fails', effect_applied: 'receipt_not_reconstructed', receipt_committed: 'recovery_skips_applied', probe_confirmed: 'recovery_skips_confirmed', finalizer_committed: 'recovery_refinalizes' };
for (const kind of KINDS) {
  for (const boundary of BOUNDARIES) {
    MUTANTS.push([boundary === 'intent_committed' && crashWay(kind, boundary) === 'withdraw' ? 'withdrawn_is_retried' : CRASH_DEFECT[boundary], 'M33-crash-across-journal-and-finalizer-boundaries', crashTitle(kind, boundary)]);
  }
}
// The fault matrix through integration: every reference fails against a
// defect in what its ending must leave, and every cell against a defect in
// the repetition of the step its fault lands in.
const REFERENCE_DEFECT = { integrates: 'no_integrated_transition', integration_conflict: 'integrates_checked_out_branch', stop_integrating: 'fence_ignored', abandon_integrating: 'fence_ignored', checkpoint: 'checkpoint_integrates' };
const END_STEPS = ['run.finalizing', 'invocation.status', 'ledger.row', 'run.ended', 'work.held'];
function cellDefect(c) {
  if (c.fault.event_type === 'run.validating') return 'result_record_not_retried';
  if (c.fault.event_type === 'decision.consumed') return 'confirm_burnt_by_failure';
  if (END_STEPS.includes(c.fault.event_type)) return 'end_not_retried';
  // The removal of an abandoned workspace, and the work's return, are steps of the run's end.
  if (c.ending === 'abandon_integrating' && c.fault.event_type !== 'operation.failed') return 'end_not_retried';
  return 'accept_step_not_repeatable';
}
for (const [name, spec] of Object.entries(ENDINGS).filter(([, ending]) => throughIntegration(ending))) {
  MUTANTS.push([REFERENCE_DEFECT[name], 'M15-run-end-fault-matrix-integration', `${spec.title}, with no fault: the reference ends as the contract table says`]);
  for (const c of matrixCells().filter((candidate) => candidate.ending === name)) {
    const when = c.fault.stage === 'committed' ? ', after the commit' : '';
    MUTANTS.push([cellDefect(c), 'M15-run-end-fault-matrix-integration', cell(spec.title, c.fault.what, `${c.fault.event_type}${when}`)]);
  }
}

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

// The self-check runs several files at once; the acceptance runner never
// does. Two files can then meet on one port: a test that kills its engine and
// starts another on the same port may find the port taken, in between, by an
// engine of another file, and the engine it starts refuses with status 6.
// That is an artifact of running in parallel, not a finding about a test, so
// a run that shows it is repeated by itself once every other run is over. A
// failure that is real shows again.
const PORT_COLLISION = /engine exited code=6\b/;
async function repeatCollided(jobs, results, work) {
  for (const [i, job] of jobs.entries()) {
    if (!results[i].value?.some((t) => !t.ok && PORT_COLLISION.test(t.error ?? ''))) continue;
    try {
      results[i] = { value: await work(job) };
    } catch (error) {
      results[i] = { error };
    }
  }
}

export async function witnessChecks(check, work, { width = 4 } = {}) {
  const runBaseline = (file) => runFile(file);
  const baseline = await pool(SLICE2_FILES, width, runBaseline);
  await repeatCollided(SLICE2_FILES, baseline, runBaseline);
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

  const runMutant = ([mutant, file, pattern]) => runFile(file, { engine: mutantEntry(work, mutant), pattern });
  const mutants = await pool(MUTANTS, width, runMutant);
  await repeatCollided(MUTANTS, mutants, runMutant);
  for (const [i, [mutant, file, name]] of MUTANTS.entries()) {
    await check(`witness mutant ${mutant}: "${name}" (${file}) fails`, () => {
      if (mutants[i].error) throw mutants[i].error;
      const target = mutants[i].value.filter((t) => t.name === name);
      assert.equal(target.length, 1, `the named test ran once (ran: ${mutants[i].value.map((t) => t.name).join(' | ')})`);
      assert.equal(target[0].ok, false, 'the test passed against an engine with the defect it must catch');
    });
  }
}
