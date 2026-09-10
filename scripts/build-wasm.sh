#!/usr/bin/env bash
# Compila el motor a wasm y lo deja donde cada consumidor lo espera.
#
# Vite solo resuelve módulos dentro de su propia raíz, así que el .wasm se copia
# en vez de importarse por ruta relativa cruzada.
#
# `build-wasm.sh dev` compila con la feature `dev` (boss con poca vida, para
# iterar la pelea). Va al cliente y al Worker a la vez a propósito: si solo uno
# la lleva, el verificador rechaza todas las peleas.
set -euo pipefail
cd "$(dirname "$0")/.."

FEATURES=()
if [ "${1:-}" = "dev" ]; then
  FEATURES=(--features dev)
  echo "MODO DEV: boss con poca vida. No publiques este .wasm."
  echo "  (los tests del Worker fallan con este build: el fixture golden es de producción)"
fi

cargo build --quiet --release --target wasm32-unknown-unknown "${FEATURES[@]}"
WASM=target/wasm32-unknown-unknown/release/engine.wasm

mkdir -p web/public
cp "$WASM" web/public/engine.wasm
# La pelea que el navegador reproduce por defecto. Va con el .wasm a propósito:
# si el motor cambia y el log no, la reproducción no cuadra.
cp engine/tests/golden/fight_0.bin web/public/fight_0.bin

printf 'engine.wasm: %s bytes (%s gzip)\n' \
  "$(stat -c%s "$WASM")" "$(gzip -9 -c "$WASM" | wc -c)"
