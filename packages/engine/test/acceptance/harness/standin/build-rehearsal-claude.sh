#!/bin/sh
# Builds the rehearsal's fake claude as a native image (rehearsal-claude.c
# with rehearsal-claude.cjs embedded) at $1. Rehearsal only (E79); never
# part of a test run. Needs cc and node (no xxd: node writes the C array,
# as xxd -i would); node is named by absolute path.
set -eu
out=${1:?usage: build-rehearsal-claude.sh <output path>}
here=$(cd "$(dirname "$0")" && pwd)
node=$(command -v node)
case "$node" in /*) ;; *) echo "node is not an absolute path: $node" >&2; exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$here/rehearsal-claude.cjs" "$tmp/rehearsal-claude.cjs"
printf '\0' >> "$tmp/rehearsal-claude.cjs"
"$node" -e '
  const fs = require("fs");
  const b = fs.readFileSync(process.argv[1]);
  const rows = [];
  for (let i = 0; i < b.length; i += 12) rows.push("  " + [...b.subarray(i, i + 12)].map((x) => "0x" + x.toString(16).padStart(2, "0")).join(", "));
  fs.writeFileSync(process.argv[2], "unsigned char rehearsal_claude_cjs[] = {\n" + rows.join(",\n") + "\n};\nunsigned int rehearsal_claude_cjs_len = " + b.length + ";\n");
' "$tmp/rehearsal-claude.cjs" "$tmp/rehearsal-claude.script.h"
cc -O2 -Wall -Wextra -I"$tmp" -DREHEARSAL_NODE="\"$node\"" -o "$out" "$here/rehearsal-claude.c"
chmod 755 "$out"
