#!/usr/bin/env bash
# The M1 hands-on walkthrough: the kernel journey of acceptance row M01, made
# by hand against a running engine with curl. Every step is one the journey
# test (packages/engine/test/acceptance/harness/journey.mjs) makes; nothing
# here is new. Each step prints what it ran and what came back, and stops at
# the first answer that is not the expected one.
#
# Two parts, like the journey's two paths. Part one (steps 1 to 12) is the
# path where nothing goes wrong (`journey()`). Part two (steps 13 to 21) is
# the fix loop (`fixLoop()`, E43): in a fresh engine home the same project is
# made and built, the Verifier reports a Critical finding, the Reviewer
# proposes to fix it, the engine creates the fix work, a person lets it
# through, a Builder fixes it, the fixed code is nominated and verified, the
# finding resolves, and the gates pass on the fixed candidate.
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

say "Part one done. The journey ran end to end."

# ---------------------------------------------------------------------------
# Part two: the fix loop (E43), the journey's second path. It begins as the
# first did, in a fresh engine home, a scripted directory and a repository of
# its own, on the same port (the first engine is stopped). The helpers above
# read SURETY_HOME, API and P when they run, so they need no change.
# ---------------------------------------------------------------------------

say "13. Part two, the fix loop: a fresh engine home, and steps 1 to 5 again (a project, its plan and check, the stage built and nominated)"
SURETY_HOME=$WORK/home2; SCRIPTED=$WORK/scripted2; PROJ_REPO=$WORK/repo2
mkdir -p "$SURETY_HOME" "$SCRIPTED/scripts" "$SCRIPTED/release"
cat > "$SURETY_HOME/config.json" <<EOF
{"api_port": $PORT, "tick_interval": 600, "terminate_grace": 2, "kill_grace": 1}
EOF
cp "$REPO/packages/engine/test/acceptance/harness/scripted/child.mjs" "$SCRIPTED/"
cat > "$SCRIPTED/scripts/default.json" <<'EOF'
{"steps": [{"result": {"status": "completed", "summary": "scripted role finished"}}]}
EOF
git init -q -b main "$PROJ_REPO"
mkdir -p "$PROJ_REPO/.surety/checks"
printf '# hands-on\n' > "$PROJ_REPO/README.md"
printf '{"protected_paths": [".surety/checks/"], "required_checks": ["login"]}\n' > "$PROJ_REPO/.surety/checks/protected-policy.json"
printf '{"expect": 200}\n' > "$PROJ_REPO/.surety/checks/login.check.json"
git -C "$PROJ_REPO" add -A && git -C "$PROJ_REPO" commit -q -m 'fixture: initial commit'
git -C "$PROJ_REPO" checkout -q --detach
( cd "$SURETY_HOME" && exec env -i SURETY_HOME="$SURETY_HOME" PATH="$PATH" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC \
    node "$CLI" serve --harness --harness-scripted "$SCRIPTED" > "$WORK/engine2.log" 2>&1 ) &
ENGINE_PID=$!
for i in $(seq 1 100); do [ -f "$SURETY_HOME/api.token" ] && break; sleep 0.2; done
[ -f "$SURETY_HOME/api.token" ] || die "no api.token after 20 s; see $WORK/engine2.log"
until_read /v1/health '.mode == "full"' 'the second engine to reach full mode'
S "$API/v1/engine" | jq '{mode, harness, backends, incarnation}'
CREATED=$(S -X POST "$API/v1/projects" -d "{\"name\": \"hands-on-fix\", \"tier\": \"T2\", \"dev_repo_path\": \"$PROJ_REPO\", \"integration_branch\": \"main\"}")
P=$(echo "$CREATED" | jq -r '.project.id'); echo "project: $P"
[[ $P == proj_* ]] || die "no project id"
for i in $(seq 1 100); do events | jq -e 'select(.type == "project.registered")' >/dev/null 2>&1 && break; sleep 0.2; done
PLAN=$(S -X POST "$API/v1/harness/fixtures/plan" -d "{\"project\": \"$P\", \"requirements\": [{\"key\": \"R1\"}], \"stages\": [{\"number\": 1, \"goal\": \"the first stage\", \"implements\": [\"R1\"]}]}")
STAGE=$(echo "$PLAN" | jq -r '.stages[0].id'); BUILD=$(echo "$PLAN" | jq -r '.stages[0].work_item'); echo "stage: $STAGE, its work: $BUILD"
CHECKS=$(S -X POST "$API/v1/harness/fixtures/checks" -d "{\"project\": \"$P\", \"checks\": [{\"key\": \"login\", \"kind\": \"acceptance\", \"gate_kinds\": [\"stage\", \"alpha_authorize\"], \"requirements\": [\"R1\"]}]}")
CHK=$(echo "$CHECKS" | jq -r '.checks[0].id'); echo "check: $CHK"
cat > "$SCRIPTED/scripts/$BUILD.json" <<'EOF'
[{"steps": [{"write": {"path": "src/app.js", "content": "export const answer = 42;\n"}},
            {"result": {"status": "completed", "summary": "scripted role finished"}}]}]
