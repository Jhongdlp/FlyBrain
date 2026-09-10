import { defineConfig } from "vite";

// El cerebro del boss vive en el Worker. Sin este proxy, `/brain` y `/fight`
// pegan contra el dev server de Vite, dan 404, y los dos `catch` del cliente se
// lo tragan en silencio: el boss arranca en cero cada vez y **ninguna pelea se
// guarda**. Para que aprenda de verdad hacen falta las dos cosas corriendo:
//
//   pnpm run dev                 # desde la raíz: compila el wasm y levanta las dos
//
// A mano, si hace falta:
//   cd worker && npm run dev     # wrangler en :8787, el DO y el verificador
//   cd web    && npm run dev     # vite en :5173, y por acá se juega
const WORKER = `http://127.0.0.1:${process.env.WORKER_PORT ?? 8787}`;

export default defineConfig({
  build: { target: "es2022" },
  server: { proxy: { "/brain": WORKER, "/fight": WORKER } },
});
