#!/usr/bin/env bash
# The M5 hands-on walkthrough (acceptance row M446; BS5 §13 and §16 question
# 5, decided E141 item 4): Sean watches the engine take a small project from
# an idea through its sessions, its specification, its plan and its first
# phase, with every role played by the package-driven rehearsal fakes, so he
# sees for himself, each printed as "CHECK (n)" with the command he can run:
#   (1) a specification save with a defect the engine names, and the
#       approval's `approve` option blocked by it;
#   (2) a session opened, two turns with their ledger rows and the
#       transcript record, and a save's checkpoint commit;
#   (3) a plan refused for a named reason, then registered with its stages
#       and their `depends_on`;
#   (4) the stage work dispatched under `autonomy: phase` with no decision of
#       his but the toolchain's;
#   (5) the pace read, with `unknown` where a figure has no row;
#   (6) if he asks for it (SURETY_HANDS_ON_ALPHA=1), the Alpha of the
#       candidate on his hands-on unit, and a teardown leaving nothing of the
#       prefix.
# The defect of (1) and the refusal of (3) are made by omitting one element
# from the role's package (POST /v1/harness/package-omit, SEAM §453): the
# fake then writes what the package no longer states, and the engine says
# what is missing, which is M442's point.
#
# NO MODEL, NO TOKEN, NOTHING PAID: every role is the harness's scripted role
# playing the package-driven fake (harness/standin/package-fakes.cjs; the
# engine's test mode, `--harness --harness-scripted`); no backend binary is
# named or started. The check runner is qualified by the engine's own
# self-test at its start (`--harness-runner-self-test run`) and, for (6), the
# adapter by `surety qualify-adapter local_service` in this script's own
# home, never by a fixture. The project is M401's Tally (SEAM §342), its
# owner's words from harness/real/rehearsal-content.mjs.
#
# SAFETY (BS5 §4.1 rules 1, 2, 7, 8, 15; E64; SEAM §457). Read before
# changing anything here.
#   - This script never acts on a unit itself. Every unit is the engine's,
#     created, stopped and removed through its adapter, under a name derived
#     from this script's own disposable home: surety-<h>-env_<id>-g<n>.service.
#   - Every step that makes the engine act on a unit (the qualification, the
#     deployment request, a decision's answer, a teardown) first reads the
#     prefix (`read_prefix`): the units loaded under this home's prefix, each
#     by exact name and named in an attempt intent of this home's store;
#     anything else carrying the prefix stops the script before the engine is
#     asked to act.
#   - The host is otherwise only read. Nothing here stops, restarts, reloads,
#     re-executes or daemon-reloads the user manager; no sudo, loginctl or
#     Docker. The only process it signals is its own engine, at the end,
#     after reading from /proc that the pid is that engine.
#   - The engine home is at most 56 bytes (E134): the work directory is
#     ${TMPDIR:-/tmp}/surety-m5-ho-XXXXXX, refused if its home would be longer.
#
# Before running it:
#   - from a login session with the user manager running, with jq, curl,
#     git, node, systemctl and journalctl; the machine otherwise quiet (BS5
#     §4.1 rule 12); no `surety-*` unit loaded;
#   - `npm run build` in this checkout, on a revision with M5's engine.
#
# Usage:
#   bash docs/acceptance/reports/M5-hands-on.sh
#   SURETY_HANDS_ON_ALPHA=1 bash docs/acceptance/reports/M5-hands-on.sh   # with (6)
# It pauses at each check and goes on when you press enter
# (SURETY_HANDS_ON_NO_PAUSE=1 goes straight on; it still needs a terminal).
# Everything it makes is under one temporary directory (SURETY_HANDS_ON_DIR,
# or a new one), printed at the start and REMOVED at the end unless KEEP=1,
# or unless anything of its prefix is still loaded, in which case it is kept
# and each leftover is printed by its exact name. About twenty minutes (the
# host checks, the self-test, each check in its own domain).

set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "STOP: $*" >&2; exit 1; }

