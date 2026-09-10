// El bucle. Carga una pelea grabada, la avanza tick a tick en el motor y le da
// el estado al render.
//
// **El navegador no decide nada.** La acción del boss ya viene en el log —
// producida contra el conectoma en la GPU— y acá solo se reproduce. Una regla
// de juego escrita en TypeScript rompería la reproducibilidad, que es lo único
// que hace que la pelea que se grabó y la que se ve sean la misma.

import { EventKind, Evento, Fase, Lado, Motor } from "./engine";
import { Render } from "./render";

/** Paso fijo, el mismo que el motor. Nunca delta time variable. */
const DT_MS = 1000 / 60;
/** Tope de ticks por frame: tras una pestaña en segundo plano no se recupera
 *  medio minuto de simulación de golpe. */
const MAX_ATRASO = 5;

async function main() {
  const tel = document.getElementById("tel")!;
  const fin = document.getElementById("fin")!;
  const barraJugador = document.getElementById("playerHp")!;
  const barraBoss = document.getElementById("bossHp")!;

  const motor = await Motor.cargar("/engine.wasm", 0n);

  // `?pelea=` para mirar otra grabación. Por defecto, la pelea guionada del
  // golden test: es una pelea real y completa, y es el fixture contra el que
  // se comprueba que reproducir da el mismo mundo bit a bit.
  const cual = new URLSearchParams(location.search).get("pelea") ?? "fight_0";
  const r = await fetch(`/${cual}.bin`, { cache: "no-store" });
  if (!r.ok) {
    tel.textContent = `no se pudo cargar la pelea (HTTP ${r.status})`;
    return;
  }
  const ticks = motor.cargarPelea(new Uint8Array(await r.arrayBuffer()));
  if (ticks === 0) {
    // Casi siempre: el .wasm y el .bin son de builds distintos. Se regeneran
    // juntos con `scripts/build-wasm.sh`.
    tel.textContent = "log ilegible: recompilá motor y grabación juntos";
    return;
  }

  const render = new Render(motor.ancho, motor.alto, motor.estaticos);
  let estado = motor.estado();
  const hp0 = { jugador: estado.jugador.hp, boss: estado.boss.hp };
  let corriendo = true;

  // Espacio pausa. No es una acción del juego —no entra en la simulación—
  // sino una capa de instrumentos encima.
  addEventListener("keydown", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      corriendo = !corriendo;
    }
  });

  let reloj = performance.now();
  let deuda = 0;

  function frame(ahora: number) {
    requestAnimationFrame(frame);
    deuda += ahora - reloj;
    reloj = ahora;

    // Los eventos se acumulan de **todos** los ticks del frame, no solo del
    // último: por debajo de 60fps un frame avanza varios ticks, y si solo se
    // miraran los del último se perderían telegrafías enteras.
    const eventos: Evento[] = [];
    let pasos = 0;
    while (corriendo && deuda >= DT_MS && pasos < MAX_ATRASO) {
      deuda -= DT_MS;
      pasos++;
      if (!motor.paso()) {
        corriendo = false;
        fin.style.display = "grid";
        fin.textContent = estado.boss.hp <= 0 ? "espécimen abatido" : "fin de la grabación";
        break;
      }
      estado = motor.estado();
      eventos.push(...estado.eventos);
      anotar(estado.eventos);
    }
    if (deuda > DT_MS * MAX_ATRASO) deuda = 0;

    render.dibujar(estado, eventos);

    const pct = (hp: number, max: number) => `${Math.max(0, (hp / max) * 100)}%`;
    barraJugador.style.width = pct(estado.jugador.hp, hp0.jugador);
    barraBoss.style.width = pct(estado.boss.hp, hp0.boss);

    tel.textContent = [
      `grabación ${cual}`,
      `tick ${String(estado.tick).padStart(4, "0")} / ${ticks}`,
      `fase ${faseDe(estado.boss.fase)}`,
      `sujeto ${faseDe(estado.jugador.fase)}`,
      `pos ${estado.jugador.x.toFixed(1)} ${estado.jugador.y.toFixed(1)}`,
      "",
      `espécimen ${marcador[Lado.Boss].aciertos}/${marcador[Lado.Boss].intentos}`,
      `sujeto ${marcador[Lado.Jugador].aciertos}/${marcador[Lado.Jugador].intentos}`,
      "",
      corriendo ? "" : "en pausa · ␣ continuar",
    ].join("\n");
  }
  requestAnimationFrame(frame);
}

/** Aciertos sobre intentos por lado. Es la única cifra que dice si el boss de
 *  esta grabación sabe apuntar, que es toda la pregunta del proyecto. */
const marcador = [
  { aciertos: 0, intentos: 0 },
  { aciertos: 0, intentos: 0 },
];

function anotar(eventos: Evento[]) {
  for (const ev of eventos) {
    const m = marcador[ev.lado];
    // Absorbido cuenta como intento fallado: la puntería estuvo bien, la
    // elección de herramienta no.
    if (ev.kind === EventKind.Hit) { m.aciertos++; m.intentos++; }
    else if (ev.kind === EventKind.Whiff || ev.kind === EventKind.Absorbed) m.intentos++;
  }
}

const faseDe = (f: Fase) =>
  ["inactivo", "cargando", "activo", "recuperando", "esquivando"][f] ?? "?";

main();
