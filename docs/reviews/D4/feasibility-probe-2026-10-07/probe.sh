#!/usr/bin/env bash
# D4 §9.6 feasibility probe of the user service manager, with a STAND-IN launcher and init
# (a shell and unshare, not D2's launcher): it proves feasibility only; the real D2-derived
# launcher still needs the adapter's qualification.
# Safety (E64): one fresh unit name, refused if it already exists; every systemctl call names
# exactly that unit; the only process killed is the creator this script started, checked by its
# marker; bounded by the caller's timeout, the unit's RuntimeMaxSec and a cleanup trap on any exit.
# Usage: probe.sh <work dir to create>
set -u
WORK=$1
ID=$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')
UNIT="surety-probe-${ID}.service"
MARK="surety-probe-creator-${ID}"
NODE=$(command -v node)
CREATED=0; CREATOR=""; CG=""
log(){ printf '%s %s\n' "$(date -u +%H:%M:%S.%3N)" "$*"; }
run(){ log "\$ $*"; "$@" 2>&1 | sed 's/^/    /'; local rc=${PIPESTATUS[0]}; log "  rc=$rc"; return $rc; }
prop(){ systemctl --user show "$UNIT" -p "$1" --value 2>/dev/null; }

cleanup(){
  log "== cleanup"
  if [ -n "$CREATOR" ] && [ -r "/proc/$CREATOR/cmdline" ] && tr '\0' ' ' <"/proc/$CREATOR/cmdline" | grep -q "$MARK"; then
    run kill -KILL "$CREATOR"
  fi
  if [ "$CREATED" = 1 ]; then
    log "unit LoadState/ActiveState before cleanup: $(prop LoadState)/$(prop ActiveState)"
    [ "$(prop LoadState)" = loaded ] && run systemctl --user stop "$UNIT"
    systemctl --user reset-failed "$UNIT" >/dev/null 2>&1
    log "unit after cleanup: LoadState=$(prop LoadState) ActiveState=$(prop ActiveState)"
    [ -n "$CG" ] && log "unit cgroup directory exists after cleanup: $([ -e "/sys/fs/cgroup$CG" ] && echo yes || echo no)"
  fi
  chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"
  log "work directory removed: $([ -e "$WORK" ] && echo no || echo yes)"
  log "== cleanup done"
}
trap cleanup EXIT
trap 'log "signal received, cleaning up"; exit 2' TERM INT

log "== probe $ID: unit $UNIT, node $NODE ($(sha256sum "$NODE" | cut -c1-16)...)"
[ -e "$WORK" ] && { log "REFUSED: work directory exists"; WORK=/nonexistent-$ID; exit 3; }
pre=$(prop LoadState)
log "pre-check LoadState of $UNIT: '$pre'"
[ "$pre" = not-found ] || { log "REFUSED: unit name in use"; exit 3; }

mkdir -p "$WORK/app" "$WORK/mnt"
printf 'setInterval(() => {}, 1 << 30);\n' > "$WORK/app/server.js"
chmod -R a-w "$WORK/app"
mkfifo "$WORK/hold"
cat > "$WORK/init.sh" <<INIT
# stand-in domain init: pid 1 of its pid namespace; starts the application and reports its pid
"$NODE" "$WORK/mnt/server.js" &
echo \$! > "$WORK/app.nspid"
wait
INIT
cat > "$WORK/launcher.sh" <<LAUNCH
# stand-in launcher: outer user+mount namespace with a read-only bind of the artifact,
# then a nested user namespace and a new pid namespace for the init
exec unshare -Urm --fork bash -c 'mount --bind "$WORK/app" "$WORK/mnt" && mount -o remount,bind,ro "$WORK/mnt" && exec unshare -Ur --pid --fork bash "$WORK/init.sh"'
LAUNCH

log "== 1. create the unit from a separate creator process"
CREATED=1
bash -c 'systemd-run --user --unit="$1" --description="Surety D4 feasibility probe" -p Delegate=yes -p MemoryMax=64M -p MemorySwapMax=0 -p TasksMax=32 -p RuntimeMaxSec=300 -- /bin/bash "$2/launcher.sh" >"$2/systemd-run.out" 2>&1; echo "rc=$?" >>"$2/systemd-run.out"; exec 3<>"$2/hold"; read -t 280 -u 3; :' "$MARK" "$UNIT" "$WORK" &
CREATOR=$!
for i in $(seq 1 75); do [ -s "$WORK/app.nspid" ] && [ "$(prop ActiveState)" = active ] && break; sleep 0.2; done
log "systemd-run said: $(tr '\n' ' ' <"$WORK/systemd-run.out" 2>/dev/null)"
log "creator pid $CREATOR, cgroup $(cut -d: -f3 /proc/$CREATOR/cgroup), cmdline: $(tr '\0' ' ' </proc/$CREATOR/cmdline)"
[ -s "$WORK/app.nspid" ] || { log "FAIL: application did not start"; run systemctl --user status "$UNIT" --no-pager; exit 1; }

