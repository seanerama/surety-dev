#!/bin/sh
# Builds the rehearsal's fake claude as a native image (rehearsal-claude.c
# with rehearsal-claude.cjs embedded) at $1. Rehearsal only (E79); never
# part of a test run. Needs cc and xxd; node is named by absolute path.
set -eu
out=${1:?usage: build-rehearsal-claude.sh <output path>}
here=$(cd "$(dirname "$0")" && pwd)
node=$(command -v node)
case "$node" in /*) ;; *) echo "node is not an absolute path: $node" >&2; exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$here/rehearsal-claude.cjs" "$tmp/rehearsal-claude.cjs"
printf '\0' >> "$tmp/rehearsal-claude.cjs"
(cd "$tmp" && xxd -i rehearsal-claude.cjs > rehearsal-claude.script.h)
cc -O2 -Wall -Wextra -I"$tmp" -DREHEARSAL_NODE="\"$node\"" -o "$out" "$here/rehearsal-claude.c"
chmod 755 "$out"
