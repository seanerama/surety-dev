#!/usr/bin/env bash
# The M1 hands-on walkthrough: the kernel journey of acceptance row M01, made
# by hand against a running engine with curl. Every step is one the journey
# test (packages/engine/test/acceptance/harness/journey.mjs) makes; nothing
# here is new. Each step prints what it ran and what came back, and stops at
# the first answer that is not the expected one.
#
# Usage, from a checkout of the repository that has been built:
#   bash docs/acceptance/reports/M1-hands-on.sh
# Everything it makes is under one temporary directory, printed at the start
# and removed at the end unless KEEP=1 is set.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CLI=$REPO/packages/engine/dist/cli.js
[ -f "$CLI" ] || { echo "not built: run 'npm run build' first"; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/surety-hands-on-XXXXXX")
SURETY_HOME=$WORK/home
SCRIPTED=$WORK/scripted
PROJ_REPO=$WORK/repo
PORT=${PORT:-7301}
API=http://127.0.0.1:$PORT
ENGINE_PID=

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run()  { printf '\033[2m$ %s\033[0m\n' "$*"; "$@"; }
die()  { echo "STOP: $*" >&2; exit 1; }
# One request with the two headers the API needs: the Host header, which curl
# sends by itself, and the token from the engine home (SEAM.md section 6).
S() { curl -sS -H "X-Surety-Token: $(cat "$SURETY_HOME/api.token")" -H 'Content-Type: application/json' "$@"; }
# Wait, up to 60 s, until a jq filter over a read is true.
until_read() { # path filter what
  local i
  for i in $(seq 1 300); do
    if S "$API$1" | jq -e "$2" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  die "timed out waiting for $3"
}
# The stored events (one replay page of the event stream), as JSON lines.
events() { S "$API/v1/events?since=0&limit=100000" | sed -n 's/^data: //p'; }
tick() { run S -X POST "$API/v1/projects/$P/tick" -d '{}'; echo; sleep 1; }

cleanup() {
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then kill -TERM "$ENGINE_PID" 2>/dev/null || true; wait "$ENGINE_PID" 2>/dev/null || true; fi
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

say "1. A fresh engine home, a scripted-role directory and a disposable repository under $WORK"
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts" "$SCRIPTED/release"
# The engine's configuration: the port, ticks only when asked for (the
# longest interval allowed), and short grace periods when a role is ended.
cat > "$SURETY_HOME/config.json" <<EOF
{"api_port": $PORT, "tick_interval": 600, "terminate_grace": 2, "kill_grace": 1}
EOF
# The scripted role: the harness's program, and the script every role follows
# unless it has one of its own (the Verifier here): change nothing, report completion.
cp "$REPO/packages/engine/test/acceptance/harness/scripted/child.mjs" "$SCRIPTED/"
cat > "$SCRIPTED/scripts/default.json" <<'EOF'
{"steps": [{"result": {"status": "completed", "summary": "scripted role finished"}}]}
EOF
# The repository: one commit holding the protected checks, with the
# integration branch checked out nowhere (the developer's checkout is detached).
export GIT_AUTHOR_NAME='Surety Fixture' GIT_AUTHOR_EMAIL='fixture@surety.invalid' GIT_COMMITTER_NAME='Surety Fixture' GIT_COMMITTER_EMAIL='fixture@surety.invalid'
git init -q -b main "$PROJ_REPO"
mkdir -p "$PROJ_REPO/.surety/checks"
printf '# hands-on\n' > "$PROJ_REPO/README.md"
printf '{"protected_paths": [".surety/checks/"], "required_checks": ["login"]}\n' > "$PROJ_REPO/.surety/checks/protected-policy.json"
printf '{"expect": 200}\n' > "$PROJ_REPO/.surety/checks/login.check.json"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'fixture: initial commit'
git -C "$PROJ_REPO" checkout -q --detach
run git -C "$PROJ_REPO" log --oneline main

say "2. Start the engine in harness mode with the scripted backend"
( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="$PATH" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
    node "$CLI" serve --harness --harness-scripted "$SCRIPTED" > "$WORK/engine.log" 2>&1 ) &
ENGINE_PID=$!
for i in $(seq 1 100); do [ -f "$SURETY_HOME/api.token" ] && break; sleep 0.2; done
[ -f "$SURETY_HOME/api.token" ] || die "no api.token after 20 s; see $WORK/engine.log"
until_read /v1/health '.mode == "full"' 'the engine to reach full mode'
run S "$API/v1/health"; echo
S "$API/v1/engine" | jq '{version, mode, harness, backends, incarnation}'

say "3. Create the project through the public route"
CREATED=$(S -X POST "$API/v1/projects" -d "{\"name\": \"hands-on\", \"tier\": \"T2\", \"dev_repo_path\": \"$PROJ_REPO\", \"integration_branch\": \"main\"}")
echo "$CREATED" | jq .
P=$(echo "$CREATED" | jq -r '.project.id')
[[ $P == proj_* ]] || die "no project id"
for i in $(seq 1 100); do events | jq -e 'select(.type == "project.registered")' >/dev/null 2>&1 && break; sleep 0.2; done
S "$API/v1/projects/$P" | jq '.project | {id, now, execution, open_decisions, spend_today: {invocations: .spend_today.invocations, no_dispatch: .spend_today.no_dispatch}}'
run git -C "$PROJ_REPO" log --oneline main
run git -C "$PROJ_REPO" show --stat --format=%s main | sed -n '1,4p'

say "4. Fixtures: the approved baseline and plan (one requirement, one stage), and the declared check"
PLAN=$(S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R1\"}], \"stages\": [{\"number\": 1, \"goal\": \"the first stage\", \"implements\": [\"R1\"]}]}")
echo "$PLAN" | jq .
STAGE=$(echo "$PLAN" | jq -r '.stages[0].id'); BUILD=$(echo "$PLAN" | jq -r '.stages[0].work_item')
CHECKS=$(S -X POST "$API/v1/harness/fixtures/checks" -d "{\"project\": \"$P\", \"checks\": [{\"key\": \"login\", \"kind\": \"acceptance\", \"gate_kinds\": [\"stage\", \"alpha_authorize\"], \"requirements\": [\"R1\"]}]}")
echo "$CHECKS" | jq .
CHK=$(echo "$CHECKS" | jq -r '.checks[0].id')
S "$API/v1/projects/$P" | jq '.project.now'

say "5. Script the Builder for the stage's work item ($BUILD), then ask for a tick"
cat > "$SCRIPTED/scripts/$BUILD.json" <<'EOF'
[{"steps": [{"write": {"path": "src/app.js", "content": "export const answer = 42;\n"}},
            {"result": {"status": "completed", "summary": "scripted role finished"}}]}]
EOF
tick
S "$API/v1/projects/$P" | jq '.project | {now, execution}'
until_read "/v1/projects/$P" '.project.execution.runs == []' "the Builder's run to end"
RUN=$(events | jq -r 'select(.type == "run.ended") | .subject.run' | head -1)
S "$API/v1/projects/$P/runs/$RUN" | jq '.run | {id, state, outcome, reason_class, code}'
run git -C "$PROJ_REPO" log --oneline main
tick   # the nomination is made at the next tick
for i in $(seq 1 100); do events | jq -e 'select(.type == "candidate.nominated")' >/dev/null 2>&1 && break; sleep 0.2; done
C=$(events | jq -r 'select(.type == "candidate.nominated") | .subject.candidate' | head -1)
[[ $C == cand_* ]] || die "no candidate nominated (events: $(events | jq -c '{type, subject}' | tail -5))"
echo "candidate: $C"
run git -C "$PROJ_REPO" for-each-ref

say "6. The chain boundary: the candidate's verification waits for a person; find the decision in the decisions read and answer it"
for i in $(seq 1 4); do S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null && break; tick >/dev/null; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, question, options: [.options[].key], preview_hash}'
S "$API/v1/projects/$P" | jq '.project.now'
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash'); VERIFICATION=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
S "$API/v1/projects/$P/decisions" | jq '.decisions'
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the Verifier's run to end"
for i in $(seq 1 6); do events | jq -e "select(.type == \"work.complete\" and .subject.work_item == \"$VERIFICATION\")" >/dev/null 2>&1 && break; tick >/dev/null; until_read "/v1/projects/$P" '.project.execution.runs == []' 'runs to end'; done
events | jq -c "select(.subject.work_item == \"$VERIFICATION\") | {seq, type, from: .payload.from, to: .payload.to}"

say "7. The stage gate before the check's execution is observed: not satisfied"
S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'

say "8. Record the check's execution (a fixture); the engine queues the review; let it through; the Reviewer signs off"
S -X POST "$API/v1/harness/fixtures/check-result" -d "{\"project\": \"$P\", \"check\": \"$CHK\", \"candidate\": \"$C\", \"exit_status\": 0}" | jq .
for i in $(seq 1 4); do tick >/dev/null; S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null && break; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, preview_hash}'
REVIEW=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
events | jq -c "select(.type == \"work.created\" and .subject.work_item == \"$REVIEW\") | {seq, type, subject, payload}"
cat > "$SCRIPTED/scripts/$REVIEW.json" <<'EOF'
[{"steps": [{"result": {"status": "completed", "summary": "scripted role finished", "signoffs": [{"scope": "candidate"}]}}]}]
EOF
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash')
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the Reviewer's run to end"
for i in $(seq 1 50); do events | jq -e 'select(.type == "signoff.recorded")' >/dev/null 2>&1 && break; sleep 0.2; done
events | jq -c 'select(.type == "signoff.recorded") | {seq, type, subject, payload}'

