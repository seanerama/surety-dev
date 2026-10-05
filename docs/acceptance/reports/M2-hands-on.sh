#!/usr/bin/env bash
# The M2 hands-on walkthrough (acceptance row M142): Sean watches the first
# real run. It follows the plan's M142 step by step: start the engine from a
# login session; read GET /v1/engine; a dispatch with no entry; `surety
# qualify`; wait for his two approvals; the journey's first path; a Stop.
# Each step says in plain words what it does, and each of M142's checks (1)
# to (9) is printed as "CHECK (n)" with the command he can run himself.
#
# IT USES SEAN'S CLAUDE SUBSCRIPTION (E74 item 1, his decision): a long-
# lived token he makes himself with `claude setup-token`. Every run draws on
# his subscription's usage allowance, the same allowance his own Claude use
# draws on; the hard limit is that subscription's usage limits, not a dollar
# cap, and the dollar figures the engine shows are Claude Code's own
# estimates (`total_cost_usd`). It refuses to start unless he has set the
# token's reference (the path of the file holding it) and typed the
# confirmation (below), and it asks him again before every paid step, saying
# what that step can use at most. The two decisions that let paid work start, the
# attempt's `qualification_approval` and the entry's `trust_activation`,
# are his: the script shows each preview and waits; it sends an answer
# only when he types it here, or he sends it himself from another terminal.
#
# What a step can use at most: 300 000 billable tokens a run (E59), which
# at claude-sonnet-5-5's dearest list rate, 10 USD per million output
# tokens, is 3.00 USD a run in Claude Code's own estimate. Cache reads
# (0.20 USD per million) are not billable tokens and are not counted by the
# engine's limit, and one run can overshoot its limit until its deadline
# (D2 §4.2, §8 class C). The engine stops starting runs at each project's day
# limit on those estimates (10 USD for the qualification's own project, 6 USD
# for the journey's); the hard limit is your subscription's usage limits.
#
# Before running it:
#   - from a login session of uid 1000 with the user manager running
#     (`systemctl --user is-system-running` prints running), with util-linux
#     and iproute2 present (no agent account: the engine delegates its own
#     scope, D2 K9);
#   - `npm run build` in this checkout, which must be on a revision whose
#     engine builds slice 14 (the real lane's engine side);
#   - step 0, yourself, before this script: make the subscription token and
#     keep it in a file of its own, readable by you only. Never paste the token
#     into this script, a command line or a chat:
#       claude setup-token          # sign in in the browser it opens; it prints a long-lived token
#       install -m 600 /dev/null ~/.config/surety/claude-subscription.token
#       $EDITOR ~/.config/surety/claude-subscription.token   # paste the token, one line, save
#     When M2 is done, revoke the token in your Claude account's settings
#     (where your plan lists Claude Code's long-lived tokens) and delete the
#     file. A leaked token reaches your subscription account, nothing else:
#     inside the sandbox the proxy lets the agent reach the provider only.
#   - the Claude Code binary to qualify, by its own file (not the
#     ~/.local/bin/claude link, which moves when Claude Code updates itself);
#     see the M2 report's question on pinning it.
#
# Usage:
#   SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
#   SURETY_REAL_CLAUDE_BINARY=/path/to/the/pinned/claude \
#   SURETY_HANDS_ON_CONFIRM_SPEND='I accept the M2 real lane on my Claude subscription, up to 25 USD a day as estimated' \
#   bash docs/acceptance/reports/M2-hands-on.sh
#
# Everything it makes is under one directory (SURETY_HANDS_ON_DIR, by
# default ~/surety-hands-on-<date>), printed at the start and KEPT at the
# end: the engine's records are the run's evidence. KEEP=0 removes it.
#
# The dress rehearsal (E79), never Sean's run: SURETY_REAL_REHEARSAL=1 runs
# the same steps against the rehearsal's fake claude (built from
# packages/engine/test/acceptance/harness/standin/), with a made-up token.
# It refuses any binary that does not carry the fake's marker, is larger
# than 1 MiB or lies inside Claude Code's own install directories. Its only
# egress host is provider.rehearsal.invalid, so nothing reaches a provider
# and the attempt fails on its provider-tunnel control, as expected; the
# rehearsal then goes on with a labelled fixture entry in the api_key mode
# (the fixture's only mode) so that steps 9 to 11 run too. Nothing it shows
# is evidence for M2.

