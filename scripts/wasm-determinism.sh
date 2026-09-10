#!/usr/bin/env bash
# T7 — El criterio que justifica el diseño entero: la simulación tiene que dar
# el MISMO hash compilada a wasm que compilada a nativo. Si difieren, hay una
# transcendental de plataforma colada (sin/cos/atan2/exp fuera de `libm`), y eso
# significa que el verificador de replays daría falsos positivos y que el boss
# se entrenaría contra una física distinta a la que jugó la gente.
#
# No usa wasm-pack: el crate no necesita bindings para esto, alcanza con
# instanciar el .wasm en node y llamar al export.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo test -q --test determinism >/dev/null
nativo=$(cargo test -q --test determinism print_hash -- --ignored --nocapture \
  | sed -n 's/^HASH=//p')

cargo build --quiet --release --target wasm32-unknown-unknown
WASM=target/wasm32-unknown-unknown/release/engine.wasm

wasm=$(node -e '
const fs = require("fs");
const m = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(process.argv[1])), {});
console.log("0x" + BigInt.asUintN(64, m.exports.golden_hash_c()).toString(16).padStart(16, "0"));
' "$WASM")

echo "nativo: $nativo"
echo "wasm:   $wasm"
[ "$nativo" = "$wasm" ] || { echo "DIVERGEN — buscá la transcendental antes de seguir"; exit 1; }
echo "OK: misma simulación en los dos targets"