observe(){
  local tag=$1
  log "== $tag: unit properties"
  run systemctl --user show "$UNIT" -p ActiveState -p SubState -p Result -p InvocationID -p MainPID -p ControlGroup -p Delegate -p MemoryMax -p TasksMax
  CG=$(prop ControlGroup); MAIN=$(prop MainPID); INV=$(prop InvocationID)
  log "cgroup limits read back: memory.max=$(cat /sys/fs/cgroup$CG/memory.max) memory.swap.max=$(cat /sys/fs/cgroup$CG/memory.swap.max) pids.max=$(cat /sys/fs/cgroup$CG/pids.max)"
  log "members (cgroup.procs, recursive):"
  INIT=""; APP=""
  local nsapp; nsapp=$(cat "$WORK/app.nspid")
  for p in $(find /sys/fs/cgroup$CG -name cgroup.procs -exec cat {} + | sort -n); do
    local ns pp exe st
    ns=$(awk '/^NSpid/{$1="";print}' /proc/$p/status); pp=$(awk '/^PPid/{print $2}' /proc/$p/status)
    exe=$(readlink /proc/$p/exe); st=$(awk '{print $22}' /proc/$p/stat)
    log "  pid=$p ppid=$pp NSpid=[$ns] start=$st exe=$exe argv=$(tr '\0' ' ' </proc/$p/cmdline)"
    set -- $ns; local last=${!#}
    [ $# -ge 2 ] && [ "$last" = 1 ] && INIT=$p
  done
  for p in $(find /sys/fs/cgroup$CG -name cgroup.procs -exec cat {} +); do
    set -- $(awk '/^NSpid/{$1="";print}' /proc/$p/status); local last=${!#}
    [ $# -ge 2 ] && [ "$last" = "$nsapp" ] && [ "$(awk '/^PPid/{print $2}' /proc/$p/status)" = "$INIT" ] && APP=$p
  done
  log "MainPID=$MAIN (launcher) init(host)=$INIT application(host)=$APP init-reported application ns pid=$nsapp"
  log "binding: MainPID is the application? $([ "$MAIN" = "$APP" ] && echo yes || echo no); init report and host read agree? $([ -n "$APP" ] && echo yes || echo no)"
  if [ -n "$APP" ]; then
    log "application exe=$(readlink /proc/$APP/exe) exe sha256=$(sha256sum /proc/$APP/exe | cut -c1-16)... start=$(awk '{print $22}' /proc/$APP/stat)"
    log "mountinfo for the artifact path:"; grep " $WORK/mnt " /proc/$APP/mountinfo | sed 's/^/    /'
    log "artifact via /proc/$APP/root: $(sha256sum "/proc/$APP/root$WORK/mnt/server.js" | cut -d' ' -f1)"
    log "artifact source on host:       $(sha256sum "$WORK/app/server.js" | cut -d' ' -f1)"
    ( echo x >> "/proc/$APP/root$WORK/mnt/server.js" ) 2>/dev/null && log "host write through /proc root: SUCCEEDED (unexpected)" || log "host write through /proc root: refused"
  fi
}
observe "2. first observation"
INV1=$INV; APP1=$APP; APPST1=$(awk '{print $22}' /proc/$APP/stat 2>/dev/null)
log "unit cgroup under the creator's cgroup? $(case "$CG" in "$(cut -d: -f3 /proc/$CREATOR/cgroup)"*) echo yes;; *) echo no;; esac)"

log "== 3. SIGKILL the creator only (pid $CREATOR, marker checked)"
tr '\0' ' ' </proc/$CREATOR/cmdline | grep -q "$MARK" && run kill -KILL "$CREATOR"
wait "$CREATOR" 2>/dev/null; sleep 1
log "creator alive? $([ -e /proc/$CREATOR ] && echo yes || echo no); unit ActiveState=$(prop ActiveState) InvocationID unchanged? $([ "$(prop InvocationID)" = "$INV1" ] && echo yes || echo no); application pid $APP1 alive with same start? $([ "$(awk '{print $22}' /proc/$APP1/stat 2>/dev/null)" = "$APPST1" ] && echo yes || echo no)"
CREATOR=""

log "== 4. restart the unit"
rm -f "$WORK/app.nspid"
run systemctl --user restart "$UNIT"
for i in $(seq 1 75); do [ -s "$WORK/app.nspid" ] && break; sleep 0.2; done
observe "4. after restart"
log "InvocationID changed? $([ "$INV" != "$INV1" ] && echo yes || echo no) ($INV1 -> $INV); old application pid $APP1 gone or reused with another start? $([ "$(awk '{print $22}' /proc/$APP1/stat 2>/dev/null)" != "$APPST1" ] && echo yes || echo no)"

log "== 5. stop: closure and emptiness"
run systemctl --user stop "$UNIT"
log "after stop: LoadState=$(prop LoadState) ActiveState=$(prop ActiveState) cgroup directory exists? $([ -e "/sys/fs/cgroup$CG" ] && echo yes || echo no) populated=$(grep populated /sys/fs/cgroup$CG/cgroup.events 2>/dev/null || echo n/a)"
log "application pid $APP alive? $([ -e /proc/$APP ] && echo yes || echo no)"
log "== probe complete"