say "9. The stage gate again: satisfied, and the stage's work completes"
S -X POST "$API/v1/projects/$P/candidates/$C/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
for i in $(seq 1 6); do events | jq -e "select(.type == \"work.complete\" and .subject.work_item == \"$BUILD\")" >/dev/null 2>&1 && break; tick >/dev/null; done
events | jq -c "select(.subject.work_item == \"$BUILD\") | {seq, type, from: .payload.from, to: .payload.to}"

say "10. The Alpha authorization for a test target: a configured target (fixture), a proposed authorization, the gate"
ENVIRONMENT=$(S -X POST "$API/v1/harness/fixtures/environment" -d "{\"project\": \"$P\", \"name\": \"alpha\", \"target_set\": [\"alpha-1\"]}")
echo "$ENVIRONMENT" | jq .
ENV=$(echo "$ENVIRONMENT" | jq -r '.environment.id')
AUTH=$(S -X POST "$API/v1/projects/$P/candidates/$C/authorizations" -d "{\"environment\": \"$ENV\", \"artifact_digest\": \"sha256:$(printf 'a%.0s' $(seq 1 64))\", \"config_identity\": \"config-1\", \"target_set\": [\"alpha-1\"]}")
echo "$AUTH" | jq .
DAUTH=$(echo "$AUTH" | jq -r '.authorization.id')
S -X POST "$API/v1/projects/$P/candidates/$C/gates/alpha_authorize" -d "{\"authorization\": \"$DAUTH\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
events | jq -c 'select(.type == "authorization.issued") | {seq, type, subject, payload}'

