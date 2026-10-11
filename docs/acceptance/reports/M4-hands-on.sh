#!/usr/bin/env bash
# The M4 hands-on walkthrough (acceptance row M344; BS4 §13, question 9 as
# recommended, E121 item 4): Sean watches the engine deploy the reference
# service to a real Alpha unit on this host, verify it, notice his own
# restart of it, and tear it down. It follows the plan's M344 step by step,
# and each of its six checks is printed as "CHECK (n)" with the command he
# can run himself:
#   (1) the unit and its cgroup, read from the host by its exact name;
#   (2) the original application instance, and the identity read's tree hash
#       beside the sealed digest;
#   (3) the verification row with both bracketing reads and the post-deploy
#       check's result;
#   (4) a manual restart of his hands-on unit: its launcher refused, and the
#       out-of-band decision it raises;
#   (5) the environment read's three facts;
#   (6) a teardown leaving no unit, cgroup, socket or directory of the prefix.
#
# NO MODEL, NO TOKEN, NOTHING PAID: every role is the harness's scripted
# role (the engine's test mode, `--harness --harness-scripted`); no backend
# binary is named or started. The check runner is qualified by the engine's
# own self-test at its start (`--harness-runner-self-test run`) and the
# adapter by `surety qualify-adapter local_service` in this script's own
# home, never by a fixture. The service is the reference project's
# (packages/engine/test/acceptance/harness/project/service.mjs; SEAM §325),
# with one disposable random secret this script makes and never prints.
#
# SAFETY (BS4 §4.1 rules 1, 2, 7, 8; E64; SEAM §337). Read before changing
# anything here.
#   - This script never acts on a unit itself. Every unit is the engine's,
#     created, stopped and removed through its adapter, under a name derived
#     from this script's own disposable home: surety-<h>-env_<id>-g<n>.service,
#     <h> the first 12 hex digits of SHA-256 of that home.
#   - Every step that makes the engine act (the qualification, the
#     deployment request, the decision's answer, a teardown) first reads the
#     prefix (`read_prefix`): the units the user manager has loaded under this
#     home's prefix, each by exact name, each named in an attempt intent of
#     this home's store; anything else carrying the prefix stops the script
#     before the engine is asked to act.
#   - The manual restart of step 6 is YOURS: the script reads the unit's
#     containment from the host (the unit carries this home's prefix and the
#     store's intent names it; the recorded application is in its cgroup and
#     in none of the host's namespaces), then PRINTS the one command, by the
#     unit's exact name, for you to run in another terminal. It never runs it.
#   - The host is otherwise only read: `systemctl --user show`, `list-units`,
#     `is-system-running`, cgroup files, /proc, `journalctl --user -u` of an
#     exact name. Nothing here stops, restarts, reloads, re-executes or
#     daemon-reloads the user manager; no sudo, loginctl or Docker.
#   - The only process it signals is its own engine, at the end, after
#     reading from /proc that the pid is that engine (`serve`, this home).
#
# Before running it:
#   - from a login session of uid 1000 with the user manager running
#     (`systemctl --user is-system-running` prints running), with jq, curl,
#     git, node, systemctl and journalctl; the machine otherwise quiet
#     (BS4 §4.1 rule 12); no `surety-*` unit loaded;
#   - `npm run build` in this checkout, on a revision with M4's engine.
#
# Usage:
#   bash docs/acceptance/reports/M4-hands-on.sh
# It pauses at each check for you to look, and goes on when you press enter
# (SURETY_HANDS_ON_NO_PAUSE=1 goes straight on; it still needs a terminal,
# and step 6 still waits for your restart). Everything it makes is under one
# temporary directory (SURETY_HANDS_ON_DIR, by default a new
# /tmp/surety-m4-hands-on-XXXXXX), printed at the start and REMOVED at the
# end unless KEEP=1, or unless anything of its prefix is still loaded, in
# which case it is kept and each leftover is printed by its exact name.
# About fifteen minutes: the engine's host checks and self-test at start,
# the adapter's qualification, the deployment, and the waits for the
# observation that sees your restart.

