// T9 — Lo que hará el navegador: instanciar, avanzar 600 ticks y leer el estado
// como Float32Array sobre la memoria del wasm. Sin glue, sin copias por frame.
import { readFileSync } from "node:fs";

const wasm = "target/wasm32-unknown-unknown/release/engine.wasm";
const { exports: e } = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(wasm)), {});

const g = e.create(1, 0);
const len = e.state_len();
const view = () => new Float32Array(e.memory.buffer, e.state_ptr(g), len);

const HEADER = 6, ACTOR = 9;
const arena = [e.arena_width(), e.arena_height()];
const estaticos = e.arena_statics(g);

const player = 0x08;        // moviéndose en dirección 0
const boss = (1 << 6) | 32; // moviéndose en dirección 180°
for (let i = 0; i < 600; i++) {
  if (e.step_tick(g, player, boss, 0) !== 1) throw new Error(`step ${i} rechazado`);
}

const s = view();
const [px, py] = [s[HEADER], s[HEADER + 1]];
const [bx, by] = [s[HEADER + ACTOR], s[HEADER + ACTOR + 1]];

console.log(`arena ${arena[0]}x${arena[1]}, ${estaticos} estáticos`);
console.log(`tick=${s[0]} jugador=(${px.toFixed(2)}, ${py.toFixed(2)}) boss=(${bx.toFixed(2)}, ${by.toFixed(2)})`);

const dentro = (x, y) => x > 0 && x < arena[0] && y > 0 && y < arena[1];
if (s[0] !== 600) throw new Error("no avanzó 600 ticks");
if (!dentro(px, py) || !dentro(bx, by)) throw new Error("posiciones fuera de la arena");
if (!(px > 4) || !(bx < 28)) throw new Error("nadie se movió");
e.destroy(g);
console.log("OK: 600 ticks con posiciones coherentes");
