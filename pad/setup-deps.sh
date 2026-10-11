#!/bin/sh
# Holt die Build-Abhängigkeiten (ohne npm): CodeMirror 6 / Lezer als Quellen, sql.js als fertiges Release.
set -e
DEPS="${PAD_DEPS:-$(cd "$(dirname "$0")/../.." && pwd)/deps}"
mkdir -p "$DEPS" && cd "$DEPS"
for r in codemirror/state codemirror/view codemirror/language codemirror/commands codemirror/autocomplete \
         codemirror/lint codemirror/search lezer-parser/common lezer-parser/highlight lezer-parser/lr \
         marijnh/style-mod marijnh/w3c-keyname marijnh/crelt marijnh/find-cluster-break; do
  n=$(basename "$r"); [ -d "$n" ] || git clone -q --depth 1 "https://github.com/$r.git" "$n"
done
mkdir -p sqljs && cd sqljs
[ -f sql-wasm.wasm ] || { curl -sSfL -o sqljs-wasm.zip https://github.com/sql-js/sql.js/releases/download/v1.13.0/sqljs-wasm.zip && unzip -o -q sqljs-wasm.zip; }
echo "Abhängigkeiten in $DEPS"
