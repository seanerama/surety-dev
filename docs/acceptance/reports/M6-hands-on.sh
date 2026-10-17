#!/usr/bin/env bash
# The M6 hands-on walkthrough (acceptance row M541; BS6 §13; E156 Q7: short,
# useful to Sean, not a second acceptance suite). Sean watches the engine
# take the design journey's reference project (Pantry: an API, a web page in
# html_css and an Android app in react_native, `design: both`) through its
# design, each step printed as "CHECK (x)" with the command he can run:
#   (a) seeing the preview: the design on his own hands-on unit through
#       `surety design preview` and `surety env open design-preview`, the web
#       mockup in his browser as it is, the android mockup only inside the
#       engine's labelled simulation frame;
#   (b) understanding a refusal: a Designer save whose design check is
#       refused, the reason (DESIGN_CONVENTION_UNDECLARED) and the engine's
#       entry naming its subject and target;
#   (c) approving the design: the batched approval (design_approval and its
#       spec_change) answered with the logo held, the effective asset set
#       showing the engine's placeholder for it;
#   (d) replacing a held asset: his own logo file by `surety design asset
#       add`, the asset-only approval raised by `surety design assets submit`,
#       and the `asset_updated` work its approval registers;
#   (e) observing teardown: a preview stopped by `surety design preview
#       --stop`, nothing of this home's prefix left, the home removed.
# The refusal of (b) is made by omitting one element from the Designer's
# package (POST /v1/harness/package-omit, SEAM §453): the fake then writes
# what the package no longer states, and the engine says what is missing,
# which is M537's point.
#
# NO MODEL, NO TOKEN, NOTHING PAID, NO BROWSER STARTED: every role is the
# harness's scripted role (the engine's test mode, `--harness
# --harness-scripted`). The Designer, the Spec Writer's change one-shot and
# the correction Verifier play the package-driven fakes
# (harness/standin/package-fakes.cjs) with the Designer's content
# (harness/design/packages46.mjs `designerContent`); the Spec Writer and
# Architect sessions, the Builders and the other Verifiers write the
# reference project's own products (harness/design/reference.mjs,
# harness/design/drive.mjs), as the kernel lane's design journey does. No
# backend binary is named or started. The check runner is qualified by the
# engine's own self-test at its start (`--harness-runner-self-test run`) and
# the preview's adapter by `surety qualify-adapter local_service` in this
# script's own home, never by a fixture. Nothing the Designer wrote is run
# by this script (BS6 §4.1 rule 21): the mockups are served to YOUR browser,
# which you open yourself; the script only prints the URL.
#
# SAFETY (BS6 §4.1 rules 1, 2, 7, 8, 15, 21 to 24; E64; SEAM §544). Read
# before changing anything here.
#   - This script never acts on a unit itself. Every unit is the engine's,
#     created, stopped and removed through its adapter, under a name derived
#     from this script's own disposable home: surety-<h>-env_<id>-g<n>.service.
#   - Every step that makes the engine act on a unit (the qualification, a
#     preview, its stop, a decision's answer, which may tear a preview down)
#     first reads the prefix (`read_prefix`): the units loaded under this
#     home's prefix, each by exact name and named in an attempt intent of
#     this home's store; anything else carrying the prefix stops the script
#     before the engine is asked to act.
#   - The relay is opened only by `surety env open design-preview` in this
#     home, bound to 127.0.0.1, and closed by `surety env close` before the
#     next step (rule 24).
#   - The host is otherwise only read. Nothing here stops, restarts, reloads,
#     re-executes or daemon-reloads the user manager; no sudo, loginctl or
#     Docker. The only process it signals is its own engine, at the end,
#     after reading from /proc that the pid is that engine.
#   - The engine home is at most 56 bytes (E134): the work directory is
#     ${TMPDIR:-/tmp}/surety-m6-ho-XXXXXX, refused if its home would be longer.
#
# Before running it:
#   - from a login session with the user manager running, with jq, curl,
#     git, node, systemctl and sha256sum; the machine otherwise quiet; no
#     `surety-*` unit loaded;
#   - `npm run build` in this checkout, on a revision with M6's engine.
#
# Usage:
#   bash docs/acceptance/reports/M6-hands-on.sh
# It pauses at each check and goes on when you press enter
# (SURETY_HANDS_ON_NO_PAUSE=1 goes straight on; it still needs a terminal).
# Everything it makes is under one temporary directory (SURETY_HANDS_ON_DIR,
# or a new one), printed at the start and REMOVED at the end unless KEEP=1,
# or unless anything of its prefix is still loaded, in which case it is kept
# and each leftover is printed by its exact name. About fifteen minutes.