EOF
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the Builder's run to end"
tick   # the nomination is made at the next tick
for i in $(seq 1 100); do events | jq -e 'select(.type == "candidate.nominated")' >/dev/null 2>&1 && break; sleep 0.2; done
C1=$(events | jq -r 'select(.type == "candidate.nominated") | .subject.candidate' | head -1)
[[ $C1 == cand_* ]] || die "no candidate nominated (events: $(events | jq -c '{type, subject}' | tail -5))"
echo "the first candidate: $C1"
run git -C "$PROJ_REPO" log --oneline main

say "14. The chain boundary, with the Verifier scripted to report a Critical finding that names the check; let the verification through"
for i in $(seq 1 4); do S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null && break; tick >/dev/null; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, preview_hash}'
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash'); VERIFICATION=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
cat > "$SCRIPTED/scripts/$VERIFICATION.json" <<'EOF'
[{"steps": [{"result": {"status": "completed", "summary": "scripted role finished",
                        "findings": [{"category": "security", "severity": "critical", "message": "the login accepts an expired session", "check": "login"}]}}]}]
EOF
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the Verifier's run to end"
for i in $(seq 1 6); do events | jq -e "select(.type == \"work.complete\" and .subject.work_item == \"$VERIFICATION\")" >/dev/null 2>&1 && break; tick >/dev/null; until_read "/v1/projects/$P" '.project.execution.runs == []' 'runs to end'; done
events | jq -c 'select(.type == "finding.raised") | {seq, type, subject, payload}'
FINDING=$(events | jq -r 'select(.type == "finding.raised") | .subject.finding' | head -1)
[[ $FINDING == fnd_* ]] || die "no finding raised"
echo "the finding: $FINDING"
S -X POST "$API/v1/projects/$P/candidates/$C1/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'

say "15. Record the check's execution; the engine queues the review; the Reviewer proposes to fix the finding and signs nothing off"
S -X POST "$API/v1/harness/fixtures/check-result" -d "{\"project\": \"$P\", \"check\": \"$CHK\", \"candidate\": \"$C1\", \"exit_status\": 0}" | jq .
for i in $(seq 1 4); do tick >/dev/null; S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null && break; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, preview_hash}'
REVIEW=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
cat > "$SCRIPTED/scripts/$REVIEW.json" <<EOF
[{"steps": [{"result": {"status": "completed", "summary": "scripted role finished",
                        "dispositions": [{"finding": "$FINDING", "disposition": "fix"}]}}]}]
EOF
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash')
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the Reviewer's run to end"
for i in $(seq 1 50); do events | jq -e 'select(.type == "finding.dispositioned")' >/dev/null 2>&1 && break; sleep 0.2; done
events | jq -c 'select(.type == "finding.dispositioned") | {seq, type, subject, payload}'
events | jq -c 'select(.type == "work.created" and .payload.kind == "fix") | {seq, type, subject, payload}'
FIX=$(events | jq -r 'select(.type == "work.created" and .payload.kind == "fix") | .subject.work_item' | head -1)
[[ $FIX == wi_* ]] || die "the engine registered no fix work (E43)"
echo "the fix work the engine registered: $FIX"
echo "sign-offs recorded: $(events | jq -c 'select(.type == "signoff.recorded")' | wc -l)"