set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "STOP: $*" >&2; exit 1; }

CONFIRM_PHRASE='I accept the M2 real lane on my Claude subscription, up to 25 USD a day as estimated'
MODEL=claude-sonnet-5-5
RUN_TOKENS=300000
OUT_USD_PER_MILLION=10
AUTH_MODE=subscription_token
KEY_REF_NAME=backend/claude/subscription_token

# ---- the guards: nothing starts unless every one holds ------------------------------

[ -n "${SURETY_REAL_CREDENTIAL_REF:-}" ] || die "set SURETY_REAL_CREDENTIAL_REF to the absolute path of the file that holds your subscription token from claude setup-token (never the token itself). Nothing was started."
case $SURETY_REAL_CREDENTIAL_REF in
  /*) ;;
  *) die "SURETY_REAL_CREDENTIAL_REF must be an absolute path to the token's file; its value is not shown. Nothing was started." ;;
esac
[ -f "$SURETY_REAL_CREDENTIAL_REF" ] && [ ! -L "$SURETY_REAL_CREDENTIAL_REF" ] || die "SURETY_REAL_CREDENTIAL_REF must name a regular file, not a link. Nothing was started."
KEY_MODE=$(stat -c %a "$SURETY_REAL_CREDENTIAL_REF")
[ "$KEY_MODE" = 600 ] || [ "$KEY_MODE" = 400 ] || die "the token's file must be readable by you only (chmod 600). Nothing was started."
[ "$(wc -l < "$SURETY_REAL_CREDENTIAL_REF")" -le 1 ] || die "the token's file must hold the token on one line and nothing else. Nothing was started."
[ "${SURETY_HANDS_ON_CONFIRM_SPEND:-}" = "$CONFIRM_PHRASE" ] || die "set SURETY_HANDS_ON_CONFIRM_SPEND='$CONFIRM_PHRASE' to confirm the use of your subscription. Nothing was started."
[ -n "${SURETY_REAL_CLAUDE_BINARY:-}" ] || die "set SURETY_REAL_CLAUDE_BINARY to the Claude Code binary to qualify, by its own file. Nothing was started."
[ -f "$SURETY_REAL_CLAUDE_BINARY" ] && [ ! -L "$SURETY_REAL_CLAUDE_BINARY" ] && [ -x "$SURETY_REAL_CLAUDE_BINARY" ] || die "SURETY_REAL_CLAUDE_BINARY must be an executable regular file, not a link. Nothing was started."
[ -t 0 ] || die "run this from your terminal: it asks you before every paid step. Nothing was started."

# The rehearsal switch (E79): only with the rehearsal's fake, checked by
# content, size and place before anything starts.
REHEARSAL=${SURETY_REAL_REHEARSAL:-}
EGRESS_HOST=api.anthropic.com
REHEARSAL_MARKER='SURETY REHEARSAL FAKE CLAUDE'
if [ -n "$REHEARSAL" ]; then
  [ "$REHEARSAL" = 1 ] || die "SURETY_REAL_REHEARSAL must be 1 or unset. Nothing was started."
  FAKE_REAL=$(readlink -f "$SURETY_REAL_CLAUDE_BINARY")
  WHY=
  if [ "$(stat -c %s "$FAKE_REAL")" -gt 1048576 ]; then WHY="$WHY; it is larger than 1 MiB"
  elif ! grep -qaF "$REHEARSAL_MARKER" "$FAKE_REAL"; then WHY="$WHY; it does not carry \"$REHEARSAL_MARKER\""; fi
  case $FAKE_REAL in "$HOME/.local/share/claude"/*|"$HOME/.local/bin"/*) WHY="$WHY; it is inside Claude Code's own install directories" ;; esac
  [ -z "$WHY" ] || die "the rehearsal switch works only with the rehearsal's fake claude, and $SURETY_REAL_CLAUDE_BINARY is not it${WHY}. Nothing was started."
  EGRESS_HOST=provider.rehearsal.invalid
  printf '\n%s\n# M2 HANDS-ON: DRESS REHEARSAL (SURETY_REAL_REHEARSAL=1)\n# The backend is the FAKE claude at %s: it runs no model and uses nothing.\n# The only egress host is %s: nothing reaches a provider.\n# Nothing here is evidence for M2.\n%s\n' \
    "$(printf '#%.0s' $(seq 1 78))" "$FAKE_REAL" "$EGRESS_HOST" "$(printf '#%.0s' $(seq 1 78))"
fi
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
  [ -z "$REHEARSAL" ] || note "(REHEARSAL: the fake runs no model; this step uses nothing. The question is asked as it will be.)"
  note "It starts $runs real run(s) of Claude Code ($MODEL) on your Claude subscription, drawing on the usage allowance your own Claude use shares."
  note "At most, in billable tokens: $runs x $RUN_TOKENS tokens x $OUT_USD_PER_MILLION USD per million = $usd USD in Claude Code's own estimate,"
  note "plus cache reads (0.20 USD per million, not counted by the engine's limit) and any overshoot until a run's deadline."
  note "The project's day limit on those estimates stops new runs; the hard limit is your subscription's usage limits."
  local answer
  read -r -p "   Type yes to go on, anything else to stop here: " answer
  [ "$answer" = yes ] || die "stopped before: $what. Nothing of it was started."
}

# Whether a control group has members. A cgroupfs file reports size 0
# whatever it holds, so `[ -s ]` is always false there (found by the E79
# rehearsal): its content is read instead.
has_members() { [ -n "$(cat "$1/cgroup.procs" 2>/dev/null)" ]; }

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
  args+=(--secret-file "$KEY_REF_NAME=$SURETY_REAL_CREDENTIAL_REF")
  [ "$AUTH_MODE" != api_key ] || args+=(--provider-cap-usd "$KEY_REF_NAME=50")
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
      S "$API/v1/projects/$1/runs/$r" | jq '.run | {id, role, state, outcome, reason_class, exit_class}'
      # The reason as the engine recorded it (the run read does not carry it,
      # SEAM.md section 17; found by the E85 rehearsal, where it printed null).
      echo "   reason recorded: $(dbq "SELECT COALESCE(reason_text, '(none)') FROM runs WHERE id = '$r'")"
      return 0
    fi
    tick "$1"; sleep 10
  done
  die "the run of $2 did not end in $3 s"
}

say "0. Where everything is kept: $WORK"
note "The engine's home is $SURETY_HOME. The pinned binary is $SURETY_REAL_CLAUDE_BINARY,"
note "reached by the engine through $BIN/claude, first on its PATH. The token stays in its file: the engine is given the path."

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
# The policy before the plan: the plan makes the stage's work eligible and
# the engine dispatches it at once, under the backend the policy names then.
S -X POST "$API/v1/projects/$P0/policy" -d '{"backend_builder": "claude", "preflight_refusals_max": 1}' | jq -c '{revision: .revision?}'
S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P0\", \"requirements\": [{\"key\": \"R1\"}], \"stages\": [{\"number\": 1, \"goal\": \"anything\", \"implements\": [\"R1\"]}]}" > "$WORK/plan0.json"
W0=$(jq -r '.stages[0].work_item' "$WORK/plan0.json")
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
  "$NODE" "$CLI" qualify claude --mode one_shot_headless --model "$MODEL" --auth-mode "$AUTH_MODE" --egress "$EGRESS_HOST" | tee "$WORK/qualify.json"
QA=$(jq -r '.qualification_attempt.id' "$WORK/qualify.json")
[[ $QA == qa_* ]] || die "no attempt was proposed (see above)"
# What the approval binds: its dependency manifest, read from the engine's
# store (GET /v1/decisions lists the question and the options, not the
# manifest; SEAM.md section 117). Found by the E79 rehearsal: read from the
# API it printed nulls.
dbq "SELECT dependency_manifest FROM decisions WHERE kind = 'qualification_approval' AND subject_id = '$QA' AND status = 'open'" | jq '{binary_sha256, help_sha256, model, template_version, auth_mode, candidate_egress, canary_deadlines, spend}'
check 3 "the approval's preview shows the binary's hash, the model, the auth mode subscription_token and the spend labelled an estimate (Claude Code's own; no dollar cap: your subscription's limits are the hard limit)" \
  "the manifest above is the decision row's dependency_manifest in $SURETY_HOME/store.db; the question the API shows: curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/decisions | jq '.decisions[] | select(.kind == \"qualification_approval\") | {question, preview_hash}'"
echo "   the binary you pinned: $(sha256sum "$SURETY_REAL_CLAUDE_BINARY" | cut -c1-64)"

paid "the qualification attempt: three canaries (positive, cancellation, containment)" 3
say "5. Your first approval: qualification_approval"
wait_for_sean qualification_approval "$QA"

say "6. The canaries run, one at a time, each in its own sandbox and control group"
SHOWN=
# As long as the attempt's own canary deadlines allow, plus 20 minutes (found
# by the E79 rehearsal: a fixed 600 looks of 3 s each could give up before
# canaries of 900, 600 and 900 seconds had ended).
LIMIT=$(( $(dbq "SELECT canary_deadlines FROM qualification_attempts WHERE id = '$QA'" | jq '[.[]] | add') + 1200 ))
note "Waiting up to $LIMIT s for the attempt to end."
STARTED=$SECONDS
while [ $((SECONDS - STARTED)) -lt "$LIMIT" ]; do
  tick "$FIXTURE"
  STATUS=$(dbq "SELECT status FROM qualification_attempts WHERE id = '$QA'")
  CG=$(dbq "SELECT d.cgroup_path FROM execution_domains d JOIN invocation_receipts r ON r.run = d.run WHERE r.qualification_attempt = '$QA' AND d.observation IS NOT 'terminated' ORDER BY d.created_at DESC LIMIT 1")
  if [ -z "$SHOWN" ] && [ -n "$CG" ] && has_members "$CG"; then
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
# Not seen is said, never left out (found by the E79 rehearsal, where the
# fake's canaries ended between two looks).
[ -n "$SHOWN" ] || note "CHECK (4) NOT SHOWN: no canary's domain was seen with processes in it between two looks (every 3 s); the canaries' evidence below still holds what the engine sampled."
dbq "SELECT status, canaries FROM qualification_attempts WHERE id = '$QA'" | tee "$WORK/attempt.tsv"
# Why each canary ended as it did, shown before anything can stop the
# walkthrough (E86 item 4): its verdict, and for a canary whose agent wrote
# no result, the backend's own final message from its transcript (the
# engine's record, already screened for secrets; cut at 800 characters),
# with any model fallback the stream recorded.
for KIND in positive cancellation containment; do
  CROW=$(dbq "SELECT c.value ->> 'run', COALESCE(c.value ->> 'passed', ''), COALESCE(c.value ->> 'failure_class', '') FROM qualification_attempts q, json_each(q.canaries) c WHERE q.id = '$QA' AND c.value ->> 'kind' = '$KIND'")
  [ -n "$CROW" ] || { note "$KIND canary: did not run"; continue; }
  CRUN=$(echo "$CROW" | cut -f1); CPASS=$(echo "$CROW" | cut -f2); CFAIL=$(echo "$CROW" | cut -f3)
  echo "$KIND canary: passed=$CPASS ${CFAIL:+failure_class=$CFAIL}"
  [ "$CPASS" = 1 ] || [ "$CPASS" = true ] && continue
  if [ -n "$(dbq "SELECT id FROM records WHERE run = '$CRUN' AND kind IN ('result', 'unaccepted_result') LIMIT 1")" ]; then
    note "its agent wrote a result (kept in the engine's records)."
  fi
  CT=$(dbq "SELECT id FROM records WHERE run = '$CRUN' AND kind = 'transcript' ORDER BY rowid LIMIT 1")
  if [ -z "$CT" ]; then note "no transcript was recorded for it."; continue; fi
  echo "   the backend's final message (its transcript, cut at 800 characters):"
  grep '^{' "$(record_path "$CT")" | jq -rs '([.[] | select(.type == "result") | .result | strings] | last) // ([.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text] | last) // "(none in its transcript)"' | head -c 800; echo
  grep '^{' "$(record_path "$CT")" | jq -c 'select(.type == "system" and .subtype == "model_refusal_fallback") | {original_model, fallback_model, trigger, api_refusal_category}' | sed 's/^/   model fallback: /'
done
REHEARSAL_FIXTURE=
if [ "$(dbq "SELECT status FROM qualification_attempts WHERE id = '$QA'")" != succeeded ]; then
  [ -n "$REHEARSAL" ] || die "the attempt did not succeed; its records are in $SURETY_HOME"
  # The rehearsal's expected failure, and only it: the positive and the
  # cancellation canaries passed; the containment canary's actions all
  # passed, delegation was shown absent, and the provider tunnel is the only
  # control that did not run (no provider is reachable).
  CANARIES=$(dbq "SELECT canaries FROM qualification_attempts WHERE id = '$QA'")
  CEV=$(record_path "$(echo "$CANARIES" | jq -r '.[] | select(.kind == "containment") | .evidence')")
  echo "$CANARIES" | jq -e 'map({(.kind): .passed}) | add | .positive == true and .cancellation == true and .containment == false' >/dev/null &&
    jq -e '(.actions | length > 0 and all(.passed == true)) and .capabilities.delegation_verified == true and ([.controls[] | select(.ran != true) | .name] == ["provider_tunnel"])' "$CEV" >/dev/null ||
    die "REHEARSAL: the attempt failed for more than the provider tunnel; its records are in $SURETY_HOME"
  note "REHEARSAL: the attempt failed as expected: its provider-tunnel control could not run (no provider is reachable); every other canary check passed."
  REHEARSAL_FIXTURE=1
fi

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
if [ -z "$REHEARSAL_FIXTURE" ]; then
  ENTRY=$(dbq "SELECT trust_entry FROM qualification_attempts WHERE id = '$QA'")
  wait_for_sean trust_activation "$ENTRY"
  S "$API/v1/engine" | jq --arg e "$ENTRY" '{backends, entry: (.trust_entries[] | select(.id == $e) | {id, status, version, binary_sha256, usage_granularity, cost_reporting, enforceable_boundaries})}'
  stop_engine
else
  # REHEARSAL ONLY: no entry was written, so the journey runs on an active
  # entry the test mode's fixture installs, bound to the fake's script form
  # (the fixture refuses an executable image and anything the engine's PATH
  # names claude), in the api_key mode, the fixture's only one. Labelled;
  # it stands for nothing of the real activation.
  stop_engine
  AUTH_MODE=api_key
  KEY_REF_NAME=backend/claude/api_key
  start_engine real-lane
  FIXTURE_FAKE=$WORK/rehearsal-fake-backend
  { printf '#!%s\n' "$NODE"; cat "$REPO/packages/engine/test/acceptance/harness/standin/rehearsal-claude.cjs"; } > "$FIXTURE_FAKE"
  chmod 755 "$FIXTURE_FAKE"
  ENTRY=$(S -X POST "$API/v1/harness/fixtures/trust-entry" -d "{\"backend\": \"claude\", \"status\": \"active\", \"binary\": {\"path\": \"$FIXTURE_FAKE\", \"sha256\": \"$(sha256sum "$FIXTURE_FAKE" | cut -c1-64)\"}, \"model\": \"$MODEL\", \"egress_hosts\": [\"$EGRESS_HOST\"]}" | jq -r '.trust_entry.id')
  [[ $ENTRY == trust_* ]] || die "REHEARSAL: the fixture entry was not installed"
  note "REHEARSAL: the journey runs on fixture entry $ENTRY (active, api_key mode, bound to the fake's script form); the real activation did not run."
  stop_engine
fi

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
# The policy before the plan (as in step 3).
S -X POST "$API/v1/projects/$P/policy" -d '{"backend_builder": "claude", "backend_verifier": "claude", "backend_reviewer": "claude", "budget_run_billable_tokens": 300000, "budget_day_verified_usd": 6, "budget_day_unknown_tokens": 900000, "deadline_builder": 900, "deadline_verifier": 600, "deadline_reviewer": 600}' | jq -c '{revision: .revision?}'
S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R1\", \"text\": \"src/greeting.js exports greeting(name), returning \\\"Hello, \\\" followed by name and \\\"!\\\".\"}], \"constraints\": [{\"key\": \"C1\", \"text\": \"Plain JavaScript modules with no dependencies.\"}], \"stages\": [{\"number\": 1, \"goal\": \"Implement R1: create src/greeting.js as R1 describes.\", \"implements\": [\"R1\"]}]}" > "$WORK/plan.json"
STAGE=$(jq -r '.stages[0].id' "$WORK/plan.json"); BUILD=$(jq -r '.stages[0].work_item' "$WORK/plan.json")
CHK=$(S -X POST "$API/v1/harness/fixtures/checks" -d "{\"project\": \"$P\", \"checks\": [{\"key\": \"login\", \"kind\": \"acceptance\", \"gate_kinds\": [\"stage\", \"alpha_authorize\"], \"requirements\": [\"R1\"]}]}" | jq -r '.checks[0].id')

# Where the journey starts: after the engine's own setup commits (the
# project's bootstrap and its policy revision, which no run makes).
JOURNEY_BASE=$(git -C "$PROJ_REPO" rev-parse refs/heads/main)

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

echo "the engine's setup commits before the journey (no run makes them: they name the project, not a run):"
git --no-pager -C "$PROJ_REPO" log --format='%h %an <%ae>%n%(trailers:only)' "$BASE..$JOURNEY_BASE"
echo "the journey's commits:"
git --no-pager -C "$PROJ_REPO" log --format='%h %an <%ae>%n%(trailers:only)' "$JOURNEY_BASE..main"
check 6 "every commit of the journey on the integration branch is the engine's, with Surety-Run and Surety-Role trailers, and none is the agent's (the setup commits before it are the engine's too, with Surety-Project)" \
  "git --no-pager -C $PROJ_REPO log --format='%h %an <%ae>%n%(trailers:only)' $BASE..main"

echo "the ledger, as the engine reads it:"
S "$API/v1/projects/$P/ledger" | jq '{totals, rows: [.rows[] | {run, billable_in, cached_in, out, cost_status, cost_usd, usage_complete, unknown_allowance_tokens, normalization_version}]}'
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
  [ -n "$SCG" ] && has_members "$SCG" && break
  tick "$P"; sleep 2
done
[ -n "$SCG" ] && has_members "$SCG" || die "the run was never seen with processes in its domain; a Stop now would end nothing, so the walkthrough stops here"
echo "the run $SR is in $SCG:"; cat "$SCG/cgroup.procs"
read -r -p "   Press enter to Stop it. " _
has_members "$SCG" || note "NOTE: the run's processes had already ended before the Stop was sent: what follows shows nothing about a Stop of a live process (CHECK (8) is not shown by this run)."
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
if [ -n "$REHEARSAL" ]; then
  # REHEARSAL ONLY (E84, E85): a Builder whose provider cannot be reached. The
  # rehearsal's fake, seeing the marker in its stage, sends one CONNECT to its
  # listed name (a .invalid one, which never resolves) and ends as Claude Code
  # did in Sean's second attempt. Shown: what ended the run, its egress log,
  # and its ledger row (a zero by the egress evidence, if the engine makes one).
  say "10b. REHEARSAL ONLY: a Builder whose provider is unreachable through the proxy"
  S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R4\", \"text\": \"src/unreachable.js exports nothing.\"}], \"stages\": [{\"number\": 3, \"goal\": \"[rehearsal: provider unreachable] Implement R4.\", \"implements\": [\"R4\"]}]}" > "$WORK/plan3.json"
  UNREACH=$(jq -r '.stages[0].work_item' "$WORK/plan3.json")
  paid "a Builder run whose provider is unreachable (rehearsal only)" 1
  tick "$P"
  wait_run_end "$P" "$UNREACH" 600
  UR=$(run_of "$UNREACH")
  echo "its egress log:"
  UEG=$(dbq "SELECT id FROM records WHERE run = '$UR' AND kind = 'egress_log'")
  if [ -n "$UEG" ]; then jq -c '{authority, decision, reason, resolved, bytes_up}' "$(record_path "$UEG")"; else echo "   (no egress_log record)"; fi
  echo "its ledger row:"
  S "$API/v1/projects/$P/ledger" | jq --arg r "$UR" '.rows[] | select(.run == $r) | {billable_in, cached_in, out, cost_status, cost_usd, usage_complete, unknown_allowance_tokens, normalization_version}'
fi

say "11. The token is nowhere the engine or the repository keeps anything"
note "grep reads the token from its file (-f), so it never appears on a command line."
# Matches, unreadable files and the verdict kept apart (found by the E79
# rehearsal): grep exits 2 when a file cannot be read, even after a match,
# so its status alone would report a found token, or an unread file, as
# nothing found. An unread file is named, never counted as clean; the
# engine's execute-only copies of node (mode 111, node's size) are named so.
GREP_STATUS=0
HITS=$(grep -rlFf "$SURETY_REAL_CREDENTIAL_REF" "$SURETY_HOME" "$PROJ_REPO" 2>"$WORK/token-grep.err") || GREP_STATUS=$?
[ -z "$HITS" ] || { echo "$HITS"; die "the token was found in the files above"; }
NODE_SIZE=$(stat -c %s "$(readlink -f "$NODE")")
UNREAD=0
while IFS= read -r line; do
  f=${line#grep: }; f=${f%: Permission denied}
  [ "$f" != "$line" ] || { echo "   grep: $line"; UNREAD=$((UNREAD + 1)); continue; }
  if [ "$(stat -c %a "$f")" = 111 ] && [ "$(stat -c %s "$f")" = "$NODE_SIZE" ]; then
    echo "   not read: $f (the engine's execute-only copy of node, mode 111, node's size)"
  else
    echo "   NOT READ, not shown to hold nothing: $f"
  fi
  UNREAD=$((UNREAD + 1))
done < "$WORK/token-grep.err"
case $GREP_STATUS in
  1) echo "   nothing found in any file" ;;
  2) [ "$UNREAD" -gt 0 ] && echo "   nothing found in the files that could be read; $UNREAD could not be read (listed above)" || die "grep failed (status 2) with nothing it could not read; see $WORK/token-grep.err" ;;
  *) die "grep ended with status $GREP_STATUS; see $WORK/token-grep.err" ;;
esac
N=$(git -C "$PROJ_REPO" cat-file --batch-all-objects --batch | grep -cFf "$SURETY_REAL_CREDENTIAL_REF" || true)
echo "   git objects holding it: $N"
check 9 "grep of the token's value over the engine home and the repository finds nothing" \
  "grep -rlFf \$SURETY_REAL_CREDENTIAL_REF $SURETY_HOME $PROJ_REPO; git -C $PROJ_REPO cat-file --batch-all-objects --batch | grep -cFf \$SURETY_REAL_CREDENTIAL_REF"

stop_engine
say "Done. Write down anything that surprised you: each surprise is a decision for you or a new failing test."
note "When M2 is done: revoke the subscription token in your Claude account's settings and delete $SURETY_REAL_CREDENTIAL_REF."
note "The records of this run are kept in $WORK."
