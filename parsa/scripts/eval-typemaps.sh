#!/bin/sh
# eval-typemaps.sh <corpus-id|path> --secs N --mb N [--scorer PATH] [--truth DIR] [--atom BIN]
#                  [--corpus-json FILE] [--out DIR] [--samples N]
#
# One command for the two score tables of #44: for one JavaScript or TypeScript input it runs
# astgen under the watchdog in ts6 and native modes, prints the type map agreement table between
# them, and, when a callsites scorer is given (--scorer or $CALLSITES_SCORER), builds usages and
# callsites slices with atom in both modes and prints both score tables. Without a scorer it says
# so and still prints the type map table. The scorer, its truth and the corpus paths stay outside
# this repository; --scorer takes the scorer's location, --truth its truth directory and
# --corpus-json a corpus description (id, path, lang) such as the evaluation workspace's.
#
# It refuses to run without caps: --secs and --mb are required, and every astgen and atom run goes
# through parsa/scripts/wd.sh with them. The native binary is the one npm run test:native's CI job
# builds (parsa/_deps/bin/parsa; see docs/TESTING.md).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/.." && pwd)
wd="$here/scripts/wd.sh"

usage() {
  cat >&2 <<'EOF'
usage: eval-typemaps.sh <corpus-id|path> --secs N --mb N [options]

  --secs N          wall time cap for every run (required)
  --mb N            memory cap in MB for every run (required)
  --scorer PATH     the callsites scorer (score.py); also $CALLSITES_SCORER
  --truth DIR       the scorer's truth directory (<id>.json, <id>.typed.json); also $CALLSITES_TRUTH
  --atom BIN        an atom that takes --frontend-args (built with the chen under test); also $EVAL_ATOM
  --corpus-json F   corpus description with id, path and lang per input; also $ASTGEN_EVAL_CORPUS_JSON
  --out DIR         keep the runs under DIR (default: a temporary directory, removed afterwards)
  --samples N       samples per difference class in the type map table (default 3)
EOF
  exit 2
}

[ $# -ge 1 ] || usage
input=$1; shift

secs=""; mb=""; scorer=${CALLSITES_SCORER:-}; truth=${CALLSITES_TRUTH:-}
atom=${EVAL_ATOM:-}; corpus_json=${ASTGEN_EVAL_CORPUS_JSON:-}; out=""; samples=3
while [ $# -gt 0 ]; do
  case "$1" in
    --secs) secs=$2; shift 2 ;;
    --mb) mb=$2; shift 2 ;;
    --scorer) scorer=$2; shift 2 ;;
    --truth) truth=$2; shift 2 ;;
    --atom) atom=$2; shift 2 ;;
    --corpus-json) corpus_json=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --samples) samples=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; usage ;;
  esac
done

if [ -z "$secs" ] || [ -z "$mb" ]; then
  echo "refusing to run without caps: pass --secs and --mb (for example --secs 600 --mb 8192 for a corpus project, --secs 120 --mb 2048 for a fixture)" >&2
  exit 2
fi
for n in "$secs" "$mb"; do
  case "$n" in *[!0-9]*) echo "--secs and --mb need numbers" >&2; exit 2 ;; esac
done

# Resolve the input: a directory as it is, or an id from the corpus description.
proj=""
lang=js
if [ -d "$input" ]; then
  proj=$(cd "$input" && pwd)
  id=$(basename "$proj")
else
  id=$input
  if [ -z "$corpus_json" ]; then
    echo "corpus id $id needs --corpus-json (or \$ASTGEN_EVAL_CORPUS_JSON) naming the corpus description with its path; a source directory also works directly" >&2
    exit 2
  fi
  proj=$(python3 - "$corpus_json" "$id" <<'PY'
import json, os, sys
try:
    corpus = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(f"cannot read corpus description {sys.argv[1]}: {e}")
for entry in corpus.get("inputs", []):
    if entry.get("id") == sys.argv[2]:
        print(os.path.expanduser(entry["path"])); break
else:
    sys.exit(f"no input {sys.argv[2]} in {sys.argv[1]}")
PY
)
  if [ ! -d "$proj" ]; then
    echo "the corpus path of $id, $proj, does not exist" >&2
    exit 2
  fi
  lang=$(python3 - "$corpus_json" "$id" <<'PY'
import json, sys
corpus = json.load(open(sys.argv[1]))
for entry in corpus.get("inputs", []):
    if entry.get("id") == sys.argv[2]:
        print("ts" if entry.get("lang") == "ts" else "js"); break
PY
)
fi

parsa_bin="$here/_deps/bin/parsa"
if [ ! -x "$parsa_bin" ]; then
  echo "no native binary at $parsa_bin; build it first: (cd parsa && ./scripts/wd.sh -t 900 -m 6144 -- go build -trimpath -o _deps/bin/parsa ./cmd/parsa)" >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }
"$wd" -t 5 -m 512 -- node -e 1 >/dev/null 2>&1 || true  # build the watchdog on first use, cheaply

if [ -n "$scorer" ] && [ ! -f "$scorer" ]; then
  echo "the scorer $scorer is not a file" >&2; exit 2
fi
if [ -n "$scorer" ] && [ -z "$truth" ]; then
  truth=$(dirname "$(dirname "$scorer")")/truth
fi
if [ -n "$scorer" ] && [ ! -d "$truth" ]; then
  echo "the truth directory $truth does not exist; pass --truth" >&2; exit 2
fi
if [ -n "$scorer" ] && [ -z "$atom" ]; then
  echo "slice scoring needs an atom that takes --frontend-args; pass --atom (or set \$EVAL_ATOM)" >&2
  exit 2
fi