set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "STOP: $*" >&2; exit 1; }

# Each check of M344, with the command Sean can run himself.
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
[ -t 0 ] || die "run this from your terminal: it pauses at each check and waits for your restart in step 6, and SURETY_HANDS_ON_NO_PAUSE=1 skips the pauses but not this. Nothing was started."
for tool in jq curl git node systemctl journalctl sha256sum; do command -v "$tool" >/dev/null || die "$tool is needed. Nothing was started."; done
[ "$(systemctl --user is-system-running 2>/dev/null || true)" = running ] || die "the user manager is not running (systemctl --user is-system-running). Nothing was started."
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$REPO/packages/engine/dist/cli.js
[ -f "$CLI" ] || die "not built: run 'npm run build' first. Nothing was started."
SERVICE_SOURCE=$REPO/packages/engine/test/acceptance/harness/project/service.mjs
FIXTURES_SOURCE=$REPO/packages/engine/test/acceptance/harness/checks/fixtures.mjs
CHILD_SOURCE=$REPO/packages/engine/test/acceptance/harness/scripted/child.mjs
[ -f "$SERVICE_SOURCE" ] && [ -f "$FIXTURES_SOURCE" ] && [ -f "$CHILD_SOURCE" ] || die "the harness's reference service and scripted role are missing from this checkout. Nothing was started."
NODE=$(readlink -f "$(command -v node)")

# ---- the work directory, the home, the prefix ---------------------------------------------

if [ -n "${SURETY_HANDS_ON_DIR:-}" ]; then
  WORK=$SURETY_HANDS_ON_DIR
  # A directory that exists already is refused, never reused or removed.
  [ ! -e "$WORK" ] && [ ! -L "$WORK" ] || die "$WORK exists already; name a new SURETY_HANDS_ON_DIR. Nothing was started."
  mkdir -p "$WORK" && chmod 700 "$WORK"
