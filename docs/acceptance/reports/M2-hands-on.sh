#!/usr/bin/env bash
# The M2 hands-on walkthrough (acceptance row M142): Sean watches the first
# real run. It follows the plan's M142 step by step: start the engine from a
# login session; read GET /v1/engine; a dispatch with no entry; `surety
# qualify`; wait for his two approvals; the journey's first path; a Stop.
# Each step says in plain words what it does, and each of M142's checks (1)
# to (9) is printed as "CHECK (n)" with the command he can run himself.
#
# IT SPENDS MONEY, ON SEAN'S DEDICATED ANTHROPIC KEY. It refuses to start
# unless he has set the key's reference and typed the spend confirmation
# (below), and it asks him again before every paid step, saying what that
# step can cost at most. The two decisions that let paid work start, the
# attempt's `qualification_approval` and the entry's `trust_activation`,
# are his: the script shows each preview and waits; it sends an answer
# only when he types it here, or he sends it himself from another terminal.
#
# What a step can cost at most, in billable tokens: 300 000 billable tokens
# a run (E59) at claude-sonnet-5-5's dearest rate, 10 USD per million output
# tokens, is 3.00 USD a run. Cache reads (0.20 USD per million) are not
# billable tokens and are not counted by the engine's limit, and one run can
# overshoot its limit until its deadline (D2 §4.2, §8 class C). The engine
# stops starting runs at each project's day limit (10 USD for the
# qualification's own project, 6 USD for the journey's); the provider-side
# cap of 50 USD on the key is the only hard maximum (D2 Q2).
#
# Before running it:
#   - from a login session of uid 1000 with the user manager running
#     (`systemctl --user is-system-running` prints running), with util-linux
#     and iproute2 present (no agent account: the engine delegates its own
#     scope, D2 K9);
#   - `npm run build` in this checkout, which must be on a revision whose
#     engine builds slice 14 (the real lane's engine side);
#   - the dedicated key in a file of its own, readable by you only:
#       install -m 600 /dev/null ~/.config/surety/anthropic.key   # then put the key in it
#   - the Claude Code binary to qualify, by its own file (not the
#     ~/.local/bin/claude link, which moves when Claude Code updates itself);
#     see the M2 report's question on pinning it.
#
# Usage:
#   SURETY_REAL_KEY_REF=$HOME/.config/surety/anthropic.key \
#   SURETY_REAL_CLAUDE_BINARY=/path/to/the/pinned/claude \
#   SURETY_HANDS_ON_CONFIRM_SPEND='I accept up to 25 USD a day and 50 USD in all' \
#   bash docs/acceptance/reports/M2-hands-on.sh
#
# Everything it makes is under one directory (SURETY_HANDS_ON_DIR, by
# default ~/surety-hands-on-<date>), printed at the start and KEPT at the
# end: the engine's records are the run's evidence. KEEP=0 removes it.

set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "STOP: $*" >&2; exit 1; }

CONFIRM_PHRASE='I accept up to 25 USD a day and 50 USD in all'
MODEL=claude-sonnet-5-5
RUN_TOKENS=300000
OUT_USD_PER_MILLION=10
CAP_USD=50
KEY_REF_NAME=backend/claude/api_key

# ---- the guards: nothing starts unless every one holds ------------------------------

