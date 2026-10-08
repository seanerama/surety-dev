#!/usr/bin/env bash
# The M3 hands-on walkthrough (acceptance row M241; E92 item 2 (6)): Sean
# watches the engine run a project's protected checks itself. It follows
# the plan's M241 step by step, and each of its five checks is printed as
# "CHECK (n)" with the command he can run himself:
#   (1) a check's processes in its domain's cgroup.procs, read from the host;
#   (2) the check's tree, with no .git anywhere in it;
#   (3) a write to a protected input refused while a write to the source is
#       made and discarded;
#   (4) the gate read, with the deciding execution and its history (an
#       earlier failed execution at the same bindings, kept beside it);
#   (5) a protected change adding a root, classified `unclassifiable`.
#
# NO MODEL, NO TOKEN, NOTHING PAID: every role is the harness's scripted
# role (the engine's test mode, `--harness --harness-scripted`); no backend
# binary is named or started. The checks are the test-owned check program
# (packages/engine/test/acceptance/harness/checks/program.mjs) in real
# `check` domains on this host, with the runner qualified by the engine's own
# self-test at its start (`--harness-runner-self-test run`), never by the
# fixture.
#
# Safety (E64; BS3 §4 rule 1): the one check that writes, the program's
# guarded `write` mode, refuses to act unless it finds itself contained; and
# this script releases it only after reading from the host that the
# program is a member of its check domain's cgroup and of nothing else.
#
# Before running it:
#   - from a login session of uid 1000 with the user manager running
#     (`systemctl --user is-system-running` prints running), with jq, curl,
#     git and node; the machine otherwise quiet (BS3 §4 rule 6);
#   - `npm run build` in this checkout, on a revision with M3's engine.
#
# Usage:
#   bash docs/acceptance/reports/M3-hands-on.sh
# It pauses at each check for you to look, and goes on when you press
# enter (SURETY_HANDS_ON_NO_PAUSE=1 goes straight on). Everything it makes
# is under one directory (SURETY_HANDS_ON_DIR, by default
# ~/surety-m3-hands-on-<date>), printed at the start and KEPT at the end:
# the engine's records are the run's evidence. KEEP=0 removes it.
# About ten minutes, most of it the engine's host checks and self-test at
# its start and one check held to its deadline in step 7.

set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "STOP: $*" >&2; exit 1; }

# Each check of M241, with the command Sean can run himself.
check() { # number, what to look for, command
  printf '\n\033[1;36mCHECK (%s)\033[0m %s\n' "$1" "$2"
  printf '   You can run it yourself:\n     %s\n' "$3"
}
pause() {
  [ "${SURETY_HANDS_ON_NO_PAUSE:-}" = 1 ] && return 0
  local _
  read -r -p "   Press enter to go on. " _ || true
}

# ---- the guards: nothing starts unless every one holds ------------------------------

[ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] || die "start this from a login session (XDG_RUNTIME_DIR is not set). Nothing was started."
[ -t 0 ] || [ "${SURETY_HANDS_ON_NO_PAUSE:-}" = 1 ] || die "run this from your terminal (it pauses at each check), or set SURETY_HANDS_ON_NO_PAUSE=1. Nothing was started."
for tool in jq curl git node systemctl; do command -v "$tool" >/dev/null || die "$tool is needed. Nothing was started."; done
[ "$(systemctl --user is-system-running 2>/dev/null || true)" = running ] || die "the user manager is not running (systemctl --user is-system-running). Nothing was started."
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$REPO/packages/engine/dist/cli.js
[ -f "$CLI" ] || die "not built: run 'npm run build' first. Nothing was started."
PROGRAM_SOURCE=$REPO/packages/engine/test/acceptance/harness/checks/program.mjs
CHILD_SOURCE=$REPO/packages/engine/test/acceptance/harness/scripted/child.mjs
[ -f "$PROGRAM_SOURCE" ] && [ -f "$CHILD_SOURCE" ] || die "the harness's check program and scripted role are missing from this checkout. Nothing was started."
NODE=$(readlink -f "$(command -v node)")

# ---- the work directory, the check program, the repository ------------------------------