say "16. The stage gate on the first candidate: blocked by the finding"
S -X POST "$API/v1/projects/$P/candidates/$C1/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'

say "17. The fix waits at the chain boundary; script its Builder, let it through; the engine integrates the fix and nominates the fix's candidate"
for i in $(seq 1 4); do S "$API/v1/projects/$P/decisions" | jq -e ".decisions[] | select(.subject_id == \"$FIX\")" >/dev/null 2>&1 && break; tick >/dev/null; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, question, preview_hash}'
S "$API/v1/projects/$P" | jq '.project.now'
cat > "$SCRIPTED/scripts/$FIX.json" <<'EOF'
[{"steps": [{"write": {"path": "src/session.js", "content": "export const expiresSessions = true;\n"}},
            {"result": {"status": "completed", "summary": "scripted role finished"}}]}]
EOF
D=$(S "$API/v1/projects/$P/decisions" | jq -r ".decisions[] | select(.subject_id == \"$FIX\") | .id"); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r ".decisions[] | select(.subject_id == \"$FIX\") | .preview_hash")
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the fix's Builder run to end"
FIXRUN=$(events | jq -r "select(.type == \"run.ended\") | select(.subject.work_item == \"$FIX\") | .subject.run" | head -1)
S "$API/v1/projects/$P/runs/$FIXRUN" | jq '.run | {id, role, state, outcome, reason_class}'
tick   # the fix's integration is a cadence point: the nomination follows
for i in $(seq 1 6); do [ "$(events | jq -c 'select(.type == "candidate.nominated")' | wc -l)" -ge 2 ] && break; tick >/dev/null; done
events | jq -c 'select(.type == "candidate.nominated") | {seq, type, subject, payload}'
C2=$(events | jq -r 'select(.type == "candidate.nominated") | .subject.candidate' | sed -n 2p)
[[ $C2 == cand_* ]] || die "the fix's integration nominated no second candidate (E43; SEAM.md section 42)"
echo "the fix's candidate: $C2"
run git -C "$PROJ_REPO" log --oneline main
git -C "$PROJ_REPO" for-each-ref 'refs/surety/cand/'
events | jq -c "select(.subject.work_item == \"$FIX\") | {seq, type, from: .payload.from, to: .payload.to}"

say "18. The fix's candidate is verified: its verification waits at the chain boundary; let it through (its Verifier reports nothing)"
for i in $(seq 1 4); do S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null && break; tick >/dev/null; done
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, preview_hash}'
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash'); VERIFICATION2=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the second Verifier's run to end"
for i in $(seq 1 6); do events | jq -e "select(.type == \"work.complete\" and .subject.work_item == \"$VERIFICATION2\")" >/dev/null 2>&1 && break; tick >/dev/null; until_read "/v1/projects/$P" '.project.execution.runs == []' 'runs to end'; done
echo "before the check is executed on the fix's candidate: the fix's work is at $(events | jq -r "select(.subject.work_item == \"$FIX\") | .payload.to // empty" | tail -1); findings resolved: $(events | jq -c 'select(.type == "finding.resolved")' | wc -l)"

say "19. The check passes on the fix's candidate: the finding is resolved and the fix's work completes; the engine queues the review; the Reviewer signs off"
S -X POST "$API/v1/harness/fixtures/check-result" -d "{\"project\": \"$P\", \"check\": \"$CHK\", \"candidate\": \"$C2\", \"exit_status\": 0}" | jq .
for i in $(seq 1 4); do tick >/dev/null; S "$API/v1/projects/$P/decisions" | jq -e '.decisions | length > 0' >/dev/null && break; done
events | jq -c 'select(.type == "finding.resolved") | {seq, type, subject, payload}'
events | jq -c "select(.subject.work_item == \"$FIX\") | {seq, type, from: .payload.from, to: .payload.to}" | tail -1
S "$API/v1/projects/$P/decisions" | jq '.decisions[] | {id, kind, subject_type, subject_id, preview_hash}'
REVIEW2=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].subject_id')
cat > "$SCRIPTED/scripts/$REVIEW2.json" <<'EOF'
[{"steps": [{"result": {"status": "completed", "summary": "scripted role finished", "signoffs": [{"scope": "candidate"}]}}]}]
EOF
D=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].id'); HASH=$(S "$API/v1/projects/$P/decisions" | jq -r '.decisions[0].preview_hash')
run S -X POST "$API/v1/projects/$P/decisions/$D/answer" -d "{\"option\": \"continue\", \"preview_hash\": \"$HASH\"}"; echo
tick
until_read "/v1/projects/$P" '.project.execution.runs == []' "the second Reviewer's run to end"
for i in $(seq 1 50); do events | jq -e 'select(.type == "signoff.recorded")' >/dev/null 2>&1 && break; sleep 0.2; done
events | jq -c 'select(.type == "signoff.recorded") | {seq, type, subject, payload}'