# Each check of M446, with the command Sean can run himself.
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
[ -t 0 ] || die "run this from your terminal: it pauses at each check, and SURETY_HANDS_ON_NO_PAUSE=1 skips the pauses but not this. Nothing was started."
for tool in jq curl git node systemctl journalctl sha256sum; do command -v "$tool" >/dev/null || die "$tool is needed. Nothing was started."; done
[ "$(systemctl --user is-system-running 2>/dev/null || true)" = running ] || die "the user manager is not running (systemctl --user is-system-running). Nothing was started."
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$REPO/packages/engine/dist/cli.js
[ -f "$CLI" ] || die "not built: run 'npm run build' first. Nothing was started."
ACC=$REPO/packages/engine/test/acceptance
CHILD_SOURCE=$ACC/harness/scripted/child.mjs
FAKES_SOURCE=$ACC/harness/standin/package-fakes.cjs
CONTENT_SOURCE=$ACC/harness/real/rehearsal-content.mjs
REFERENCE_SOURCE=$ACC/harness/journey/reference.mjs
for f in "$CHILD_SOURCE" "$FAKES_SOURCE" "$CONTENT_SOURCE" "$REFERENCE_SOURCE"; do [ -f "$f" ] || die "$f is missing from this checkout. Nothing was started."; done
NODE=$(readlink -f "$(command -v node)")

# ---- the work directory, the home, the prefix ---------------------------------------------

if [ -n "${SURETY_HANDS_ON_DIR:-}" ]; then
  WORK=$SURETY_HANDS_ON_DIR
  # A directory that exists already is refused, never reused or removed.
  [ ! -e "$WORK" ] && [ ! -L "$WORK" ] || die "$WORK exists already; name a new SURETY_HANDS_ON_DIR. Nothing was started."
  mkdir -p "$WORK" && chmod 700 "$WORK"