set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "STOP: $*" >&2; exit 1; }

# Each check of M541, with the command Sean can run himself.
check() { # letter, what to look for, command
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
for tool in jq curl git node systemctl sha256sum; do command -v "$tool" >/dev/null || die "$tool is needed. Nothing was started."; done
[ "$(systemctl --user is-system-running 2>/dev/null || true)" = running ] || die "the user manager is not running (systemctl --user is-system-running). Nothing was started."
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$REPO/packages/engine/dist/cli.js
[ -f "$CLI" ] || die "not built: run 'npm run build' first. Nothing was started."
ACC=$REPO/packages/engine/test/acceptance
FAKES_SOURCE=$ACC/harness/standin/package-fakes.cjs
REFERENCE_SOURCE=$ACC/harness/design/reference.mjs
DRIVE_SOURCE=$ACC/harness/design/drive.mjs
CONTENT_SOURCE=$ACC/harness/design/packages46.mjs
SCRIPTED_SOURCE=$ACC/harness/scripted.mjs
SESSIONS_SOURCE=$ACC/harness/sessions.mjs
for f in "$FAKES_SOURCE" "$REFERENCE_SOURCE" "$DRIVE_SOURCE" "$CONTENT_SOURCE" "$SCRIPTED_SOURCE" "$SESSIONS_SOURCE"; do [ -f "$f" ] || die "$f is missing from this checkout. Nothing was started."; done
NODE=$(readlink -f "$(command -v node)")

# ---- the work directory, the home, the prefix ---------------------------------------------

if [ -n "${SURETY_HANDS_ON_DIR:-}" ]; then
  WORK=$SURETY_HANDS_ON_DIR
  # A directory that exists already is refused, never reused or removed.
  [ ! -e "$WORK" ] && [ ! -L "$WORK" ] || die "$WORK exists already; name a new SURETY_HANDS_ON_DIR. Nothing was started."
  mkdir -p "$WORK" && chmod 700 "$WORK"
else
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/surety-m6-ho-XXXXXX")
fi
MADE_WORK=1
case $WORK in "$REPO"/*) die "the work directory must be outside the repository. Nothing was started." ;; esac
SURETY_HOME=$WORK/home
[ "$(printf '%s' "$SURETY_HOME" | wc -c)" -le 56 ] || die "the engine home $SURETY_HOME is longer than 56 bytes (E134): set TMPDIR to a shorter directory. Nothing was started."
SCRIPTED=$WORK/scripted
PROJ_REPO=$WORK/repo
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts"
PREFIX="surety-$(printf '%s' "$SURETY_HOME" | sha256sum | cut -c1-12)-"
free_port() { "$NODE" -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'; }
PORT=$(free_port)
API=http://127.0.0.1:$PORT
ENGINE_PID=
P=
RELAY_OPEN=

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
# The omission set of the package seam (SEAM §453): a test-mode route, never a unit.
omit() { S -X POST "$API/v1/harness/package-omit" -d "{\"elements\": $1}" | jq -c '{omitted: .elements}'; }

# The harness's scripts for the scripted roles, written into this walkthrough's own
# scripted directory: `prepare` once, then a session's turns by its run, the Builders
# by their work items. Data only: the scripted role program reads them at each launch.
roles() { # action, args...
  "$NODE" --input-type=module -e '
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const [refSrc, driveSrc, contentSrc, scriptedSrc, sessionsSrc, dir, home, action, ...rest] = process.argv.slice(1);
    const imp = (p) => import(pathToFileURL(p).href);
    const ref = await imp(refSrc);
    const put = (name, value) => writeFileSync(join(dir, "scripts", `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    const FAKE = { steps: [{ package_fake: {} }] };
    const { turnThatWrites, turnThatSays } = await imp(sessionsSrc);
    if (action === "prepare") {
      const { Scripted } = await imp(scriptedSrc);
      const { designScripts } = await imp(driveSrc);
      const { designerContent } = await imp(contentSrc);
      const s = new Scripted(dir);
      designScripts({ scripted: s, home });
      s.packageFakes(designerContent({ name: ref.PROJECT_NAME }));
      // Which roles play the package-driven fakes (SEAM §455): the Designer (by its
      // run, below), the Spec Writer change one-shot of the batch and the correction
      // Verifier that authors the design criteria checks from its package.
      for (const kind of ["spec_change", "check_correction"]) put(`kind-${kind}`, FAKE);
      writeFileSync(join(dir, "..", "idea.md"), ref.IDEA_BRIEF);
    } else if (action === "spec") {
      put(`run-${rest[0]}`, [turnThatWrites({ ".surety/spec/spec.md": ref.SPEC }, { reply: "The specification of Pantry.", done: true })]);
    } else if (action === "architect") {
      put(`run-${rest[0]}`, [turnThatWrites(ref.architectFiles({ revision: rest[1] }), { reply: "Architecture, module map with surfaces, targets and shapes, one ADR, the roadmap and phase 1.", done: true })]);
    } else if (action === "designer") {
      put(`run-${rest[0]}`, [FAKE, FAKE, FAKE, turnThatSays("Closing the design.", { done: true })]);
    } else if (action === "builders") {
      const { builderScript, stageWork } = await imp(driveSrc);
      for (const n of [1, 2, 3]) {
        const w = stageWork(home, rest[0], n);
        if (w) put(w.id, [0, 1, 2].map(() => builderScript(n)));
      }
    } else throw new Error(`no such action ${action}`);
  ' "$REFERENCE_SOURCE" "$DRIVE_SOURCE" "$CONTENT_SOURCE" "$SCRIPTED_SOURCE" "$SESSIONS_SOURCE" "$SCRIPTED" "$SURETY_HOME" "$@" >> "$WORK/roles.log" 2>&1 || die "the scripted roles could not be written; see $WORK/roles.log"
}

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
act_preview() { # project, revision
  read_prefix
  SURETY_HOME="$SURETY_HOME" "$NODE" "$CLI" design preview --project "$1" --revision "$2"
}
act_preview_stop() { # project
  read_prefix
  SURETY_HOME="$SURETY_HOME" "$NODE" "$CLI" design preview --project "$1" --stop
}
act_answer() { # project, decision, option[, extra JSON fields]
  local hash extra=${4:-}
  [ -n "$extra" ] || extra='{}'
  read_prefix
  hash=$(dbq "SELECT preview_hash FROM decisions WHERE id = '$2'")
  S -X POST "$API/v1/projects/$1/decisions/$2/answer" -d "$(jq -n --arg o "$3" --arg h "$hash" --argjson x "$extra" '{option: $o, preview_hash: $h} + $x')"
}

# The routine decisions of the build (the toolchain, the checks' proposals, a
# plan), answered approve for you here and printed; in your own projects they are yours.
ROUTINE="'check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'"
answer_routine() { # project
  local d
  for d in $(dbq "SELECT id || ':' || kind FROM decisions WHERE project = '$1' AND status = 'open' AND kind IN ($ROUTINE) ORDER BY rowid"); do
    note "routine: ${d#*:} answered approve for you ($(act_answer "$1" "${d%%:*}" approve | jq -r '.decision.status' 2>/dev/null))"
  done
}
until_db() { # project, query, seconds, what
  local i v
  for i in $(seq 1 $(( $3 / 2 ))); do
    v=$(dbq "$2" | head -1)
    if [ -n "$v" ]; then echo "$v"; return 0; fi
    if [ -n "$1" ]; then answer_routine "$1" >&2; tick "$1"; fi
    sleep 2
  done
  die "timed out waiting for $4"
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
  if [ -n "$RELAY_OPEN" ] && own_engine; then surety env close design-preview --project "$P" >/dev/null 2>&1; fi
  left=$(units_of_prefix)
  if [ -n "$left" ] && [ -n "$P" ] && own_engine; then
    echo "Something of this home's prefix is still loaded; the engine is asked to stop its preview, after the prefix read:"
    ( act_preview_stop "$P" >/dev/null )
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

# ---- the scripted roles, the repository ----------------------------------------------------

roles prepare
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO"
printf '# Pantry\n' > "$PROJ_REPO/README.md"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'the repository Pantry starts from'
git -C "$PROJ_REPO" checkout -q --detach
printf '{"api_port": %s, "tick_interval": 600, "terminate_grace": 3, "kill_grace": 2}\n' "$PORT" > "$SURETY_HOME/config.json"

# ---------------------------------------------------------------------------------------
say "1. Start the engine: the host checks and the runner self-test run at its start"
( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE")" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}" \
    "$NODE" "$CLI" serve --harness --harness-scripted "$SCRIPTED" --harness-host-checks run --harness-runner-self-test run --harness-deploy-adapter real \
    >> "$WORK/engine.log" 2>&1 ) &
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
say "2. Pantry: its specification and architecture, approved; the UI stages held for the design"
P=$(S -X POST "$API/v1/projects" -d "$(jq -n --arg repo "$PROJ_REPO" --rawfile idea "$WORK/idea.md" '{name: "pantry", tier: "T2", dev_repo_path: $repo, integration_branch: "main", idea: $idea}')" | jq -r '.project.id')
[[ $P == proj_* ]] || die "no project"
until_db "" "SELECT id FROM projects WHERE id = '$P' AND registration_state = 'registered'" 30 "the project to be registered" >/dev/null
S -X POST "$API/v1/projects/$P/policy" -d '{"design": "both", "phase_size": {"min": 1, "max": 5}}' | jq -c '{revision: .revision}'
RUN=$(surety session open --project "$P" --role spec_writer | jq -r '.run.id')
roles spec "$RUN"
surety session say "$RUN" --project "$P" --text 'Write the specification of Pantry.' --wait-minutes 10 >/dev/null
surety session save "$RUN" --project "$P" | jq -c '{saved, revision}'
D=$(surety session close "$RUN" --project "$P" | jq -r '.decisions[] | select(.kind == "spec_approval") | .id')
act_answer "$P" "$D" approve | jq -c '{kind: .decision.kind, status: .decision.status}'
until_db "$P" "SELECT id FROM spec_revisions WHERE project = '$P' AND version = 1" 60 "the specification approved" >/dev/null
RUN=$(surety session open --project "$P" --role architect | jq -r '.run.id')
roles architect "$RUN" "$(git -C "$PROJ_REPO" rev-parse main)"
surety session say "$RUN" --project "$P" --text 'Design Pantry from the approved specification and plan phase 1.' --wait-minutes 10 >/dev/null
surety session save "$RUN" --project "$P" | jq -c '{saved, revision}'
for d in $(surety session close "$RUN" --project "$P" | jq -r '.decisions[].id'); do act_answer "$P" "$d" approve | jq -c '{kind: .decision.kind, status: .decision.status}'; done
until_db "$P" "SELECT id FROM phase_plans WHERE project = '$P' AND phase_number = 1 AND published_at IS NOT NULL" 120 "the plan to be published" >/dev/null
roles builders "$P"
until_db "$P" "SELECT id FROM projects WHERE id = '$P' AND design_inventory_digest IS NOT NULL" 120 "the interface inventory to be derived" >/dev/null
note "The engine derived the interface inventory, its fixtures and the placeholder assets, and raised design_due:"
S "$API/v1/projects/$P/design" | jq -c '{inventory: .inventory.inventory_digest, targets: [.inventory.targets[]? | {target, ui_technology, preview_capability}], design_due: .design_due}'

# ---------------------------------------------------------------------------------------
say "3. (a) Seeing the preview: the Designer's first checkpoint on your own hands-on unit"
QUAL=$(act_qualify) || { echo "$QUAL" | jq . 2>/dev/null || echo "$QUAL"; die "the adapter did not qualify"; }
echo "$QUAL" | jq -c '{qualified, adapter_version}'
DES=$(surety session open --project "$P" --role designer | jq -r '.run.id')
roles designer "$DES"
surety session say "$DES" --project "$P" --text 'Draw Pantry for the web and Android: one list, add an item.' --wait-minutes 10 | sed 's/^/   reply: /'
surety session save "$DES" --project "$P" | jq -c '{saved, revision, design_check: {outcome: .design_check.outcome}}'
PREVIEW=$(act_preview "$P" checkpoint)
echo "$PREVIEW" | jq -c '.preview'
URL=$(echo "$PREVIEW" | jq -r '.preview.url')
until_db "$P" "SELECT seq FROM events WHERE type = 'design.preview_deployed' AND json_extract(subject, '$.project') = '$P'" 300 "the preview to be deployed" >/dev/null
surety env open design-preview --project "$P" | jq -c '.'
RELAY_OPEN=1
note "The relay is open on 127.0.0.1 only. Open this in YOUR browser yourself (the script starts none): $URL"
note "The index lists each mockup with its target and capability. The web mockup is served as the Designer wrote it;"
note "the android mockup only inside the engine's frame, under its banner 'Simulation of android ...', in an iframe sandboxed allow-scripts."
check a "the index lists the web mockup (native) and the android mockup (simulated); the web mockup opens bare; the android one opens only inside the labelled simulation frame" \
  "curl -sS $URL | grep -o 'data-path=\"[^\"]*\" data-target=\"[^\"]*\" data-capability=\"[^\"]*\"'"
pause
surety env close design-preview --project "$P" | jq -c '.'
RELAY_OPEN=

# ---------------------------------------------------------------------------------------
say "4. (b) Understanding a refusal: the Designer's package without its conventions table"
note "The Designer's package is written without designer.conventions (SEAM §453); the fake draws screens with no"
note "platform conventions, because nothing tells it which; the design check refuses the save and says what and where."
omit '["designer.conventions"]'
surety session say "$DES" --project "$P" --text 'Draw it again, from what the engine gave you.' --wait-minutes 10 | sed 's/^/   reply: /'
surety session save "$DES" --project "$P" | jq -c '{saved, revision, design_check: {outcome: .design_check.outcome, reasons: [.design_check.reasons[]? | {code, subjects}] | .[0:4]}}'
omit '[]'
echo "the engine's entry on the next turn:"
surety session show "$DES" --project "$P" | jq -c '.transcript[] | select(.speaker == "engine") | {turn, text: (.text | .[0:200])}' | tail -2 | sed 's/^/   /'
check b "the save's design check is refused: DESIGN_CONVENTION_UNDECLARED, each naming its target, screen and convention; the engine's entry tells the Designer so; nothing was approved" \
  "SURETY_HOME=$SURETY_HOME node $CLI session show $DES --project $P | jq '.transcript[] | select(.speaker == \"engine\")'"
pause

# ---------------------------------------------------------------------------------------
say "5. (c) Approving the design: the batch answered, the logo held"
surety session say "$DES" --project "$P" --text 'Fix what the engine reported.' --wait-minutes 10 | sed 's/^/   reply: /'
surety session save "$DES" --project "$P" | jq -c '{saved, revision, design_check: {outcome: .design_check.outcome}}'
surety session close "$DES" --project "$P" | jq -c '{decisions: [.decisions[]? | .kind]}'
APPROVAL=$(until_db "$P" "SELECT id FROM decisions WHERE project = '$P' AND kind = 'design_approval' AND status = 'open' AND batch_key IS NOT NULL AND batch_key IN (SELECT batch_key FROM decisions WHERE project = '$P' AND kind = 'spec_change' AND status = 'open')" 600 "the batched design_approval and spec_change")
CHANGE=$(dbq "SELECT id FROM decisions WHERE project = '$P' AND kind = 'spec_change' AND status = 'open' AND batch_key = (SELECT batch_key FROM decisions WHERE id = '$APPROVAL')")
S "$API/v1/projects/$P/decisions" | jq -c '.decisions[] | select(.id == "'"$APPROVAL"'") | {kind, batch_key, options: [.options[] | .key], mockups: [.evidence.mockups[]? | {path, target, preview_capability}]}'
act_answer "$P" "$APPROVAL" approve '{"assets_held": ["logo"]}' | jq -c '{kind: .decision.kind, status: .decision.status}'
act_answer "$P" "$CHANGE" approve | jq -c '{kind: .decision.kind, status: .decision.status}'
until_db "$P" "SELECT id FROM design_revisions WHERE project = '$P' AND status = 'approved'" 120 "the design to be approved" >/dev/null
echo "the effective asset set (what surety design show reads, GET …/design):"
dbq "SELECT slot || '/' || variant || ' ' || slot || '@' || slot_version || ' ' || source FROM design_effective_assets WHERE project = '$P' ORDER BY slot, variant" | sed 's/^/   /'
check c "the design approved with its spec change in one sitting; the logo held: every logo variant in the effective set is the engine's placeholder, never the Designer's held proposal" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/design | jq '.effective_assets // .'"
pause

# ---------------------------------------------------------------------------------------
say "6. (d) Replacing the held logo with your own file"
note "The UI stages build with the placeholder first (the design's criteria checks authored, readiness, the Builders' bindings)."
until_db "$P" "SELECT s.id FROM stages s JOIN phase_plans p ON p.id = s.phase_plan WHERE p.project = '$P' AND s.number = 2 AND s.status IN ('integrated', 'verified')" 1800 "the web UI stage to integrate" >/dev/null
until_db "$P" "SELECT s.id FROM stages s JOIN phase_plans p ON p.id = s.phase_plan WHERE p.project = '$P' AND s.number = 3 AND s.status IN ('integrated', 'verified')" 1800 "the android UI stage to integrate" >/dev/null
echo "the bindings the Builders declared:"
dbq "SELECT target || ' ' || slot || '/' || variant || ' -> ' || path || ' (' || form || ', ' || slot || '@' || source_slot_version || ')' FROM asset_bindings WHERE project = '$P' ORDER BY rowid" | sed 's/^/   /'
# Your own logo: an SVG this script writes (a text file with a valid root and no script; never a real image).
LOGO=$WORK/my-logo.svg
printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><rect width="240" height="80" fill="#14532d"/><text x="120" y="50" font-family="sans-serif" font-size="32" fill="#ffffff" text-anchor="middle">Pantry</text></svg>' > "$LOGO"
surety design asset add --project "$P" logo full "$LOGO" | jq -c '.'
surety design assets submit --project "$P" | jq -c '.'
ASSETS=$(until_db "$P" "SELECT d.id FROM decisions d JOIN design_revisions r ON r.id = d.subject_id WHERE d.project = '$P' AND d.kind = 'design_approval' AND d.status = 'open' AND r.scope = 'asset_only'" 120 "the asset-only design_approval")
act_answer "$P" "$ASSETS" approve | jq -c '{kind: .decision.kind, status: .decision.status}'
FIX=$(until_db "$P" "SELECT id FROM work_items WHERE project = '$P' AND kind = 'fix' AND json_extract(subject, '$.cause') = 'asset_updated'" 120 "the asset_updated work")
dbq "SELECT subject FROM work_items WHERE id = '$FIX'" | jq -c '{cause, slot, from_version, to_version, bindings}'
check d "your file validated and committed as a proposal; the asset-only approval (no spec change) moved the logo's effective version; one asset_updated fix names every bound path of the logo" \
  "curl -sS -H \"X-Surety-Token: \$(cat $SURETY_HOME/api.token)\" $API/v1/projects/$P/design/bindings | jq ."
pause

# ---------------------------------------------------------------------------------------
say "7. (e) Observing teardown"
note "The approvals tore the checkpoint's preview down (a newer approved design). A preview of the approved design, then --stop:"
act_preview "$P" approved | jq -c '.preview'
until_db "$P" "SELECT seq FROM events WHERE type = 'design.preview_deployed' AND json_extract(subject, '$.project') = '$P' ORDER BY seq DESC LIMIT 1 OFFSET 1" 300 "the second preview to be deployed" >/dev/null
read_prefix
act_preview_stop "$P" | jq -c '.'
until_db "$P" "SELECT seq FROM events WHERE type = 'design.preview_torn_down' AND json_extract(subject, '$.project') = '$P' AND json_extract(payload, '$.reason') = 'stop'" 300 "the preview's teardown" >/dev/null
dbq "SELECT type || ' ' || json_extract(payload, '$.reason') FROM events WHERE type = 'design.preview_torn_down' AND json_extract(subject, '$.project') = '$P' ORDER BY seq" | sed 's/^/   /'
read_prefix
echo "units of the prefix loaded: ${OWN_UNITS:-none}"
check e "each preview torn down by rule (approved, then stop); no unit of this home's prefix loaded; at the end the engine stops and the work directory is removed" \
  "systemctl --user list-units --all --no-legend --plain | grep -F $PREFIX; find /sys/fs/cgroup/user.slice -name '${PREFIX}*'    # each prints nothing"
pause

say "Done. Write down anything that surprised you: each is a decision for you or a failing test (M541)."