WORK=${SURETY_HANDS_ON_DIR:-$HOME/surety-m3-hands-on-$(date -u +%Y%m%dT%H%M%SZ)}
case $WORK in "$REPO"/*) die "SURETY_HANDS_ON_DIR must be outside the repository. Nothing was started." ;; esac
mkdir -p "$WORK" && chmod 700 "$WORK"
SURETY_HOME=$WORK/home
SCRIPTED=$WORK/scripted
CHECKS=$WORK/checks
RELEASE=$CHECKS/release
PROJ_REPO=$WORK/repo
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts" "$SCRIPTED/release" "$RELEASE"
PORT=${PORT:-7303}
API=http://127.0.0.1:$PORT
ENGINE_PID=

S() { curl -sS -H "X-Surety-Token: $(cat "$SURETY_HOME/api.token")" -H 'Content-Type: application/json' "$@"; }
# A read-only query of the engine's store (the same reads the tests make).
dbq() {
  "$NODE" -e '
    const r = require("module").createRequire(process.argv[1] + "/packages/engine/package.json");
    const D = r("better-sqlite3");
    const db = new D(process.argv[2] + "/store.db", { readonly: true, fileMustExist: true });
    for (const row of db.prepare(process.argv[3]).all()) console.log(Object.values(row).map((v) => (v === null ? "" : String(v))).join("\t"));
  ' "$REPO" "$SURETY_HOME" "$1"
}
record_path() { dbq "SELECT path FROM records WHERE id = '$1'" | head -1 | sed "s|^|$SURETY_HOME/records/|"; }
tick() { S -X POST "$API/v1/projects/$1/tick" -d '{}' >/dev/null; }
cleanup() {
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" 2>/dev/null || true; fi
  if [ "${KEEP:-1}" = 0 ]; then rm -rf "$WORK"; else echo "kept: $WORK"; fi
}
trap cleanup EXIT

# Tick a project until a store query prints something (a value), at most $3 seconds.
until_db() { # project, query, seconds, what
  local i v
  for i in $(seq 1 $(( $3 / 2 ))); do
    v=$(dbq "$2" | head -1)
    if [ -n "$v" ]; then echo "$v"; return 0; fi
    tick "$1"; sleep 2
  done
  die "timed out waiting for $4"
}

say "0. Where everything is kept: $WORK"
note "The engine's home is $SURETY_HOME; the scripted roles' directory $SCRIPTED; the check program $CHECKS/program.mjs."

# The test-owned check program, with a first line naming this node; its directory is a read path of the checks.
printf '#!%s\n' "$NODE" > "$CHECKS/program.mjs"
cat "$PROGRAM_SOURCE" >> "$CHECKS/program.mjs"
chmod 755 "$CHECKS/program.mjs"
NODE_PREFIX=$(dirname "$(dirname "$NODE")")
READ_PATHS=$(jq -cn --arg c "$CHECKS" --arg p "$NODE_PREFIX" 'if ($p | test("^/(usr|bin|lib|lib64)(/|$)")) then [$c] else [$c, $p] end')
# The host's namespaces, which the program's guard compares with its own (it acts only where they differ).
HOST_NS="$(readlink /proc/self/ns/pid),$(readlink /proc/self/ns/net),$(readlink /proc/self/ns/mnt)"

# The scripted role and the script every role follows unless it has its own: change nothing, report completion.
cp "$CHILD_SOURCE" "$SCRIPTED/"
printf '%s\n' '{"steps": [{"result": {"status": "completed", "summary": "scripted role finished"}}]}' > "$SCRIPTED/scripts/default.json"

# The repository: the governed file, the protected expectation, and two check definitions.
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO"
mkdir -p "$PROJ_REPO/.surety/checks/defs" "$PROJ_REPO/.surety/checks/expect"
printf '# M3 hands-on\n' > "$PROJ_REPO/README.md"
GOVERNED=$(jq -n --arg prog "$CHECKS/program.mjs" --argjson rp "$READ_PATHS" '{protected_paths: [".surety/checks/"], check_commands: {probe: {path: $prog}}, runner_config: {direct: {read_paths: $rp}}}')
printf '%s\n' "$GOVERNED" > "$PROJ_REPO/.surety/checks/protected-policy.json"
printf 'export const answer = 42;\n' > "$PROJ_REPO/.surety/checks/expect/app.js"
# accept: acceptance, covers R1.1: the candidate's src/app.js must equal the protected expectation.
jq -n '{schema: 1, key: "accept", kind: "acceptance", command: ["probe", "expect", "src/app.js", ".surety/checks/expect/app.js"], timeout_s: 60, gate_kinds: ["stage"], covers: {criteria: ["R1.1"]}, inputs: [".surety/checks/expect/app.js"]}' > "$PROJ_REPO/.surety/checks/defs/accept.json"
# contained: smoke: reports its tree, waits for the release file "go" (so you can look), then tries to
# write the protected input and the candidate's source file, and reports each outcome.
jq -n --arg rel "$RELEASE" --arg ns "$HOST_NS" '{schema: 1, key: "contained", kind: "smoke", command: ["probe", "--report", "--hold", "go", "--release-dir", $rel, "--host-ns", $ns, "write", ".surety/checks/expect/app.js", "src/app.js"], timeout_s: 90, gate_kinds: ["stage"], inputs: [".surety/checks/expect/app.js"]}' > "$PROJ_REPO/.surety/checks/defs/contained.json"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'fixture: the governed file and two checks'
git -C "$PROJ_REPO" checkout -q --detach
printf '{"api_port": %s, "tick_interval": 600, "terminate_grace": 3, "kill_grace": 2}\n' "$PORT" > "$SURETY_HOME/config.json"

# ---------------------------------------------------------------------------------------
say "1. Start the engine: the host checks and the runner self-test run at its start"
note "The test mode with the scripted role; the host is qualified as in M2 (H1 to H12, P1 to P20), then the"
note "runner self-test runs its ten cases, each beside a control, in real check domains. No backend is named."
( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE")" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}" \
    "$NODE" "$CLI" serve --harness --harness-scripted "$SCRIPTED" --harness-host-checks run --harness-runner-self-test run >> "$WORK/engine.log" 2>&1 ) &
ENGINE_PID=$!
for i in $(seq 1 900); do
  if [ -f "$SURETY_HOME/api.token" ] && S "$API/v1/health" 2>/dev/null | jq -e '.mode == "full"' >/dev/null 2>&1; then break; fi
  kill -0 "$ENGINE_PID" 2>/dev/null || die "the engine exited; see $WORK/engine.log"
  sleep 0.2
done
S "$API/v1/health" | jq -e '.mode == "full"' >/dev/null || die "the engine did not reach full mode; see $WORK/engine.log"
for i in $(seq 1 300); do
  [ -n "$(dbq "SELECT check_runner FROM host_qualifications WHERE status = 'active' AND check_runner IS NOT NULL")" ] && break
  sleep 2
done
echo "The active host qualification's check_runner (the self-test's every case):"
dbq "SELECT check_runner FROM host_qualifications WHERE status = 'active'" | jq '{qualified, test_fixture, profile_fingerprint, self_test: [.self_test[] | {case, result}]}'
S "$API/v1/engine" | jq '{mode, harness, classifier_version, classifier_authority: .config.classifier_authority}'

# ---------------------------------------------------------------------------------------
say "2. The project, its requirement R1 with criterion R1.1, and one stage; a scripted Builder writes src/app.js"
P=$(S -X POST "$API/v1/projects" -d "{\"name\": \"m3-hands-on\", \"tier\": \"T1\", \"dev_repo_path\": \"$PROJ_REPO\", \"integration_branch\": \"main\"}" | jq -r '.project.id')
[[ $P == proj_* ]] || die "no project"
until_db "$P" "SELECT id FROM projects WHERE id = '$P' AND registration_state = 'registered'" 30 "the project to be registered" >/dev/null
INDEX=$'| Key | Title | Phase | Sensitive areas | Criteria |\n|---|---|---|---|---|\n| R1 | the answer | 1 | none | R1.1 |\n'
PLAN=$(S -X POST "$API/v1/harness/fixtures/plan" -d "$(jq -n --arg p "$P" --arg idx "$INDEX" '{project: $p, requirements: [{key: "R1"}], requirement_index: $idx, stages: [{number: 1, goal: "write src/app.js", implements: ["R1"]}]}')")
STAGE=$(echo "$PLAN" | jq -r '.stages[0].id'); BUILD=$(echo "$PLAN" | jq -r '.stages[0].work_item')
[[ $BUILD == wi_* ]] || die "no stage work: $PLAN"
printf '%s\n' '[{"steps": [{"write": {"path": "src/app.js", "content": "export const answer = 42;\n"}}, {"result": {"status": "completed", "summary": "scripted Builder", "nominate": true}}]}]' > "$SCRIPTED/scripts/$BUILD.json"
tick "$P"
C=$(until_db "$P" "SELECT id FROM candidates WHERE project = '$P' ORDER BY seq LIMIT 1" 120 "the candidate")
REV=$(dbq "SELECT revision FROM candidates WHERE id = '$C'")
echo "candidate $C at $REV; its checks, registered by the nomination:"
S "$API/v1/projects/$P/candidates/$C/checks" | jq -c '.executions[] | {id, key, status, trigger: .trigger.source}'

# ---------------------------------------------------------------------------------------
say "3. The check 'contained' running in its own check domain, waiting for you"
X=$(until_db "$P" "SELECT x.id FROM check_executions x JOIN checks c ON c.id = x.\"check\" WHERE x.candidate = '$C' AND c.key = 'contained' AND x.status = 'running' ORDER BY x.execution_seq DESC LIMIT 1" 180 "the contained check to be running")
CG=$(until_db "$P" "SELECT cgroup_path FROM execution_domains WHERE check_execution = '$X' AND cgroup_path IS NOT NULL" 60 "its domain's cgroup")
PIDS=""
for i in $(seq 1 30); do PIDS=$(cat "$CG/cgroup.procs" 2>/dev/null | tr '\n' ' '); [ -n "$PIDS" ] && grep -lsF "$CHECKS/program.mjs" $(printf '/proc/%s/cmdline ' $PIDS) >/dev/null && break; sleep 1; done
echo "execution $X; its domain's cgroup: $CG"
echo "cgroup.procs: $PIDS"
for pid in $PIDS; do printf '   %s  %s\n' "$pid" "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-160)"; done
check 1 "the check program (program.mjs, under the domain init) is a member of the check domain's cgroup.procs, read from the host" \
  "cat $CG/cgroup.procs; for p in \$(cat $CG/cgroup.procs); do tr '\\0' ' ' < /proc/\$p/cmdline; echo; done"
# The guard's host half: the program is in this domain's cgroup, and the domain is under the engine's scope.
PROG_PID=""
for pid in $PIDS; do tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$CHECKS/program.mjs" && PROG_PID=$pid; done
[ -n "$PROG_PID" ] || die "the check program was not found in its domain: nothing is released"
[ "/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$PROG_PID/cgroup")" = "$CG" ] || die "the program's own /proc/$PROG_PID/cgroup is not the domain's: nothing is released"
pause
TREE=$(find "$SURETY_HOME/checktrees" -type f -path '*/src/app.js' -printf '%h\n' 2>/dev/null | head -1 | xargs -r dirname)
echo "the check tree of ($P, $REV, the effective version), engine-owned: $TREE"
find "$TREE" -maxdepth 3 | sed "s|^$TREE|   .|" | head -20
echo "entries named .git anywhere under $SURETY_HOME/checktrees: $(find "$SURETY_HOME/checktrees" -name .git | wc -l)"
check 2 "the check's tree holds the candidate's files and the protected inputs, and no .git anywhere" \
  "find $SURETY_HOME/checktrees -name .git    # prints nothing"