tmp=
cleanup() { [ -z "$tmp" ] || rm -rf "$tmp"; }
trap cleanup EXIT INT TERM
if [ -n "$out" ]; then
  mkdir -p "$out"
else
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/eval-typemaps.XXXXXX")
  out=$tmp
fi
# absolute, because astgen runs from the project directory
out=$(cd "$out" && pwd)

# Half the memory cap, as a Go soft limit for the binary astgen starts: astgen passes it to parsa
# as --memory-mb and as GOMEMLIMIT unless the caller set one. The binary itself is named for astgen
# wherever it is started from, including inside atom.
export ASTGEN_NATIVE_MEMORY_MB=$((mb / 2))
export ASTGEN_NATIVE_BIN="$parsa_bin"

run_astgen() { # run_astgen <mode> <outdir>
  mode=$1; dir=$2
  rm -rf "$dir"; mkdir -p "$dir"
  # from the project directory with the default input, as chen's AstGenRunner starts it
  echo "== astgen ($mode): $( cd "$proj" && "$wd" -t "$secs" -m "$mb" -- env ASTGEN_TYPES="$mode" \
      ASTGEN_NATIVE_BIN="$parsa_bin" node "$repo/astgen.js" -t ts -o "$dir" 2>&1 | tail -n 1 )"
}

echo "== input: $id ($proj)"
echo "== caps: ${secs}s, ${mb}MB per run (watchdog)"
run_astgen ts6 "$out/ast-ts6"
run_astgen native "$out/ast-native"

echo "== type map agreement (baseline: ts6, candidate: native)"
( cd "$repo" && node lib/typemap/diff.mjs --baseline "$out/ast-ts6" --candidate "$out/ast-native" \
    --src "$proj" --candidate-counts-bom --samples "$samples" --allow "$repo/test-fixtures/typemap-allow.json" ) || true

if [ -z "$scorer" ]; then
  echo ""
  echo "== no callsites scorer given (pass --scorer PATH or set CALLSITES_SCORER); the type map table above is the whole output"
  exit 0
fi

# The scorer is scored against the untyped oracle, as the evaluation harness scores it; when a typed
# oracle exists for a project with node_modules, both are scored (the typed one adds the via=type
# rows, and precision against it is what chen#298 quotes).
truth_file="$truth/$id.json"
if [ ! -f "$truth_file" ]; then
  echo "no truth for $id at $truth_file" >&2
  exit 2
fi
echo ""
echo "== scorer: $scorer"
echo "== truth:  $truth_file"

score_table=$out/scores.txt
: > "$score_table"
# chen's AstGenRunner runs `astgen` from PATH: expose this repository's astgen.js to atom
astgen_bin=$out/bin; mkdir -p "$astgen_bin"
ln -sf "$repo/astgen.js" "$astgen_bin/astgen"
for mode in ts6 native; do
  rm -rf "$proj/.chen"
  dir=$out/atom-$mode; mkdir -p "$dir"
  extra="--frontend-args astgen-types=$mode"
  echo "== atom ($mode): usages $( PATH="$astgen_bin:$PATH" "$wd" -t "$secs" -m "$mb" -- "$atom" usages -l "$lang" -o "$dir/app.atom" -s "$dir/usages.json" $extra "$proj" >/dev/null 2> "$dir/usages.err" && echo ok || echo FAILED )"
  echo "== atom ($mode): callsites $( PATH="$astgen_bin:$PATH" "$wd" -t "$secs" -m "$mb" -- "$atom" callsites -l "$lang" --reuse-atom -o "$dir/app.atom" -s "$dir/callsites.json" $extra "$proj" >/dev/null 2> "$dir/callsites.err" && echo ok || echo FAILED )"
  rm -rf "$proj/.chen"
  rm -f "$dir/app.atom"
  for kind in callsites usages; do
    [ -s "$dir/$kind.json" ] || { echo "== $kind ($mode): no slice" | tee -a "$score_table"; continue; }
    python3 "$scorer" "$proj" "$truth_file" "$dir/$kind.json" --slice-kind "$kind" --json "$dir/score-$kind.json" --quiet || true
    if [ -s "$dir/score-$kind.json" ]; then
      python3 - "$mode" "$kind" "$dir/score-$kind.json" "$score_table" <<'PY'
import json, sys
mode, kind, path, table = sys.argv[1:5]
d = json.load(open(path))
no_type = f"{d['precisionNoType']:.3f}" if d.get("precisionNoType") is not None else "-"
print(f"{kind:10} {mode:7} recall {d['recall']:.3f}  precision {d['precision']:.3f}  "
      f"precisionNoType {no_type}  tp {d.get('tp')} of {d.get('observations')} observations, "
      f"{d.get('truth')} truth rows", file=open(table, "a"))
PY
    fi
    # the typed oracle, when there is one, as a second line
    typed="$truth/$id.typed.json"
    if [ -f "$typed" ] && [ -d "$proj/node_modules" ]; then
      python3 "$scorer" "$proj" "$typed" "$dir/$kind.json" --slice-kind "$kind" --json "$dir/score-$kind-typed.json" --quiet || true
      [ -s "$dir/score-$kind-typed.json" ] && python3 - "$mode" "$kind" "$dir/score-$kind-typed.json" "$score_table" <<'PY'
import json, sys
mode, kind, path, table = sys.argv[1:5]
d = json.load(open(path))
print(f"{kind:10} {mode:7} recall {d['recall']:.3f}  precision {d['precision']:.3f}  "
      f"(typed truth)  tp {d.get('tp')} of {d.get('observations')} observations, "
      f"{d.get('truth')} truth rows", file=open(table, "a"))
PY
    fi
  done
done

echo ""
echo "== score tables (callsites and usages, ts6 against native)"
cat "$score_table"