[ -n "${SURETY_REAL_KEY_REF:-}" ] || die "set SURETY_REAL_KEY_REF to the absolute path of the file that holds the dedicated key (never the key itself). Nothing was started."
case $SURETY_REAL_KEY_REF in
  /*) ;;
  *) die "SURETY_REAL_KEY_REF must be an absolute path to the key's file; its value is not shown. Nothing was started." ;;
esac
[ -f "$SURETY_REAL_KEY_REF" ] && [ ! -L "$SURETY_REAL_KEY_REF" ] || die "SURETY_REAL_KEY_REF must name a regular file, not a link. Nothing was started."
KEY_MODE=$(stat -c %a "$SURETY_REAL_KEY_REF")
[ "$KEY_MODE" = 600 ] || [ "$KEY_MODE" = 400 ] || die "the key's file must be readable by you only (chmod 600). Nothing was started."
[ "$(wc -l < "$SURETY_REAL_KEY_REF")" -le 1 ] || die "the key's file must hold the key on one line and nothing else. Nothing was started."
[ "${SURETY_HANDS_ON_CONFIRM_SPEND:-}" = "$CONFIRM_PHRASE" ] || die "set SURETY_HANDS_ON_CONFIRM_SPEND='$CONFIRM_PHRASE' to confirm the spend. Nothing was started."
[ -n "${SURETY_REAL_CLAUDE_BINARY:-}" ] || die "set SURETY_REAL_CLAUDE_BINARY to the Claude Code binary to qualify, by its own file. Nothing was started."
[ -f "$SURETY_REAL_CLAUDE_BINARY" ] && [ ! -L "$SURETY_REAL_CLAUDE_BINARY" ] && [ -x "$SURETY_REAL_CLAUDE_BINARY" ] || die "SURETY_REAL_CLAUDE_BINARY must be an executable regular file, not a link. Nothing was started."
[ -t 0 ] || die "run this from your terminal: it asks you before every paid step. Nothing was started."
for tool in jq curl git node systemctl; do command -v "$tool" >/dev/null || die "$tool is needed. Nothing was started."; done
[ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] || die "start this from a login session (XDG_RUNTIME_DIR is not set). Nothing was started."
[ "$(systemctl --user is-system-running 2>/dev/null || true)" = running ] || die "the user manager is not running (systemctl --user is-system-running). Nothing was started."

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$REPO/packages/engine/dist/cli.js
[ -f "$CLI" ] || die "not built: run 'npm run build' first. Nothing was started."
NODE=$(command -v node)

# Every paid step asks first. `paid <what> <runs>`.
paid() {
  local what=$1 runs=$2 usd
  usd=$(awk -v r="$runs" -v t="$RUN_TOKENS" -v p="$OUT_USD_PER_MILLION" 'BEGIN { printf "%.2f", r * t * p / 1000000 }')
  printf '\n\033[1;33m!! PAID STEP: %s\033[0m\n' "$what"
  note "It starts $runs real run(s) of Claude Code ($MODEL) on your key."
  note "At most, in billable tokens: $runs x $RUN_TOKENS tokens x $OUT_USD_PER_MILLION USD per million = $usd USD,"
  note "plus cache reads (0.20 USD per million, not counted by the engine's limit) and any overshoot until a run's deadline."
  note "The project's day limit stops new runs; the provider-side cap of $CAP_USD USD on the key is the only hard maximum."
  local answer
  read -r -p "   Type yes to go on, anything else to stop here: " answer
  [ "$answer" = yes ] || die "stopped before: $what. Nothing of it was started."
}

# Each check of M142, with the command Sean can run himself.
check() { # number, what to look for, command
  printf '\n\033[1;36mCHECK (%s)\033[0m %s\n' "$1" "$2"
  printf '   You can run it yourself:\n     %s\n' "$3"
}

# ---- the work directory, the pin, the engine ---------------------------------------------

WORK=${SURETY_HANDS_ON_DIR:-$HOME/surety-hands-on-$(date -u +%Y%m%dT%H%M%SZ)}
case $WORK in "$REPO"/*) die "SURETY_HANDS_ON_DIR must be outside the repository." ;; esac
mkdir -p "$WORK" && chmod 700 "$WORK"
SURETY_HOME=$WORK/home
BIN=$WORK/bin
mkdir -p "$SURETY_HOME" "$BIN"
ln -sfn "$SURETY_REAL_CLAUDE_BINARY" "$BIN/claude"
PORT=${PORT:-7302}
API=http://127.0.0.1:$PORT
ENGINE_PID=

S() { curl -sS -H "X-Surety-Token: $(cat "$SURETY_HOME/api.token")" -H 'Content-Type: application/json' "$@"; }
# A read-only query of the engine's store (the same reads the tests make).
dbq() {
  "$NODE" -e '
    const r = require("module").createRequire(process.argv[1] + "/packages/engine/package.json");
    const D = r("better-sqlite3");
    const db = new D(process.argv[2] + "/store.db", { readonly: true, fileMustExist: true });
    const rows = db.prepare(process.argv[3]).all();
    for (const row of rows) console.log(Object.values(row).map((v) => (v === null ? "" : String(v))).join("\t"));
  ' "$REPO" "$SURETY_HOME" "$1"
}
record_path() { dbq "SELECT path FROM records WHERE id = '$1'" | head -1 | sed "s|^|$SURETY_HOME/records/|"; }

start_engine() { # production | real-lane
  local -a args=(serve)
  [ "$1" = real-lane ] && args+=(--harness --harness-real-lane)
  args+=(--secret-file "$KEY_REF_NAME=$SURETY_REAL_KEY_REF" --provider-cap-usd "$KEY_REF_NAME=$CAP_USD")
  printf '{"api_port": %s, "tick_interval": %s}\n' "$PORT" "$([ "$1" = real-lane ] && echo 600 || echo 30)" > "$SURETY_HOME/config.json"
  ( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="$BIN:/usr/local/bin:/usr/bin:/bin" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
      XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}" \
      "$NODE" "$CLI" "${args[@]}" >> "$WORK/engine.log" 2>&1 ) &
  ENGINE_PID=$!
  local i
  for i in $(seq 1 900); do
    if [ -f "$SURETY_HOME/api.token" ] && S "$API/v1/health" 2>/dev/null | jq -e '.mode == "full"' >/dev/null 2>&1; then return 0; fi
    kill -0 "$ENGINE_PID" 2>/dev/null || die "the engine exited; see $WORK/engine.log"
    sleep 0.2
  done
  die "the engine did not reach full mode in 3 minutes; see $WORK/engine.log"
}
stop_engine() {
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" 2>/dev/null || true; fi
  ENGINE_PID=
}
cleanup() {
  stop_engine
  if [ "${KEEP:-1}" = 0 ]; then rm -rf "$WORK"; else echo "kept: $WORK"; fi
}
trap cleanup EXIT

tick() { S -X POST "$API/v1/projects/$1/tick" -d '{}' >/dev/null; }

# Wait for Sean's answer to the open engine-scoped decision of a kind about a
# subject. Shows the preview. Sends an answer only when he types it here.
wait_for_sean() { # kind, subject
  local kind=$1 subject=$2 d="" h st line i
  for i in $(seq 1 60); do
    d=$(S "$API/v1/decisions" | jq -r --arg k "$kind" --arg s "$subject" '.decisions[] | select(.kind == $k and .subject_id == $s) | .id' | head -1)
    [ -n "$d" ] && break
    sleep 2
  done
  [ -n "$d" ] || die "no open $kind about $subject"
  h=$(S "$API/v1/decisions" | jq -r --arg d "$d" '.decisions[] | select(.id == $d) | .preview_hash')
  echo "The decision $d, as GET /v1/decisions shows it:"
  S "$API/v1/decisions" | jq --arg d "$d" '.decisions[] | select(.id == $d)'
  note "This is your decision. To answer from another terminal:"
  note "  curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" -H 'Content-Type: application/json' -X POST $API/v1/decisions/$d/answer -d '{\"option\": \"approve\", \"preview_hash\": \"$h\"}'"
  note "Or type approve (or reject) here and press enter. The walkthrough waits."
  while :; do
    st=$(dbq "SELECT status || ':' || COALESCE(json_extract(answer, '\$.option'), '') FROM decisions WHERE id = '$d'")
    case $st in
      consumed:approve) echo "approved: $d"; return 0 ;;
      consumed:*) die "you answered $d with ${st#consumed:}: the walkthrough stops here, nothing further is started" ;;
      invalidated:*) die "$d was invalidated (something it binds changed); start again" ;;
    esac
    if read -r -t 5 line; then
      case $line in approve|reject) S -X POST "$API/v1/decisions/$d/answer" -d "{\"option\": \"$line\", \"preview_hash\": \"$h\"}"; echo ;; esac
    fi
  done
}

# Tick a project until a jq filter over a read holds (minutes, for real runs).
until_read() { # project, path, filter, what, seconds
  local i
  for i in $(seq 1 $(( $5 / 5 ))); do
    if S "$API$2" | jq -e "$3" >/dev/null 2>&1; then return 0; fi
    tick "$1"; sleep 5
  done
  die "timed out waiting for $4"
}

# The person at the chain boundary lets one waiting item through.
let_through() { # project, work item
  local d i
  for i in $(seq 1 24); do
    d=$(S "$API/v1/projects/$1/decisions" | jq -r --arg w "$2" '.decisions[] | select(.subject_id == $w) | .id' | head -1)
    [ -n "$d" ] && break
    tick "$1"; sleep 5
  done
  [ -n "$d" ] || die "no chain-boundary decision about $2"
  local h; h=$(S "$API/v1/projects/$1/decisions" | jq -r --arg d "$d" '.decisions[] | select(.id == $d) | .preview_hash')
  S -X POST "$API/v1/projects/$1/decisions/$d/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$h\"}" | jq -c '{decision: .decision.id?, status: .decision.status?}'
}
run_of() { dbq "SELECT id FROM runs WHERE work_item = '$1' ORDER BY seq DESC LIMIT 1"; }
wait_registered() { # project
  local i
  for i in $(seq 1 100); do [ "$(dbq "SELECT registration_state FROM projects WHERE id = '$1'")" = registered ] && return 0; sleep 0.3; done
  die "project $1 was not registered"
}
wait_run_end() { # project, work item, seconds
  local i r
  for i in $(seq 1 $(( $3 / 10 ))); do
    r=$(run_of "$2")
    if [ -n "$r" ] && [ "$(dbq "SELECT state FROM runs WHERE id = '$r'")" = ended ]; then
      S "$API/v1/projects/$1/runs/$r" | jq '.run | {id, role, state, outcome, reason_class, reason_text, exit_class}'
      return 0
    fi
    tick "$1"; sleep 10
  done
  die "the run of $2 did not end in $3 s"
}

say "0. Where everything is kept: $WORK"
note "The engine's home is $SURETY_HOME. The pinned binary is $SURETY_REAL_CLAUDE_BINARY,"
note "reached by the engine through $BIN/claude, first on its PATH. The key stays in its file: the engine is given the path."

# ---------------------------------------------------------------------------------------
say "1. Start the engine from this login session (production mode: no test switches)"
note "At start the engine creates its own control-group scope through your user manager, then checks the host:"
note "H1 to H13 and the isolation probes P1 to P20, each against a target it seeded, each with a control."
start_engine production
S "$API/v1/engine" | jq '{version, mode, harness, backends, bootstrap_exception, qualification_fixture_project}'

say "2. GET /v1/engine: the host qualification"
S "$API/v1/engine" | jq -r '.host_qualification | "eligible: \(.eligible)   source: \(.source)   failed: \(.failed_checks)", (.checks[] | "  \(.id)  \(.result)  \(.observed)")'
echo "The probes of the active host qualification:"
dbq "SELECT p.value ->> 'id', p.value ->> 'result', 'seeded=' || (p.value ->> 'target_seeded'), 'control=' || COALESCE(p.value ->> 'control', ''), COALESCE(p.value ->> 'reason', '') FROM host_qualifications h, json_each(h.probes) p WHERE h.status = 'active'"
check 1 "H1 to H12 passed (H13, the optional observer, is not exercised), and P1 to P20 each with a seeded target and a control; P20 is excused on this workstation (E69) and runs on mini-hp01" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/engine | jq '.host_qualification'"
FIXTURE=$(S "$API/v1/engine" | jq -r '.qualification_fixture_project')
stop_engine

# ---------------------------------------------------------------------------------------
say "3. A dispatch with no entry: refused, and no agent starts"
note "The engine is restarted in its test mode for the real lane, because a plan is a fixture in M2; the dispatch"
note "rule is the production one. A project's Builder is set to Claude Code, which has no trust entry yet."
start_engine real-lane
NOENTRY_REPO=$WORK/repo-no-entry
git init -q -b main "$NOENTRY_REPO"
printf '# no entry\n' > "$NOENTRY_REPO/README.md"
git -C "$NOENTRY_REPO" -c user.name=Sean -c user.email=sean@surety.invalid add -A
git -C "$NOENTRY_REPO" -c user.name=Sean -c user.email=sean@surety.invalid commit -q -m 'hands-on: initial commit'
git -C "$NOENTRY_REPO" checkout -q --detach
P0=$(S -X POST "$API/v1/projects" -d "{\"name\": \"no-entry\", \"tier\": \"T2\", \"dev_repo_path\": \"$NOENTRY_REPO\", \"integration_branch\": \"main\"}" | jq -r '.project.id')
[[ $P0 == proj_* ]] || die "no project"
wait_registered "$P0"
S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P0\", \"requirements\": [{\"key\": \"R1\"}], \"stages\": [{\"number\": 1, \"goal\": \"anything\", \"implements\": [\"R1\"]}]}" > "$WORK/plan0.json"
W0=$(jq -r '.stages[0].work_item' "$WORK/plan0.json")
S -X POST "$API/v1/projects/$P0/policy" -d '{"backend_builder": "claude", "preflight_refusals_max": 1}' | jq -c '{revision: .revision?}'
wait_run_end "$P0" "$W0" 120
R0=$(run_of "$W0")
S "$API/v1/projects/$P0/runs/$R0" | jq '.run | {id, state, outcome, reason_class, code, refusal}'
check 2 "with no entry the dispatch is backend_refused, and no Claude Code process exists" \
  "ps -eo pid,args | grep -F -- '$SURETY_REAL_CLAUDE_BINARY' | grep -v grep   # prints nothing"
ps -eo pid,args | grep -F -- "$SURETY_REAL_CLAUDE_BINARY" | grep -v grep || echo "   (no process runs the binary)"
stop_engine

# ---------------------------------------------------------------------------------------
say "4. surety qualify: the attempt, its static checks, its preview"
note "The engine runs the binary twice, with --version and --help only, outside any sandbox, and writes the"
note "attempt 'proposed'. Nothing runs against a model until you approve it."
start_engine production
note "The qualification's own project gets the lane's limits first (each is a lowering, applied at once):"
S -X POST "$API/v1/projects/$FIXTURE/policy" -d '{"budget_run_billable_tokens": 300000, "budget_day_verified_usd": 10, "budget_day_unknown_tokens": 900000}' | jq -c '{revision: .revision?}'
FIXTURE_REPO=$(dbq "SELECT dev_repo_path FROM projects WHERE id = '$FIXTURE'")
FIXTURE_CONFIG=$FIXTURE_REPO/.git/config; [ -f "$FIXTURE_CONFIG" ] || FIXTURE_CONFIG=$FIXTURE_REPO/config
TOKEN_BEFORE=$(sha256sum "$SURETY_HOME/api.token" | cut -c1-64)
CONFIG_BEFORE=$(sha256sum "$FIXTURE_CONFIG" | cut -c1-64)
env -i SURETY_HOME="$SURETY_HOME" PATH="$BIN:/usr/local/bin:/usr/bin:/bin" HOME="$SURETY_HOME" LANG=C.UTF-8 \
  "$NODE" "$CLI" qualify claude --mode one_shot_headless --model "$MODEL" --egress api.anthropic.com | tee "$WORK/qualify.json"
QA=$(jq -r '.qualification_attempt.id' "$WORK/qualify.json")
[[ $QA == qa_* ]] || die "no attempt was proposed (see above)"
S "$API/v1/decisions" | jq --arg q "$QA" '.decisions[] | select(.subject_id == $q) | .manifest | {binary_sha256, help_sha256, model, template_version, auth_mode, candidate_egress, canary_deadlines, spend}'
check 3 "the approval's preview shows the binary's hash, the model and the spend labelled an estimate (and the 50 USD cap as configured, not as the engine's)" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/decisions | jq '.decisions[] | select(.kind == \"qualification_approval\") | .manifest'"
echo "   the binary you pinned: $(sha256sum "$SURETY_REAL_CLAUDE_BINARY" | cut -c1-64)"

paid "the qualification attempt: three canaries (positive, cancellation, containment)" 3
say "5. Your first approval: qualification_approval"
wait_for_sean qualification_approval "$QA"

say "6. The canaries run, one at a time, each in its own sandbox and control group"
SHOWN=
for i in $(seq 1 600); do
  tick "$FIXTURE"
  STATUS=$(dbq "SELECT status FROM qualification_attempts WHERE id = '$QA'")
  CG=$(dbq "SELECT d.cgroup_path FROM execution_domains d JOIN invocation_receipts r ON r.run = d.run WHERE r.qualification_attempt = '$QA' AND d.observation IS NOT 'terminated' ORDER BY d.created_at DESC LIMIT 1")
  if [ -z "$SHOWN" ] && [ -n "$CG" ] && [ -s "$CG/cgroup.procs" ]; then
    echo "a canary's domain: $CG"
    cat "$CG/cgroup.procs"
    ps -o pid,cgroup,args -p "$(paste -sd, "$CG/cgroup.procs")" || true
    check 4 "during a canary the domain's cgroup.procs lists the agent's processes, and ps -o pid,cgroup agrees" \
      "cat $CG/cgroup.procs; ps -o pid,cgroup,args -p \$(paste -sd, $CG/cgroup.procs)"
    SHOWN=1
  fi
  case $STATUS in succeeded|failed|invalidated) break ;; esac
  sleep 3
done
dbq "SELECT status, canaries FROM qualification_attempts WHERE id = '$QA'" | tee "$WORK/attempt.tsv"
[ "$(dbq "SELECT status FROM qualification_attempts WHERE id = '$QA'")" = succeeded ] || die "the attempt did not succeed; its records are in $SURETY_HOME"

say "7. The containment evidence"
CONT_EVIDENCE=$(dbq "SELECT c.value ->> 'evidence' FROM qualification_attempts q, json_each(q.canaries) c WHERE q.id = '$QA' AND c.value ->> 'kind' = 'containment'")
jq '.actions[] | {name, witnessed, outcome, expected, passed, host}' "$(record_path "$CONT_EVIDENCE")"
CONT_RUN=$(dbq "SELECT c.value ->> 'run' FROM qualification_attempts q, json_each(q.canaries) c WHERE q.id = '$QA' AND c.value ->> 'kind' = 'containment'")
EGRESS=$(dbq "SELECT id FROM records WHERE run = '$CONT_RUN' AND kind = 'egress_log'")
echo "the containment run's egress log:"
jq -c '{authority, decision, reason, bytes_up, bytes_down}' "$(record_path "$EGRESS")"
echo "api.token before and after:    $TOKEN_BEFORE  $(sha256sum "$SURETY_HOME/api.token" | cut -c1-64)"
echo "repository config before/after: $CONFIG_BEFORE  $(sha256sum "$FIXTURE_CONFIG" | cut -c1-64)"
check 5 "the containment evidence: the token unread, the repository configuration unchanged, the engine's port unreachable, the unlisted host refused in the egress log (this is 'the agent cannot read the engine home' under K9: there is no agent account)" \
  "sha256sum $SURETY_HOME/api.token $FIXTURE_CONFIG; jq -c 'select(.decision == \"refused\")' $(record_path "$EGRESS")"

say "8. Your second approval: trust_activation"
note "Activating the entry launches nothing. It lets real roles be dispatched to it, each a paid run."
ENTRY=$(dbq "SELECT trust_entry FROM qualification_attempts WHERE id = '$QA'")
wait_for_sean trust_activation "$ENTRY"
S "$API/v1/engine" | jq --arg e "$ENTRY" '{backends, entry: (.trust_entries[] | select(.id == $e) | {id, status, version, binary_sha256, usage_granularity, cost_reporting, enforceable_boundaries})}'
stop_engine

# ---------------------------------------------------------------------------------------
say "9. The journey's first path, with Claude Code as Builder, Verifier and Reviewer"
note "The engine restarts in its test mode for the real lane: the plan, the check and the Alpha target are fixtures in M2."
start_engine real-lane
PROJ_REPO=$WORK/repo
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO"
mkdir -p "$PROJ_REPO/.surety/checks"
printf '# hands-on\n' > "$PROJ_REPO/README.md"
printf '{"protected_paths": [".surety/checks/"], "required_checks": ["login"]}\n' > "$PROJ_REPO/.surety/checks/protected-policy.json"
printf '{"expect": 200}\n' > "$PROJ_REPO/.surety/checks/login.check.json"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'fixture: initial commit'
BASE=$(git -C "$PROJ_REPO" rev-parse HEAD)
git -C "$PROJ_REPO" checkout -q --detach
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
P=$(S -X POST "$API/v1/projects" -d "{\"name\": \"hands-on\", \"tier\": \"T2\", \"dev_repo_path\": \"$PROJ_REPO\", \"integration_branch\": \"main\"}" | jq -r '.project.id')
[[ $P == proj_* ]] || die "no project"
wait_registered "$P"
S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R1\", \"text\": \"src/greeting.js exports greeting(name), returning \\\"Hello, \\\" followed by name and \\\"!\\\".\"}], \"constraints\": [{\"key\": \"C1\", \"text\": \"Plain JavaScript modules with no dependencies.\"}], \"stages\": [{\"number\": 1, \"goal\": \"Implement R1: create src/greeting.js as R1 describes.\", \"implements\": [\"R1\"]}]}" > "$WORK/plan.json"
STAGE=$(jq -r '.stages[0].id' "$WORK/plan.json"); BUILD=$(jq -r '.stages[0].work_item' "$WORK/plan.json")
CHK=$(S -X POST "$API/v1/harness/fixtures/checks" -d "{\"project\": \"$P\", \"checks\": [{\"key\": \"login\", \"kind\": \"acceptance\", \"gate_kinds\": [\"stage\", \"alpha_authorize\"], \"requirements\": [\"R1\"]}]}" | jq -r '.checks[0].id')
S -X POST "$API/v1/projects/$P/policy" -d '{"backend_builder": "claude", "backend_verifier": "claude", "backend_reviewer": "claude", "budget_run_billable_tokens": 300000, "budget_day_verified_usd": 6, "budget_day_unknown_tokens": 900000, "deadline_builder": 900, "deadline_verifier": 600, "deadline_reviewer": 600}' | jq -c '{revision: .revision?}'

paid "the Builder's run on stage 1" 1
tick "$P"
wait_run_end "$P" "$BUILD" 1500
for i in $(seq 1 30); do C=$(dbq "SELECT id FROM candidates WHERE project = '$P' ORDER BY seq LIMIT 1"); [ -n "$C" ] && break; tick "$P"; sleep 5; done
[[ $C == cand_* ]] || die "nothing was nominated"
echo "candidate: $C"
for i in $(seq 1 30); do VER=$(dbq "SELECT id FROM work_items WHERE project = '$P' AND kind = 'verification' ORDER BY seq LIMIT 1"); [ -n "$VER" ] && break; tick "$P"; sleep 5; done
[[ $VER == wi_* ]] || die "no verification work was registered for $C"
paid "the Verifier's run on the candidate" 1
let_through "$P" "$VER"
wait_run_end "$P" "$VER" 1000
note "The check's execution is recorded as a fixture (D3's runner is not built): it is evidence of nothing about the code."
S -X POST "$API/v1/harness/fixtures/check-result" -d "{\"project\": \"$P\", \"check\": \"$CHK\", \"candidate\": \"$C\", \"exit_status\": 0}" | jq -c .
for i in $(seq 1 30); do REV=$(dbq "SELECT id FROM work_items WHERE project = '$P' AND kind = 'review' ORDER BY seq LIMIT 1"); [ -n "$REV" ] && break; tick "$P"; sleep 5; done
[[ $REV == wi_* ]] || die "the engine queued no review of $C"
paid "the Reviewer's run on the candidate" 1
let_through "$P" "$REV"
wait_run_end "$P" "$REV" 1000
S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons}'
ENV=$(S -X POST "$API/v1/harness/fixtures/environment" -d "{\"project\": \"$P\", \"name\": \"alpha\", \"target_set\": [\"alpha-1\"]}" | jq -r '.environment.id')
DAUTH=$(S -X POST "$API/v1/projects/$P/candidates/$C/authorizations" -d "{\"environment\": \"$ENV\", \"artifact_digest\": \"sha256:$(printf 'a%.0s' $(seq 1 64))\", \"config_identity\": \"config-1\", \"target_set\": [\"alpha-1\"]}" | jq -r '.authorization.id')
S -X POST "$API/v1/projects/$P/candidates/$C/gates/alpha_authorize" -d "{\"authorization\": \"$DAUTH\"}" | jq '.evaluation | {outcome, reasons}'

git -C "$PROJ_REPO" log --format='%h %an <%ae>%n%(trailers:only)' "$BASE..main"
check 6 "every commit on the integration branch is the engine's, with Surety-Run and Surety-Role trailers, and none is the agent's" \
  "git -C $PROJ_REPO log --format='%h %an <%ae>%n%(trailers:only)' $BASE..main"

echo "the ledger, as the engine reads it:"
S "$API/v1/projects/$P/ledger" | jq '{totals, rows: [.rows[] | {run, billable_in, cached_in, out, cost_status, cost_usd, usage_complete}]}'
echo "what the provider reported, the last 'result' event of each run's transcript:"
for R in $(dbq "SELECT id FROM runs WHERE project = '$P' ORDER BY seq"); do
  T=$(dbq "SELECT id FROM records WHERE run = '$R' AND kind = 'transcript' ORDER BY rowid LIMIT 1")
  [ -n "$T" ] || { echo "  $R: no transcript record"; continue; }
  printf '  %s: ' "$R"; grep '^{' "$(record_path "$T")" | jq -c 'select(.type == "result") | {total_cost_usd, usage}' | tail -1
done
check 7 "each ledger row equals the usage the provider reported in its transcript, and nothing unknown is shown as zero" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/ledger | jq ."

# ---------------------------------------------------------------------------------------
say "10. A Stop during a real run"
S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R3\", \"text\": \"src/farewell.js exports farewell(name).\"}], \"stages\": [{\"number\": 2, \"goal\": \"Implement R3.\", \"implements\": [\"R3\"]}]}" > "$WORK/plan2.json"
STOPW=$(jq -r '.stages[0].work_item' "$WORK/plan2.json")
S -X POST "$API/v1/harness/barriers" -d '{"name": "boundary.before_terminated", "action": "pause"}' >/dev/null
note "The engine will pause just after it has read populated 0 and before it records the termination, so you can read it too."
paid "a Builder run that you will stop" 1
tick "$P"
for i in $(seq 1 120); do
  SR=$(run_of "$STOPW"); SCG=$([ -n "$SR" ] && dbq "SELECT cgroup_path FROM execution_domains WHERE run = '$SR'" || true)
  [ -n "$SCG" ] && [ -s "$SCG/cgroup.procs" ] && break
  tick "$P"; sleep 2
done
[ -n "$SCG" ] || die "the run did not start"
echo "the run $SR is in $SCG:"; cat "$SCG/cgroup.procs"
read -r -p "   Press enter to Stop it. " _
FIRST=$(S -X POST "$API/v1/projects/$P/runs/$SR/stop" -d '{}')
SHASH=$(echo "$FIRST" | jq -r '.subject.preview_hash')
S -X POST "$API/v1/projects/$P/runs/$SR/stop" -d "{\"preview_hash\": \"$SHASH\"}" | jq -c '{status: .run.state?}'
for i in $(seq 1 120); do S "$API/v1/harness/barriers" | jq -e '.barriers[] | select(.name == "boundary.before_terminated" and .state == "waiting")' >/dev/null 2>&1 && break; sleep 1; done
echo "cgroup.events now:"; cat "$SCG/cgroup.events"
echo "the run read now: $(S "$API/v1/projects/$P/runs/$SR" | jq -r '.run.state')"
check 8 "after the Stop, cgroup.events reads populated 0 before the run read says ended" \
  "cat $SCG/cgroup.events; curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/runs/$SR | jq .run.state"
read -r -p "   Press enter to let the engine record the termination and end the run. " _
S -X POST "$API/v1/harness/barriers/boundary.before_terminated/release" -d '{}' >/dev/null
sleep 5
S "$API/v1/projects/$P/runs/$SR" | jq '.run | {id, state, outcome, reason_class, exit_class, domain_observation}'

# ---------------------------------------------------------------------------------------
say "11. The key is nowhere the engine or the repository keeps anything"
note "grep reads the key from its file (-f), so it never appears on a command line."
grep -rlFf "$SURETY_REAL_KEY_REF" "$SURETY_HOME" "$PROJ_REPO" && die "the key was found (above)" || echo "   nothing found in files"
N=$(git -C "$PROJ_REPO" cat-file --batch-all-objects --batch | grep -cFf "$SURETY_REAL_KEY_REF" || true)
echo "   git objects holding it: $N"
check 9 "grep of the key's value over the engine home and the repository finds nothing" \
  "grep -rlFf \$SURETY_REAL_KEY_REF $SURETY_HOME $PROJ_REPO; git -C $PROJ_REPO cat-file --batch-all-objects --batch | grep -cFf \$SURETY_REAL_KEY_REF"

stop_engine
say "Done. Write down anything that surprised you: each surprise is a decision for you or a new failing test."
note "The records of this run are kept in $WORK."