say "11. What the API shows at the end: the candidate, the project, the decisions, the event history"
S "$API/v1/projects/$P/candidates/$C" | jq '.candidate | {id, progress, protected_version, successor, gates: (.gates | map_values({outcome, stale}))}'
S "$API/v1/projects/$P" | jq '.project | {now, execution, open_decisions, spend_today: {invocations: .spend_today.invocations, no_dispatch: .spend_today.no_dispatch, usage_incomplete: .spend_today.usage_incomplete}}'
S "$API/v1/projects/$P/decisions" | jq '.decisions'
echo "the journey as the event stream tells it (seq, type, subject):"
events | jq -c 'select(.type | test("^(project|run\\.(created|ended)|candidate|decision\\.(raised|consumed)|work\\.(created|complete)|gate\\.evaluated|signoff|authorization)")) | [.seq, .type, (.subject | to_entries | map(.value) | join(" "))]'
echo "candidates advanced: $(events | jq -c 'select(.type == "candidate.advanced")' | wc -l) (nothing is deployed in M1)"
run git -C "$PROJ_REPO" log --oneline main
run git -C "$PROJ_REPO" status --short

say "12. Stop the engine and take a backup of its home"
kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" || true; ENGINE_PID=
( cd "$SURETY_HOME" && env -i SURETY_HOME="$SURETY_HOME" PATH="$PATH" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC node "$CLI" store backup ) | tee "$WORK/backup.out"
BACKUP=$(tail -1 "$WORK/backup.out" | jq -r '.backup')
jq '{label, store: .store | {file, bytes}, records: (.records | length), git}' "$BACKUP/manifest.json"

say "Done. The journey ran end to end."