pause

# ---------------------------------------------------------------------------------------
say "4. Release the check: it writes the protected input and the candidate's src/app.js"
note "Released only now: the program was read from the host inside its own check domain (above)."
touch "$RELEASE/go"
R=$(until_db "$P" "SELECT result FROM check_executions WHERE id = '$X' AND result IS NOT NULL" 120 "the contained check's result")
OUT=$(dbq "SELECT output FROM check_results WHERE id = '$R'")
grep -h '^SURETY-CHECK-WRITE ' "$(record_path "$OUT")" | sed 's/^SURETY-CHECK-WRITE //' | jq .
grep -h '^SURETY-CHECK-REPORT ' "$(record_path "$OUT")" | sed 's/^SURETY-CHECK-REPORT //' | jq '{cwd, git_present}'
echo "the candidate's src/app.js in git:          $(git -C "$PROJ_REPO" show "$REV:src/app.js" | sha256sum | cut -c1-16)"
echo "the check tree's src/app.js after the check: $(sha256sum < "$TREE/src/app.js" | cut -c1-16)"
echo "files under checktrees holding the check's written line: $(grep -rlF 'SURETY-CHECK-WROTE' "$SURETY_HOME/checktrees" 2>/dev/null | wc -l)"
check 3 "the write to .surety/checks/expect/app.js is refused (EROFS or EACCES) while the write to src/app.js succeeded, and nothing it wrote persisted: git, the tree and its files are unchanged" \
  "grep -rlF SURETY-CHECK-WROTE $SURETY_HOME/checktrees; git -C $PROJ_REPO status --short    # both print nothing"