say "20. The stage gate on the fix's candidate: satisfied, and the stage's work completes; the Alpha authorization for the fix's candidate"
S -X POST "$API/v1/projects/$P/candidates/$C2/gates/stage" -d "{\"stage\": \"$STAGE\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
for i in $(seq 1 6); do events | jq -e "select(.type == \"work.complete\" and .subject.work_item == \"$BUILD\")" >/dev/null 2>&1 && break; tick >/dev/null; done
events | jq -c "select(.subject.work_item == \"$BUILD\") | {seq, type, from: .payload.from, to: .payload.to}"
ENV=$(S -X POST "$API/v1/harness/fixtures/environment" -d "{\"project\": \"$P\", \"name\": \"alpha\", \"target_set\": [\"alpha-1\"]}" | jq -r '.environment.id')
AUTH=$(S -X POST "$API/v1/projects/$P/candidates/$C2/authorizations" -d "{\"environment\": \"$ENV\", \"artifact_digest\": \"sha256:$(printf 'a%.0s' $(seq 1 64))\", \"config_identity\": \"config-1\", \"target_set\": [\"alpha-1\"]}")
echo "$AUTH" | jq '.authorization | {id, status, generation}'
DAUTH=$(echo "$AUTH" | jq -r '.authorization.id')
S -X POST "$API/v1/projects/$P/candidates/$C2/gates/alpha_authorize" -d "{\"authorization\": \"$DAUTH\"}" | jq '.evaluation | {outcome, reasons, check_states, stale}'
events | jq -c 'select(.type == "authorization.issued") | {seq, type, subject, payload}'

say "21. What the API shows at the end of the fix loop, then stop the engine and take a backup"
S "$API/v1/projects/$P/candidates/$C1" | jq '.candidate | {id, seq, successor, gates: (.gates | map_values({outcome, stale}))}'
S "$API/v1/projects/$P/candidates/$C2" | jq '.candidate | {id, seq, progress, successor, gates: (.gates | map_values({outcome, stale}))}'
S "$API/v1/projects/$P" | jq '.project | {now, execution, open_decisions, spend_today: {invocations: .spend_today.invocations, no_dispatch: .spend_today.no_dispatch, usage_incomplete: .spend_today.usage_incomplete}}'
S "$API/v1/projects/$P/decisions" | jq '.decisions'
echo "the fix loop as the event stream tells it (seq, type, subject):"
events | jq -c 'select(.type | test("^(project|run\\.(created|ended)|candidate|decision\\.(raised|consumed)|work\\.(created|complete)|gate\\.evaluated|finding|signoff|authorization)")) | [.seq, .type, (.subject | to_entries | map(.value) | join(" "))]'
echo "candidates advanced: $(events | jq -c 'select(.type == "candidate.advanced")' | wc -l) (nothing is deployed in M1)"
run git -C "$PROJ_REPO" log --oneline main
run git -C "$PROJ_REPO" status --short
kill -TERM "$ENGINE_PID"; wait "$ENGINE_PID" || true; ENGINE_PID=
( cd "$SURETY_HOME" && env -i SURETY_HOME="$SURETY_HOME" PATH="$PATH" HOME="$SURETY_HOME" LANG=C.UTF-8 TZ=UTC node "$CLI" store backup ) | tee "$WORK/backup2.out"
BACKUP=$(tail -1 "$WORK/backup2.out" | jq -r '.backup')
jq '{label, store: .store | {file, bytes}, records: (.records | length), git}' "$BACKUP/manifest.json"

say "Done. Both paths of the journey ran end to end."