else
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/surety-m4-hands-on-XXXXXX")
fi
MADE_WORK=1
case $WORK in "$REPO"/*) die "the work directory must be outside the repository. Nothing was started." ;; esac
SURETY_HOME=$WORK/home
SCRIPTED=$WORK/scripted
PROJ_REPO=$WORK/repo
SECRETS=$WORK/secrets
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts" "$SECRETS"
chmod 700 "$SECRETS"
# The unit prefix the engine derives from this home (D4 §9.3; SEAM §250): every unit of this run carries it.
PREFIX="surety-$(printf '%s' "$SURETY_HOME" | sha256sum | cut -c1-12)-"
free_port() { "$NODE" -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'; }
PORT=$(free_port)
API=http://127.0.0.1:$PORT
ENGINE_PID=
P=
ENV_ID=

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
tick() { S -X POST "$API/v1/projects/$1/tick" -d '{}' >/dev/null; }
# Tick a project until a store query prints something (a value), at most $3 seconds.
until_db() { # project, query, seconds, what
  local i v
  for i in $(seq 1 $(( $3 / 2 ))); do
    v=$(dbq "$2" | head -1)
    if [ -n "$v" ]; then echo "$v"; return 0; fi
    [ -n "$1" ] && tick "$1"
    sleep 2
  done
  die "timed out waiting for $4"
}

# ---- reading the prefix: before every act of the engine ------------------------------------

# The units the user manager has loaded under this home's prefix, by exact name (a read: the
# listing is filtered here, and grants nothing).
units_of_prefix() {
  systemctl --user list-units --all --no-legend --plain --no-pager --full | awk '{print $1}' | grep -F -- "$PREFIX" | grep -E "^${PREFIX}env_[0-9A-HJKMNP-TV-Z]{26}-g[1-9][0-9]*\.service$" || true
}
# Every unit name this home's store has recorded in an attempt intent, before the unit existed.
intended_units() {
  [ -f "$SURETY_HOME/store.db" ] || return 0
  dbq "SELECT create_units FROM attempt_intents" | jq -r '.[]' 2>/dev/null || true
}
# The prefix read (BS4 §4.1 rules 1 and 8): the manager running; every loaded unit carrying this
# home's prefix shown by its exact name and named in an intent of this home's store; anything
# else carrying the prefix (a name the store does not know) stops the walkthrough before the
# engine is asked to act. Sets OWN_UNITS.
read_prefix() {
  local u all intended
  [ "$(systemctl --user is-system-running 2>/dev/null || true)" = running ] || die "the user manager is not running: nothing is asked of the engine"
  all=$(systemctl --user list-units --all --no-legend --plain --no-pager --full | awk '{print $1}' | grep -F -- "$PREFIX" || true)
  OWN_UNITS=$(units_of_prefix)
  intended=$(intended_units)
  for u in $all; do
    printf '%s\n' "$OWN_UNITS" | grep -qxF -- "$u" || die "$u carries this home's prefix but is not named surety-<h>-env_<id>-g<n>.service: nothing is asked of the engine"
    printf '%s\n' "$intended" | grep -qxF -- "$u" || die "$u carries this home's prefix but this home's store names it in no attempt intent: nothing is asked of the engine"
  done
  note "prefix read: $PREFIX* loaded: ${OWN_UNITS:-(none)}"
}

# The engine's acts, each after the prefix read.
act_qualify() {
  read_prefix
  SURETY_HOME="$SURETY_HOME" "$NODE" "$CLI" qualify-adapter local_service
}
act_deploy() { # project, candidate
  read_prefix
  S -X POST "$API/v1/projects/$1/deployments" -d "{\"candidate\": \"$2\", \"environment\": \"alpha\"}"
}
act_answer() { # project, decision, option
  local hash
  read_prefix
  hash=$(dbq "SELECT preview_hash FROM decisions WHERE id = '$2'")
  S -X POST "$API/v1/projects/$1/decisions/$2/answer" -d "{\"option\": \"$3\", \"preview_hash\": \"$hash\"}"
}
act_teardown() { # project, preempt (true|false)
  read_prefix
  S -X POST "$API/v1/projects/$1/environments/alpha/teardown" -d "{\"preempt\": $2}"
}

# ---- the end: the engine's teardown if anything runs; its own engine stopped; the directory ----

# The script's own engine, by /proc: `serve` of this home. Anything else is never signalled.
own_engine() {
  [ -n "$ENGINE_PID" ] && [ -r "/proc/$ENGINE_PID/cmdline" ] && [ -r "/proc/$ENGINE_PID/environ" ] || return 1
  tr '\0' '\n' < "/proc/$ENGINE_PID/cmdline" | grep -qx serve || return 1
  tr '\0' '\n' < "/proc/$ENGINE_PID/environ" | grep -qxF "SURETY_HOME=$SURETY_HOME" || return 1
}
cleanup() {
  local left i
  set +e
  left=$(units_of_prefix)
  if [ -n "$left" ] && [ -n "$P" ] && own_engine; then
    echo "Something of this home's prefix is still loaded; the engine is asked to tear alpha down (preempting), after the prefix read:"
    # In a subshell: a prefix read that stops refuses the act, and the end goes on (engine, directory).
    ( act_teardown "$P" true >/dev/null )
    for i in $(seq 1 90); do left=$(units_of_prefix); [ -z "$left" ] && break; tick "$P" 2>/dev/null; sleep 2; done
  fi
  if own_engine; then kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" 2>/dev/null; fi
  left=$(units_of_prefix)
  if [ -n "$left" ]; then
    echo "KEPT: $WORK, because these units of its prefix are still loaded (each made by this walkthrough's engine; nothing was stopped by the script):"
    for i in $left; do
      echo "   $i"
      echo "     to stop it yourself, by its exact name: systemctl --user stop -- $i"
    done
  elif [ "${KEEP:-0}" = 1 ] || [ -z "${MADE_WORK:-}" ]; then
    echo "kept: $WORK"
  else
    rm -rf -- "$WORK" && echo "removed: $WORK (KEEP=1 keeps it)"
  fi
}
trap cleanup EXIT

say "0. Where everything is: $WORK"
note "The engine's home is $SURETY_HOME; every unit of this run is named ${PREFIX}env_<id>-g<n>.service."
read_prefix
[ -z "$OWN_UNITS" ] || die "units of this new home's prefix are loaded before anything started: $OWN_UNITS"

# ---- the service's secret, the scripted role, the repository --------------------------------

# One disposable random secret (D4 §7.4): made here, 0600, never printed, outside the engine home.
umask 077
"$NODE" -e 'process.stdout.write("surety-m4-hands-on-" + require("crypto").randomBytes(18).toString("hex"))' > "$SECRETS/ref_secret"
umask 022
cp "$CHILD_SOURCE" "$SCRIPTED/"
printf '%s\n' '{"steps": [{"result": {"status": "completed", "summary": "scripted role finished"}}]}' > "$SCRIPTED/scripts/default.json"
# The reference project's files (SEAM §325), from the harness, and the scripted Builder's two writes.
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO"
"$NODE" --input-type=module -e '
  import { mkdirSync, writeFileSync } from "node:fs";
  import { dirname, join } from "node:path";
  import { pathToFileURL } from "node:url";
  const [service, fixtures, repo, out] = process.argv.slice(1);
  const s = await import(pathToFileURL(service).href);
  const f = await import(pathToFileURL(fixtures).href);
  for (const [path, text] of Object.entries(s.serviceProjectFiles())) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  writeFileSync(join(out, "index.md"), f.indexText([s.REQUIREMENT]));
  writeFileSync(join(out, "builder.json"), JSON.stringify([{ steps: [{ write: { path: s.SUM_PATH, content: s.SUM } }, { write: { path: s.SERVER_PATH, content: s.SERVER } }, { result: { status: "completed", summary: "scripted Builder: the reference service", nominate: true } }] }]));
  writeFileSync(join(out, "policy.json"), JSON.stringify(s.POLICY));
' "$SERVICE_SOURCE" "$FIXTURES_SOURCE" "$PROJ_REPO" "$WORK"
printf '# M4 hands-on\n' > "$PROJ_REPO/README.md"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'fixture: the reference project, its checks and its post-deploy check'
git -C "$PROJ_REPO" checkout -q --detach
printf '{"api_port": %s, "tick_interval": 600, "terminate_grace": 3, "kill_grace": 2}\n' "$PORT" > "$SURETY_HOME/config.json"

# ---------------------------------------------------------------------------------------
say "1. Start the engine: the host checks and the runner self-test run at its start"
note "The test mode with the scripted role and the real local_service adapter; the service's secret by reference."
( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE")" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}" \
    "$NODE" "$CLI" serve --harness --harness-scripted "$SCRIPTED" --harness-host-checks run --harness-runner-self-test run --harness-deploy-adapter real \
    --secret-file "deploy/ref_secret=$SECRETS/ref_secret" >> "$WORK/engine.log" 2>&1 ) &
ENGINE_PID=$!
for i in $(seq 1 900); do
  if [ -f "$SURETY_HOME/api.token" ] && S "$API/v1/health" 2>/dev/null | jq -e '.mode == "full"' >/dev/null 2>&1; then break; fi
  kill -0 "$ENGINE_PID" 2>/dev/null || die "the engine exited; see $WORK/engine.log"
  sleep 0.2
done
S "$API/v1/health" | jq -e '.mode == "full"' >/dev/null || die "the engine did not reach full mode; see $WORK/engine.log"
own_engine || die "pid $ENGINE_PID is not this walkthrough's engine (by /proc): nothing more is done"
until_db "" "SELECT id FROM host_qualifications WHERE status = 'active' AND check_runner IS NOT NULL" 600 "the runner self-test" >/dev/null
dbq "SELECT check_runner FROM host_qualifications WHERE status = 'active'" | jq '{qualified, test_fixture, self_test: [.self_test[] | {case, result}]}'

# ---------------------------------------------------------------------------------------
say "2. Qualify the adapter: surety qualify-adapter local_service, in this home"
note "The engine deploys its own fixture services under this home's prefix, runs D4 §2.6's nine cases each beside"
note "its control, and removes everything it created. No model. It is the engine's act: the prefix is read first."
pause
QUAL=$(act_qualify) || { echo "$QUAL" | jq . 2>/dev/null || echo "$QUAL"; die "the adapter did not qualify"; }
echo "$QUAL" | jq '{qualified, adapter, adapter_version, adapter_qualification, cases: [.cases[] | {case, result, control}]}'
ADAPTER_VERSION=$(echo "$QUAL" | jq -r '.adapter_version')
read_prefix
[ -z "$OWN_UNITS" ] || die "the qualification left units of the prefix loaded: $OWN_UNITS"

# ---------------------------------------------------------------------------------------
say "3. The reference project: requirement R1 with R1.1, one stage; a scripted Builder writes the service"
P=$(S -X POST "$API/v1/projects" -d "{\"name\": \"m4-hands-on\", \"tier\": \"T1\", \"dev_repo_path\": \"$PROJ_REPO\", \"integration_branch\": \"main\"}" | jq -r '.project.id')
[[ $P == proj_* ]] || die "no project"
until_db "$P" "SELECT id FROM projects WHERE id = '$P' AND registration_state = 'registered'" 30 "the project to be registered" >/dev/null
S -X POST "$API/v1/projects/$P/policy" -d "$(cat "$WORK/policy.json")" | jq -c '{revision: .revision}'
PLAN=$(S -X POST "$API/v1/harness/fixtures/plan" -d "$(jq -n --arg p "$P" --rawfile idx "$WORK/index.md" '{project: $p, requirements: [{key: "R1"}], requirement_index: $idx, stages: [{number: 1, goal: "the reference service", implements: ["R1"]}]}')")
BUILD=$(echo "$PLAN" | jq -r '.stages[0].work_item')
[[ $BUILD == wi_* ]] || die "no stage work: $PLAN"
cp "$WORK/builder.json" "$SCRIPTED/scripts/$BUILD.json"
tick "$P"
C=$(until_db "$P" "SELECT id FROM candidates WHERE project = '$P' ORDER BY seq LIMIT 1" 180 "the candidate")
until_db "$P" "SELECT x.candidate FROM check_executions x JOIN checks c ON c.id = x.\"check\" WHERE x.candidate = '$C' AND x.status = 'recorded' GROUP BY x.candidate HAVING COUNT(DISTINCT c.key) >= 2" 300 "the workspace checks to be recorded" >/dev/null
echo "candidate $C; its workspace checks, run by the engine in check domains:"
dbq "SELECT c.key, x.status, r.exit_status FROM check_executions x JOIN checks c ON c.id = x.\"check\" LEFT JOIN check_results r ON r.execution = x.id WHERE x.candidate = '$C' ORDER BY x.execution_seq" | sed 's/^/   /'

# ---------------------------------------------------------------------------------------
say "4. The owner configures alpha: the engine's own node, node server.mjs, a free port, the secret by reference"
NODE_SHA=$(sha256sum "$NODE" | cut -d' ' -f1)
SERVICE_PORT=$(free_port)
CONFIG=$(jq -n --arg v "$ADAPTER_VERSION" --arg node "$NODE" --arg sha "$NODE_SHA" --argjson port "$SERVICE_PORT" \
  '{adapter: "local_service", adapter_version: $v, targets: ["app"], runtime: {path: $node, sha256: $sha}, start: [$node, "server.mjs"], port: $port, env: {}, secrets: {REF_SECRET: "deploy/ref_secret"}, check_secrets: [], egress: [], artifact: {exclude: []}, identity_method: "tree_digest"}')
echo "$CONFIG" | jq -c .
S -X PUT "$API/v1/projects/$P/environments/alpha/config" -d "$CONFIG" | jq -c '{environment: .environment.id, config: .config.id, config_identity: .config.config_identity}'
ENV_ID=$(dbq "SELECT id FROM environments WHERE project = '$P' AND name = 'alpha'")
[[ $ENV_ID == env_* ]] || die "no environment"

# ---------------------------------------------------------------------------------------
say "5. Deploy: the request, the engine's deploy on a real unit, its verification, alpha_deployed"
note "The engine's act: the prefix is read first."
pause
REQ=$(act_deploy "$P" "$C")
echo "$REQ" | jq -c '{authorization: {id: .authorization.id, status: .authorization.status}, work_item: .work_item.id}'
AUTH=$(echo "$REQ" | jq -r '.authorization.id')
[ -n "$AUTH" ] && [ "$(echo "$REQ" | jq -r '.authorization.status')" = issued ] || die "the request was not issued: $REQ"
VER=$(until_db "$P" "SELECT v.id FROM deployment_verifications v JOIN verification_rounds r ON r.id = v.round JOIN operations o ON o.id = r.operation WHERE o.project = '$P' AND o.kind = 'deploy' ORDER BY v.rowid DESC LIMIT 1" 600 "the verification row")
until_db "$P" "SELECT id FROM candidates WHERE id = '$C' AND progress = 'alpha_deployed'" 300 "the candidate to be alpha_deployed" >/dev/null
ATT=$(dbq "SELECT a.id FROM operation_attempts a JOIN operations o ON o.id = a.operation WHERE o.project = '$P' AND o.kind = 'deploy' ORDER BY a.rowid DESC LIMIT 1")
UNIT=$(dbq "SELECT create_units FROM attempt_intents WHERE attempt = '$ATT'" | jq -r '.[0]')
case $UNIT in "${PREFIX}${ENV_ID}-g"*.service) ;; *) die "the deploy's unit $UNIT does not carry this home's prefix for alpha" ;; esac
read_prefix
printf '%s\n' "$OWN_UNITS" | grep -qxF -- "$UNIT" || die "$UNIT is not loaded under this home's prefix"
systemctl --user show -p LoadState -p ActiveState -p SubState -p MainPID -p ControlGroup -p InvocationID -p Delegate -p Restart -p MemoryMax -p TasksMax -- "$UNIT" | sed 's/^/   /'
CG=/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value -- "$UNIT")
echo "its cgroup $CG holds:"
for pid in $(cat "$CG/cgroup.procs" 2>/dev/null); do printf '   %s  %s\n' "$pid" "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-140)"; done
check 1 "the unit by its exact name, its main process the launcher, Delegate=yes, Restart=no, and its cgroup's members read from the host" \
  "systemctl --user show -p MainPID -p ControlGroup -p Delegate -p Restart -- $UNIT; cat $CG/cgroup.procs"
pause

APP=$(dbq "SELECT app_instance FROM operation_attempts WHERE id = '$ATT'")
APP_PID=$(echo "$APP" | jq -r '.pid')
echo "the original application instance, as the engine recorded it at the init's started report:"
echo "$APP" | jq -c '{pid, start_time, exe, exe_sha256, argv}'
echo "the same process, read from the host now:"
note "start time (field 22 of /proc/$APP_PID/stat): $(awk '{print $22}' "/proc/$APP_PID/stat" 2>/dev/null || echo unreadable)"
note "executable's SHA-256: $(sha256sum "/proc/$APP_PID/exe" 2>/dev/null | cut -d' ' -f1 || echo unreadable)"
note "arguments: $(tr '\0' ' ' < "/proc/$APP_PID/cmdline" 2>/dev/null || echo unreadable)"
note "its cgroup: /sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$APP_PID/cgroup" 2>/dev/null)"
echo "the sealed digest the authorization bound: $(dbq "SELECT artifact_digest FROM deployment_authorizations WHERE id = '$AUTH'")"
echo "each identity read's tree hash beside it:"
dbq "SELECT identity_reads FROM deployment_verifications WHERE id = '$VER'" | jq -c '.[] | {bracket, expected, read, match}'
check 2 "the recorded application instance is the process now running (its pid, start time and executable), inside the unit's cgroup and not the launcher; each identity read's tree hash equals the sealed digest" \
  "awk '{print \$22}' /proc/$APP_PID/stat; sha256sum /proc/$APP_PID/exe; tr '\\0' ' ' < /proc/$APP_PID/cmdline; cat /proc/$APP_PID/cgroup"
pause

echo "the verification row:"
dbq "SELECT outcome, identity_reads, missing FROM deployment_verifications WHERE id = '$VER'" | awk -F'\t' '{print "   outcome " $1; print "   missing " $3}'
dbq "SELECT identity_reads FROM deployment_verifications WHERE id = '$VER'" | jq -c '.[] | {bracket, match, at, instance: .instance.pid}'
echo "the round's post-deploy check, run by the engine in its own check domain through the link:"
dbq "SELECT c.key, x.status, r.execution_established, r.exit_status, r.output FROM check_executions x JOIN checks c ON c.id = x.\"check\" LEFT JOIN check_results r ON r.execution = x.id WHERE x.environment = '$ENV_ID' ORDER BY x.execution_seq" | sed 's/^/   /'
OUT_REC=$(dbq "SELECT r.output FROM check_executions x JOIN check_results r ON r.execution = x.id WHERE x.environment = '$ENV_ID' ORDER BY x.execution_seq DESC LIMIT 1")
OUT_PATH=$(dbq "SELECT path FROM records WHERE id = '$OUT_REC'")
[ -n "$OUT_PATH" ] && grep -h '^REF-OPERATION ' "$SURETY_HOME/records/$OUT_PATH" | sed 's/^REF-OPERATION /   the service answered: /'
check 3 "the verification row verified, its first and second identity reads both match, and between them the post-deploy check 'operation' passed (GET /sum?a=2&b=3 answered {\"sum\": 5})" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/environments/alpha | jq '.environment.last_verified'"
pause

# ---------------------------------------------------------------------------------------
say "6. Your restart of your hands-on unit, by its exact name"
note "The containment read first, from the host: the unit carries this home's prefix and this home's store names it;"
note "the recorded application is in its cgroup and in none of the host's pid, network or mount namespaces."
read_prefix
printf '%s\n' "$OWN_UNITS" | grep -qxF -- "$UNIT" || die "$UNIT is not loaded under this home's prefix: nothing is printed for you to run"
intended_units | grep -qxF -- "$UNIT" || die "$UNIT is named in no attempt intent of this home's store: nothing is printed for you to run"
APP_CG=/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$APP_PID/cgroup" 2>/dev/null)
case $APP_CG in "$CG"|"$CG"/*) ;; *) die "the application $APP_PID is not in $UNIT's cgroup ($APP_CG): nothing is printed for you to run" ;; esac
grep -qx "$APP_PID" "$APP_CG/cgroup.procs" || die "the application $APP_PID is not listed in $APP_CG/cgroup.procs: nothing is printed for you to run"
for ns in pid net mnt; do
  [ "$(readlink "/proc/$APP_PID/ns/$ns")" != "$(readlink "/proc/self/ns/$ns")" ] || die "the application $APP_PID is in the host's $ns namespace: nothing is printed for you to run"
done
note "contained: $UNIT, application $APP_PID in $APP_CG, in namespaces of its own."
GRANTS_BEFORE=$(dbq "SELECT COUNT(*) FROM events WHERE type = 'deploy.launch_authorized' AND json_extract(subject, '\$.attempt') = '$ATT'")
INVOCATION=$(systemctl --user show -p InvocationID --value -- "$UNIT")
check 4 "after your restart the unit has a new invocation, but its launcher is refused (the launch is single-use: no second grant, no application), and the engine records the change out of band with a decision offering teardown and acknowledge" \
  "systemctl --user restart -- $UNIT"
printf '\n\033[1;33m   Now run that command yourself, in another terminal. This walkthrough never runs it.\033[0m\n'
note "It waits (up to 15 minutes) until the unit shows a new invocation."
for i in $(seq 1 450); do
  [ "$(systemctl --user show -p InvocationID --value -- "$UNIT" 2>/dev/null)" != "$INVOCATION" ] && break
  sleep 2
done
[ "$(systemctl --user show -p InvocationID --value -- "$UNIT" 2>/dev/null)" != "$INVOCATION" ] || die "no restart was seen within 15 minutes; the engine's teardown follows as the walkthrough ends"
systemctl --user show -p ActiveState -p SubState -p Result -p InvocationID -- "$UNIT" | sed 's/^/   after: /'
note "launch grants for the attempt: before $GRANTS_BEFORE, after $(dbq "SELECT COUNT(*) FROM events WHERE type = 'deploy.launch_authorized' AND json_extract(subject, '\$.attempt') = '$ATT'")"
note "the journal of the unit, by its exact name (the launcher's refusal, nothing of the application's output):"
journalctl --user -u "$UNIT" -o cat --no-pager 2>/dev/null | tail -n 8 | sed 's/^/     /'
note "The observation job reads the environment every 30 s; waiting for it to record the change (up to 4 minutes)."
OOB=$(until_db "$P" "SELECT id FROM out_of_band_changes WHERE environment = '$ENV_ID' AND disposition IS NULL AND closed_at IS NULL ORDER BY detected_at DESC LIMIT 1" 240 "the out-of-band record of your restart")
dbq "SELECT change, found FROM out_of_band_changes WHERE id = '$OOB'" | sed 's/^/   /'
DEC=$(dbq "SELECT decision FROM out_of_band_changes WHERE id = '$OOB'")
S "$API/v1/projects/$P/decisions" | jq -c '.decisions[] | select(.id == "'"$DEC"'") | {id, kind, options: [.options[].key]}'
pause

# ---------------------------------------------------------------------------------------
say "7. The environment read: three facts kept apart"
S "$API/v1/projects/$P/environments/alpha" | jq '.environment | {last_verified, attempted, observed, supervision, conditions}'
check 5 "the environment read keeps last_verified (the verification of step 5), attempted (the deploy's attempt and its outcome) and observed (what the last observation read, with its time) apart; your restart shows in observed and conditions, and last_verified is not changed by it" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/environments/alpha | jq '.environment | {last_verified, attempted, observed}'"
pause

# ---------------------------------------------------------------------------------------
say "8. Teardown: the decision answered teardown; nothing of the prefix left"
note "The engine's act: the prefix is read first."
act_answer "$P" "$DEC" teardown | jq -c '{status: .decision.status, option: .decision.answer.option}' 2>/dev/null || true
until_db "$P" "SELECT a.status FROM operations o JOIN operation_attempts a ON a.operation = o.id WHERE o.project = '$P' AND o.kind = 'teardown' AND o.finalized_at IS NOT NULL AND a.status IN ('succeeded', 'reconciled_succeeded') ORDER BY a.rowid DESC LIMIT 1" 300 "the teardown to be applied" >/dev/null
dbq "SELECT a.status, a.reconciliation_reads FROM operations o JOIN operation_attempts a ON a.operation = o.id WHERE o.project = '$P' AND o.kind = 'teardown' ORDER BY a.rowid DESC LIMIT 1" | awk -F'\t' '{print "   teardown attempt " $1}'
read_prefix
echo "units of the prefix loaded: ${OWN_UNITS:-none}"
echo "cgroups of the prefix: $(find /sys/fs/cgroup/user.slice -maxdepth 7 -type d -name "${PREFIX}*" 2>/dev/null | wc -l)"
echo "runtime files of alpha under $SURETY_HOME/run: $(find "$SURETY_HOME/run" -name "*$ENV_ID*" 2>/dev/null | wc -l)"
check 6 "the teardown applied, and no unit, cgroup, socket or directory carrying this home's prefix is left" \
  "systemctl --user list-units --all --no-legend --plain | grep -F $PREFIX; find /sys/fs/cgroup/user.slice -name '${PREFIX}*'; find $SURETY_HOME/run -name '*$ENV_ID*'    # each prints nothing"
pause

say "Done. Write down anything that surprised you: each is a decision for you or a failing test (M344)."