pause

# ---------------------------------------------------------------------------------------
say "5. The stage gate on the candidate"
until_db "$P" "SELECT id FROM check_executions WHERE candidate = '$C' AND status IN ('recorded') GROUP BY candidate HAVING COUNT(*) >= 2" 120 "both checks to be recorded" >/dev/null
S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, checks: [.checks[] | {key, state, deciding}]}'

# ---------------------------------------------------------------------------------------
say "6. Two operator re-runs of 'contained' at the same bindings: the first held past its timeout, the second released"
rm -f "$RELEASE/go"
S -X POST "$API/v1/projects/$P/candidates/$C/checks" -d '{"keys": ["contained"]}' | jq -c '{executions: [.executions[] | {id, trigger: .trigger.source}]}'
note "No release file this time: the program waits, and the engine ends it at timeout_s (90 s), TERM then kill."
X2=$(dbq "SELECT x.id FROM check_executions x JOIN checks c ON c.id = x.\"check\" WHERE x.candidate = '$C' AND c.key = 'contained' ORDER BY x.execution_seq DESC LIMIT 1")
until_db "$P" "SELECT result FROM check_executions WHERE id = '$X2' AND result IS NOT NULL" 240 "the held re-run to reach its deadline" >/dev/null
dbq "SELECT id, execution_established, exit_status, signaled, deadline_hit FROM check_results WHERE execution = '$X2'" | sed 's/^/   held re-run: /'
touch "$RELEASE/go"
S -X POST "$API/v1/projects/$P/candidates/$C/checks" -d '{"keys": ["contained"]}' | jq -c '{executions: [.executions[] | {id, trigger: .trigger.source}]}'
X3=$(dbq "SELECT x.id FROM check_executions x JOIN checks c ON c.id = x.\"check\" WHERE x.candidate = '$C' AND c.key = 'contained' ORDER BY x.execution_seq DESC LIMIT 1")
until_db "$P" "SELECT result FROM check_executions WHERE id = '$X3' AND result IS NOT NULL" 120 "the released re-run's result" >/dev/null
GATE=$(S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}")
echo "$GATE" | jq '.evaluation | {id, outcome, contained: [.checks[] | select(.key == "contained") | {state, deciding, history}]}'
check 4 "the gate read names the deciding execution of 'contained' (the latest registration, $X3) and, in its history, the earlier executions at the same bindings, the one that failed at its deadline included" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/candidates/$C/gates/stage | jq '.. | objects | select(.key? == \"contained\")'"
pause

