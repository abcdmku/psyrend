#!/usr/bin/env bash
# Reactivity audit of every visual on one busy stretch of a track: each hand-authored scene pinned,
# then each composed layer forced alone on a travel layout. One JSON line per visual.
#   bash scripts/audit-all.sh <wav> <from> <dur> <out.jsonl> [scenes|layers|all]
export PATH="/c/nvm4w/nodejs:$PATH"
FILE="$1"; FROM="$2"; DUR="$3"; OUT="$4"; WHAT="${5:-all}"
cd "$(dirname "$0")/.."
run() { timeout 300 node scripts/audit.mjs react --file "$FILE" --from "$FROM" --dur "$DUR" --fps 30 "$@" 2>&1 | grep '^{' ; }
if [ "$WHAT" != layers ]; then
  for id in $(grep -ho "id: '[a-z0-9-]*'" src/scenes/library/*.ts | sed "s/id: '\(.*\)'/\1/" | sort -u); do
    line=$(run --pin "$id" --out "artifacts/audit-x"); echo "{\"kind\":\"scene\",\"id\":\"$id\",\"r\":${line:-null}}" >> "$OUT"
  done
fi
if [ "$WHAT" != scenes ]; then
  for f in src/sculpt/layers/*.ts; do
    id=$(grep -o "^  id: '[a-z0-9-]*'" "$f" | sed "s/.*'\(.*\)'/\1/")
    layout=flight
    grep -q "layouts: '\*'\|'flight'" "$f" || layout=$(grep -o "layouts: \['[a-z]*'" "$f" | sed "s/.*'\(.*\)'/\1/")
    line=$(run --layout "$layout" --layers "$id" --background deep --cues --out "artifacts/audit-x"); echo "{\"kind\":\"layer\",\"id\":\"$id\",\"layout\":\"$layout\",\"r\":${line:-null}}" >> "$OUT"
  done
fi
