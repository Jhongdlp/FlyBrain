#!/usr/bin/env bash
# Compila el motor a wasm y levanta el juego. Sin Worker: acá el cerebro no
# vive en un servidor, corre en Python contra `engine.VecEnv`.
set -euo pipefail
cd "$(dirname "$0")/.."

WEB_PORT="${WEB_PORT:-5173}"

if (exec 3<>"/dev/tcp/127.0.0.1/$WEB_PORT") 2>/dev/null; then
  exec 3<&- 3>&-
  echo "ERROR: ya hay algo escuchando en :$WEB_PORT." >&2
  exit 1
fi

bash scripts/build-wasm.sh dev
[ -d web/node_modules ] || (cd web && npm install)

# `--strictPort`: sin esto Vite se corre solo al 5174 y el navegador se queda
# mirando un servidor muerto.
cd web && npx vite --port "$WEB_PORT" --strictPort