# ---------------------------------------------------------------------------------------
say "7. A Verifier proposes adding src/ as a protected root"
note "A root addition would hide source from a retained check (D3 §3.1, B02): the classifier never calls it a tightening."
TRIGGER=trg_hands_on_$(date +%s)
W=$(S -X POST "$API/v1/harness/fixtures/trigger" -d "{\"project\": \"$P\", \"kind\": \"check_correction\", \"trigger_source\": \"test\", \"trigger_id\": \"$TRIGGER\", \"trigger_generation\": 1}" | jq -r '.work_item.id')
[[ $W == wi_* ]] || die "no check_correction work"
NEW_GOVERNED=$(echo "$GOVERNED" | jq -c '.protected_paths += ["src/"]')
jq -n --arg g "$NEW_GOVERNED" '[{steps: [{write: {path: ".surety/checks/protected-policy.json", content: (($g | fromjson | tostring) + "\n")}}, {result: {status: "completed", summary: "scripted Verifier", proposal: {rationale: "Protect src/ as well.", requested_change_kind: "tightening"}}}]}]' > "$SCRIPTED/scripts/$W.json"
tick "$P"
PR=$(until_db "$P" "SELECT id FROM protected_proposals WHERE project = '$P' AND classification IS NOT NULL ORDER BY seq DESC LIMIT 1" 120 "the proposal's classification")
dbq "SELECT classification FROM protected_proposals WHERE id = '$PR'" | jq '{change_kind, elements, classifier_version}'
S "$API/v1/projects/$P/decisions" | jq -c '.decisions[] | select(.subject_id == "'"$PR"'") | {id, kind, options: [.options[].key]}'
check 5 "the proposal adding src/ as a root is classified unclassifiable (root_layout_changed), and only your check_correction_unclassifiable decision can apply it" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/decisions | jq '.decisions[] | {kind, subject_id}'"
pause

say "Done. Write down anything that surprised you: each is a decision for you or a failing test (M241)."