else
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/surety-m5-ho-XXXXXX")
fi
MADE_WORK=1
case $WORK in "$REPO"/*) die "the work directory must be outside the repository. Nothing was started." ;; esac
SURETY_HOME=$WORK/home
[ "$(printf '%s' "$SURETY_HOME" | wc -c)" -le 56 ] || die "the engine home $SURETY_HOME is longer than 56 bytes (E134): set TMPDIR to a shorter directory. Nothing was started."
SCRIPTED=$WORK/scripted
PROJ_REPO=$WORK/repo
SECRETS=$WORK/secrets
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts" "$SECRETS"
chmod 700 "$SECRETS"
PREFIX="surety-$(printf '%s' "$SURETY_HOME" | sha256sum | cut -c1-12)-"
free_port() { "$NODE" -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'; }
PORT=$(free_port)
API=http://127.0.0.1:$PORT
ENGINE_PID=
P=
ENV_ID=

S() { curl -sS -H "X-Surety-Token: $(cat "$SURETY_HOME/api.token")" -H 'Content-Type: application/json' "$@"; }
surety() { SURETY_HOME="$SURETY_HOME" "$NODE" "$CLI" "$@"; }
dbq() {
  "$NODE" -e '
    const r = require("module").createRequire(process.argv[1] + "/packages/engine/package.json");
    const D = r("better-sqlite3");
    const db = new D(process.argv[2] + "/store.db", { readonly: true, fileMustExist: true });
    for (const row of db.prepare(process.argv[3]).all()) console.log(Object.values(row).map((v) => (v === null ? "" : String(v))).join("\t"));
  ' "$REPO" "$SURETY_HOME" "$1"
}
tick() { S -X POST "$API/v1/projects/$1/tick" -d '{}' >/dev/null; }
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
# The omission set of the package seam (SEAM §453): a test-mode route, never a unit.
omit() { S -X POST "$API/v1/harness/package-omit" -d "{\"elements\": $1}" | jq -c '{omitted: .elements}'; }

# ---- reading the prefix: before every act of the engine on a unit ---------------------------

units_of_prefix() {
  systemctl --user list-units --all --no-legend --plain --no-pager --full | awk '{print $1}' | grep -F -- "$PREFIX" | grep -E "^${PREFIX}env_[0-9A-HJKMNP-TV-Z]{26}-g[1-9][0-9]*\.service$" || true
}
intended_units() {
  [ -f "$SURETY_HOME/store.db" ] || return 0
  dbq "SELECT create_units FROM attempt_intents" | jq -r '.[]' 2>/dev/null || true
}
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

# ---- the end ------------------------------------------------------------------------------

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

# ---- the secret, the scripted roles (the package-driven fakes), the repository, the words ----

umask 077
"$NODE" -e 'process.stdout.write("surety-m5-hands-on-" + require("crypto").randomBytes(18).toString("hex"))' > "$SECRETS/ref_secret"
umask 022
cp "$CHILD_SOURCE" "$FAKES_SOURCE" "$SCRIPTED/"
# Every role, every turn: the package-driven fake (SEAM §455).
FAKE='{"steps": [{"package_fake": {}}]}'
printf '%s\n' "$FAKE" > "$SCRIPTED/scripts/default.json"
for kind in check_authoring check_correction stage_build verification review phase_verification replan spec_change fix; do printf '%s\n' "$FAKE" > "$SCRIPTED/scripts/kind-$kind.json"; done
"$NODE" --input-type=module -e '
  import { writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const [content, reference, scripted, out] = process.argv.slice(1);
  const c = await import(pathToFileURL(content).href);
  const r = await import(pathToFileURL(reference).href);
  writeFileSync(join(scripted, "rehearsal-content.json"), JSON.stringify(c.tallyContent()));
  writeFileSync(join(out, "idea.md"), r.IDEA_BRIEF);
  writeFileSync(join(out, "spec-defect.md"), c.ownerSays("Write the specification from this.", "rehearsal-owner", c.tallyBrief({ variant: true })));
  writeFileSync(join(out, "spec.md"), c.ownerSays("Write the specification from this.", "rehearsal-owner", c.tallyBrief()));
  writeFileSync(join(out, "architecture.md"), c.ownerSays("Design it and plan phase 1.", "rehearsal-architecture", c.TALLY_ARCHITECTURE));
' "$CONTENT_SOURCE" "$REFERENCE_SOURCE" "$SCRIPTED" "$WORK"
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO"
printf '# Tally\n' > "$PROJ_REPO/README.md"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'the repository Tally starts from'
git -C "$PROJ_REPO" checkout -q --detach
printf '{"api_port": %s, "tick_interval": 600, "terminate_grace": 3, "kill_grace": 2}\n' "$PORT" > "$SURETY_HOME/config.json"

# ---------------------------------------------------------------------------------------
say "1. Start the engine: the host checks and the runner self-test run at its start"
note "The test mode with the scripted roles playing the package-driven fakes, the real check runner and the real adapter."
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

# ---------------------------------------------------------------------------------------
say "2. The project, created with its idea; autonomy phase, Alpha by your command"
P=$(S -X POST "$API/v1/projects" -d "$(jq -n --arg repo "$PROJ_REPO" --rawfile idea "$WORK/idea.md" '{name: "m5-hands-on", tier: "T2", dev_repo_path: $repo, integration_branch: "main", idea: $idea}')" | jq -r '.project.id')
[[ $P == proj_* ]] || die "no project"
until_db "$P" "SELECT id FROM projects WHERE id = '$P' AND registration_state = 'registered'" 30 "the project to be registered" >/dev/null
S -X POST "$API/v1/projects/$P/policy" -d '{"phase_size": {"min": 1, "max": 5}}' | jq -c '{revision: .revision}'

# ---------------------------------------------------------------------------------------
say "3. A specification the engine finds a defect in: the package without its marks"
note "The Spec Writer's package is written without spec_writer.marks (SEAM §453); the fake writes the human-test"
note "requirement R5 with no mark, because nothing tells it how; the engine reads the save and names the defect."
omit '["spec_writer.marks"]'
RUN_A=$(surety session open --project "$P" --role spec_writer | jq -r '.run.id')
surety session say "$RUN_A" --project "$P" --file "$WORK/spec-defect.md" --wait-minutes 10 | sed 's/^/   reply: /'
surety session save "$RUN_A" --project "$P" | jq -c '{saved, revision, findings: [.findings[] | {code, subject}]}'
omit '[]'
CLOSED=$(surety session close "$RUN_A" --project "$P")
APPROVAL_A=$(echo "$CLOSED" | jq -r '.decisions[] | select(.kind == "spec_approval") | .id')
S "$API/v1/projects/$P/decisions" | jq -c '.decisions[] | select(.id == "'"$APPROVAL_A"'") | {kind, options: [.options[] | {key, blockers}]}'
check 1 "the save names the defect (spec_requirement_uncertain for R5: no criterion and no mark), and the approval's approve option is blocked by it" \
  "surety session show $RUN_A --project $P | jq .findings; curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/decisions | jq '.decisions[] | select(.kind == \"spec_approval\") | .options'"
pause
act_answer "$P" "$APPROVAL_A" reject | jq -c '{status: .decision.status, option: .decision.answer.option}' 2>/dev/null || true

# ---------------------------------------------------------------------------------------
say "4. A session of two turns, metered and recorded; a save's checkpoint commit"
RUN_B=$(surety session open --project "$P" --role spec_writer | jq -r '.run.id')
surety session say "$RUN_B" --project "$P" --file "$WORK/spec.md" --wait-minutes 10 | sed 's/^/   reply: /'
surety session say "$RUN_B" --project "$P" --text 'Check it once more against what I said.' --wait-minutes 10 | sed 's/^/   reply: /'
SAVED=$(surety session save "$RUN_B" --project "$P")
echo "$SAVED" | jq -c '{saved, revision, findings}'
REV=$(echo "$SAVED" | jq -r '.revision')
echo "the turns and their ledger rows:"
dbq "SELECT t.number, t.settled_at, l.id, l.model_requested, l.usage_complete FROM turns t LEFT JOIN ledger_rows l ON l.run = t.run AND l.invocation = t.invocation WHERE t.run = '$RUN_B' ORDER BY t.number" | sed 's/^/   /'
echo "the transcript record:"
surety session show "$RUN_B" --project "$P" | jq -c '.transcript[] | {turn, speaker, text: (.text | .[0:80])}'
echo "the save's checkpoint commit:"
git -C "$PROJ_REPO" log --oneline -3 main | sed 's/^/   /'
check 2 "a session run with two turns, each settled with a ledger row of its own; the transcript with the owner's, the role's and the engine's entries; the save a checkpoint commit on the integration branch" \
  "surety session show $RUN_B --project $P | jq '{turns, transcript}'; git -C $PROJ_REPO show --stat $REV"
pause
CLOSED=$(surety session close "$RUN_B" --project "$P")
APPROVAL_B=$(echo "$CLOSED" | jq -r '.decisions[] | select(.kind == "spec_approval") | .id')
act_answer "$P" "$APPROVAL_B" approve | jq -c '{status: .decision.status, option: .decision.answer.option}'
until_db "$P" "SELECT id FROM spec_revisions WHERE project = '$P' AND version = 1" 30 "the specification approved" >/dev/null

# ---------------------------------------------------------------------------------------
say "5. A plan refused for a named reason (the package without its plan reasons), then registered"
omit '["architect.plan_reasons"]'
RUN_C=$(surety session open --project "$P" --role architect | jq -r '.run.id')
surety session say "$RUN_C" --project "$P" --file "$WORK/architecture.md" --wait-minutes 10 | sed 's/^/   reply: /'
surety session save "$RUN_C" --project "$P" | jq -c '{saved, revision}'
surety session close "$RUN_C" --project "$P" 2>&1 | sed 's/^/   close: /' || true
omit '[]'
surety session close "$RUN_C" --project "$P" --refuse | jq -c '{run: .run.id, decisions}'
RUN_D=$(surety session open --project "$P" --role architect | jq -r '.run.id')
surety session say "$RUN_D" --project "$P" --file "$WORK/architecture.md" --wait-minutes 10 | sed 's/^/   reply: /'
surety session save "$RUN_D" --project "$P" | jq -c '{saved, revision}'
CLOSED=$(surety session close "$RUN_D" --project "$P")
for d in $(echo "$CLOSED" | jq -r '.decisions[].id'); do act_answer "$P" "$d" approve | jq -c '{status: .decision.status, kind: .decision.kind}'; done
until_db "$P" "SELECT id FROM phase_plans WHERE project = '$P' AND phase_number = 1 AND published_at IS NOT NULL" 60 "the plan to be published" >/dev/null
echo "the stages registered, with their depends_on:"
S "$API/v1/projects/$P/plan" | jq -c '.plan.stages[] | {number, goal, status, depends_on, implements}'
check 3 "the first close refused 422 plan_refused naming PLAN_KIND_MISSING (the stages validate no kind: the package said none); the second registered phase 1 with its stages, stage 2 depending on stage 1" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/plan | jq '{checks: [.checks[] | {outcome, reasons}], stages: [.plan.stages[] | {number, depends_on}]}'"
pause

# ---------------------------------------------------------------------------------------
say "6. The stage work under autonomy phase: dispatched with no decision but the toolchain's"
note "The phase's check authoring runs first; its first proposal names the toolchain, which is yours to approve (Q9)."
TOOL=$(until_db "$P" "SELECT id FROM decisions WHERE project = '$P' AND kind = 'check_correction_unclassifiable' AND status = 'open'" 600 "the toolchain proposal")
act_answer "$P" "$TOOL" approve | jq -c '{status: .decision.status, kind: .decision.kind}'
until_db "$P" "SELECT s.id FROM stages s JOIN phase_plans p ON p.id = s.phase_plan WHERE p.project = '$P' AND s.number = 2 AND s.status IN ('integrated', 'verified')" 1800 "stage 2 to integrate" >/dev/null
echo "the runs the engine dispatched, in order:"
dbq "SELECT r.role, w.kind, r.outcome, r.reason_class FROM runs r LEFT JOIN work_items w ON w.id = r.work_item WHERE r.project = '$P' AND r.kind <> 'session' ORDER BY r.seq" | sed 's/^/   /'
echo "the decisions open now: $(dbq "SELECT COUNT(*) FROM decisions WHERE project = '$P' AND status = 'open'")"
check 4 "after the toolchain, every role ran as its work became eligible (authoring, Builders, Verifiers, Reviewers), and no decision was raised for any of it" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/decisions | jq '[.decisions[] | select(.status == \"open\")]'"
pause

# ---------------------------------------------------------------------------------------
say "7. The pace read: every figure from the row it declares, unknown where there is none"
surety pace --project "$P" | sed 's/^/   /' | head -60
echo "the figures that are unknown, with why:"
surety pace --project "$P" --json | jq -c 'paths(objects and has("unknown")) as $p | {path: ($p | map(tostring) | join(".")), unknown: getpath($p).unknown}' | head -20 | sed 's/^/   /'
check 5 "the pace read answers every figure from a recorded observation, and says unknown, with the reason, where no row records one (never 0)" \
  "SURETY_HOME=$SURETY_HOME node $CLI pace --project $P --json | jq ."
pause

# ---------------------------------------------------------------------------------------
if [ "${SURETY_HANDS_ON_ALPHA:-}" = 1 ]; then
  say "8. Alpha on your hands-on unit, and its teardown"
  QUAL=$(act_qualify) || { echo "$QUAL" | jq . 2>/dev/null || echo "$QUAL"; die "the adapter did not qualify"; }
  echo "$QUAL" | jq -c '{qualified, adapter_version}'
  ADAPTER_VERSION=$(echo "$QUAL" | jq -r '.adapter_version')
  NODE_SHA=$(sha256sum "$NODE" | cut -d' ' -f1)
  SERVICE_PORT=$(free_port)
  CONFIG=$(jq -n --arg v "$ADAPTER_VERSION" --arg node "$NODE" --arg sha "$NODE_SHA" --argjson port "$SERVICE_PORT" \
    '{adapter: "local_service", adapter_version: $v, targets: ["app"], runtime: {path: $node, sha256: $sha}, start: [$node, "server.mjs"], port: $port, env: {}, secrets: {REF_SECRET: "deploy/ref_secret"}, check_secrets: [], egress: [], artifact: {exclude: []}, identity_method: "tree_digest"}')
  S -X PUT "$API/v1/projects/$P/environments/alpha/config" -d "$CONFIG" | jq -c '{environment: .environment.id, config: .config.id}'
  ENV_ID=$(dbq "SELECT id FROM environments WHERE project = '$P' AND name = 'alpha' LIMIT 1")
  C=$(dbq "SELECT id FROM candidates WHERE project = '$P' ORDER BY seq DESC LIMIT 1")
  act_deploy "$P" "$C" | jq -c '{authorization: .authorization.status, work_item: .work_item.id}'
  until_db "$P" "SELECT id FROM candidates WHERE id = '$C' AND progress = 'alpha_deployed'" 600 "the candidate to be alpha_deployed" >/dev/null
  read_prefix
  for u in $OWN_UNITS; do systemctl --user show -p LoadState -p ActiveState -p MainPID -p ControlGroup -- "$u" | sed 's/^/   /'; done
  act_teardown "$P" false | jq -c '{status: .operation.status}' 2>/dev/null || true
  until_db "$P" "SELECT a.status FROM operations o JOIN operation_attempts a ON a.operation = o.id WHERE o.project = '$P' AND o.kind = 'teardown' AND o.finalized_at IS NOT NULL AND a.status IN ('succeeded', 'reconciled_succeeded') ORDER BY a.rowid DESC LIMIT 1" 300 "the teardown to be applied" >/dev/null
  read_prefix
  echo "units of the prefix loaded: ${OWN_UNITS:-none}"
  check 6 "the candidate alpha_deployed on a unit of this home's prefix, verified; then the teardown applied, and no unit, cgroup or runtime file of the prefix left" \
    "systemctl --user list-units --all --no-legend --plain | grep -F $PREFIX; find /sys/fs/cgroup/user.slice -name '${PREFIX}*'; find $SURETY_HOME/run -name '*$ENV_ID*'    # each prints nothing"
  pause
else
  note "(6) skipped: SURETY_HANDS_ON_ALPHA=1 adds the Alpha of the candidate on your hands-on unit and its teardown."
fi

say "Done. Write down anything that surprised you: each is a decision for you or a failing test (M446)."
