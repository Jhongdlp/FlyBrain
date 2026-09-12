// El bucle principal. Soporta dos modos:
// 1. "Paradoja de la Mantis" (En vivo): el jugador controla a la araña en tiempo
//    real intentando acercarse a la mosca en reposo sin activar su reflejo de escape (DNp01).
// 2. "Repetición": reproduce tick a tick una pelea grabada contra el motor determinista.

import { EventKind, Evento, Fase, Lado, Motor, Estado } from "./engine";
import { Cerebro } from "./cerebro";
import { Ojo } from "./ojo";
import { Render } from "./render";
import { ModoMantis } from "./mantis";
import { Grafica } from "./grafica";
import { AudioBaile } from "./audio_baile";
import { Neuroestimulador, CANALES_INFO, PRESETS, type CanalId } from "./neuroestimulador";

/** Paso fijo, el mismo que el motor. */
const DT_MS = 1000 / 60;
const MAX_ATRASO = 5;

type ModoJuego = "mantis" | "replay" | "baile" | "neuro";

async function main() {
  // Elementos comunes
  const tel = document.getElementById("tel")!;
  const fin = document.getElementById("fin")!;
  const barraJugador = document.getElementById("playerHp")!;
  const barraBoss = document.getElementById("bossHp")!;
  const hud = document.getElementById("hud")!;

  // Botones de modo
  const btnMantis = document.getElementById("btnMantis") as HTMLButtonElement;
  const btnReplay = document.getElementById("btnReplay") as HTMLButtonElement;
  const btnBaile = document.getElementById("btnBaile") as HTMLButtonElement;

  // Elementos de Mantis y Telemetría
  const mantisPanel = document.getElementById("mantisPanel")!;
  const replayPanel = document.getElementById("replayPanel");
  const replayInfo = document.getElementById("replayInfo");
  const mantisLoomVal = document.getElementById("mantisLoomVal")!;
  const mantisLoomBar = document.getElementById("mantisLoomBar")!;
  const mantisDist = document.getElementById("mantisDist")!;
  const mantisCierre = document.getElementById("mantisCierre")!;
  const mantisGf = document.getElementById("mantisGf")!;
  const mantisEstadoTexto = document.getElementById("mantisEstadoTexto")!;

  // Elementos de Baile
  const bailePanel = document.getElementById("bailePanel")!;
  const bailePaso = document.getElementById("bailePaso")!;
  const baileCircuito = document.getElementById("baileCircuito")!;
  const baileBeatBar = document.getElementById("baileBeatBar")!;
  const baileTiempo = document.getElementById("baileTiempo")!;
  const btnPlayBaile = document.getElementById("btnPlayBaile") as HTMLButtonElement;
  const btnReiniciarBaile = document.getElementById("btnReiniciarBaile") as HTMLButtonElement;
  const hudBaile = document.getElementById("hudBaile")!;
  const hudBailePaso = document.getElementById("hudBailePaso")!;
  const hudBaileCircuito = document.getElementById("hudBaileCircuito")!;
  const hudBaileDisparos = document.getElementById("hudBaileDisparos");
  const baileVistaSelector = document.getElementById("baileVistaSelector")!;
  const btnVistaNormal = document.getElementById("btnVistaNormal") as HTMLButtonElement;
  const btnVistaDual = document.getElementById("btnVistaDual") as HTMLButtonElement;
  const btnVistaCerebro = document.getElementById("btnVistaCerebro") as HTMLButtonElement;

  type VistaBaile = "normal" | "dual" | "cerebro";
  let vistaBaileActual: VistaBaile = "normal";

  function cambiarVistaBaile(nueva: VistaBaile) {
    vistaBaileActual = nueva;
    document.body.classList.remove("vista-normal", "vista-dual", "vista-cerebro");
    document.body.classList.add(`vista-${nueva}`);
    btnVistaNormal?.classList.toggle("activo", nueva === "normal");
    btnVistaDual?.classList.toggle("activo", nueva === "dual");
    btnVistaCerebro?.classList.toggle("activo", nueva === "cerebro");
    setTimeout(() => {
      render.encuadrarBaile();
    }, 50);
  }

  if (btnVistaNormal) btnVistaNormal.onclick = () => cambiarVistaBaile("normal");
  if (btnVistaDual) btnVistaDual.onclick = () => cambiarVistaBaile("dual");
  if (btnVistaCerebro) btnVistaCerebro.onclick = () => cambiarVistaBaile("cerebro");

  // Audio controlador de baile
  const audioBaile = new AudioBaile("/baile.mp3");
  let baileTick = 0;

  // Neuroestimulador & Secuenciador
  const btnNeuro = document.getElementById("btnNeuro") as HTMLButtonElement;
  const neuroPanel = document.getElementById("neuroPanel")!;
  const neuroPadsGrid = document.getElementById("neuroPadsGrid")!;
  const neuroMatrixWrap = document.getElementById("neuroMatrixWrap")!;
  const neuroStepIndicator = document.getElementById("neuroStepIndicator")!;
  const btnPlayNeuro = document.getElementById("btnPlayNeuro") as HTMLButtonElement;
  const btnClearNeuro = document.getElementById("btnClearNeuro") as HTMLButtonElement;
  const selPresetNeuro = document.getElementById("selPresetNeuro") as HTMLSelectElement;
  const sliderBpmNeuro = document.getElementById("sliderBpmNeuro") as HTMLInputElement;
  const valBpmNeuro = document.getElementById("valBpmNeuro")!;
  const sliderPotenciaNeuro = document.getElementById("sliderPotenciaNeuro") as HTMLInputElement;
  const valPotenciaNeuro = document.getElementById("valPotenciaNeuro")!;
  const hudNeuro = document.getElementById("hudNeuro")!;
  const hudNeuroTitulo = document.getElementById("hudNeuroTitulo")!;
  const hudNeuroCanales = document.getElementById("hudNeuroCanales")!;
  const hudNeuroDisparos = document.getElementById("hudNeuroDisparos")!;

  const neuro = new Neuroestimulador();
  let neuroTick = 0;

  const padBotones: Map<CanalId, HTMLButtonElement> = new Map();
  const celdasMatriz: Map<string, HTMLDivElement> = new Map();

  if (neuroPadsGrid) {
    CANALES_INFO.forEach((c) => {
      const pad = document.createElement("button");
      pad.className = "pad-btn";
      pad.innerHTML = `<span style="color:${c.color}; font-weight:bold;">[${c.tecla}] ${c.nombreCorto}</span><br/><span style="font-size:7px; opacity:0.75;">${c.descripcion.slice(0, 19)}</span>`;
      pad.title = `${c.nombreLargo} - Key [${c.tecla}]`;
      pad.onpointerdown = (ev) => {
        ev.preventDefault();
        neuro.dispararCanal(c.id);
      };
      neuroPadsGrid.appendChild(pad);
      padBotones.set(c.id, pad);
    });
  }

  function actualizarCeldaVisual(el: HTMLElement, color: string, activo: boolean) {
    if (activo) {
      el.style.backgroundColor = color;
      el.style.borderColor = color;
      el.style.boxShadow = `0 0 6px ${color}`;
    } else {
      el.style.backgroundColor = "";
      el.style.borderColor = "";
      el.style.boxShadow = "";
    }
  }

  if (neuroMatrixWrap) {
    CANALES_INFO.forEach((c) => {
      const fila = document.createElement("div");
      fila.className = "seq-row";

      const label = document.createElement("div");
      label.className = "seq-label";
      label.style.color = c.color;
      label.textContent = c.nombreCorto;
      label.title = c.nombreLargo;
      fila.appendChild(label);

      const stepsWrap = document.createElement("div");
      stepsWrap.className = "seq-steps";

      for (let paso = 0; paso < 16; paso++) {
        const celda = document.createElement("div");
        celda.className = "seq-step" + (paso % 4 === 0 && paso > 0 ? " beat-start" : "");
        celda.dataset.canal = c.id;
        celda.dataset.paso = String(paso);
        celda.title = `${c.nombreCorto} - Step ${paso + 1}`;

        celda.onclick = () => {
          const activo = neuro.alternarPaso(c.id, paso);
          actualizarCeldaVisual(celda, c.color, activo);
        };

        stepsWrap.appendChild(celda);
        celdasMatriz.set(`${c.id}_${paso}`, celda);
      }

      fila.appendChild(stepsWrap);
      neuroMatrixWrap.appendChild(fila);
    });
  }

  function sincronizarTodaLaMatriz() {
    CANALES_INFO.forEach((c) => {
      for (let paso = 0; paso < 16; paso++) {
        const celda = celdasMatriz.get(`${c.id}_${paso}`);
        if (celda) {
          const activo = neuro.obtenerEstadoPaso(c.id, paso);
          actualizarCeldaVisual(celda, c.color, activo);
        }
      }
    });
    if (sliderBpmNeuro) sliderBpmNeuro.value = String(neuro.getBpm());
    if (valBpmNeuro) valBpmNeuro.textContent = String(neuro.getBpm());
  }

  sincronizarTodaLaMatriz();

  if (btnPlayNeuro) {
    btnPlayNeuro.onclick = () => {
      const play = neuro.alternarReproduccion();
      btnPlayNeuro.textContent = play ? "pause [space]" : "start [space]";
      btnPlayNeuro.style.background = play ? "#102618" : "#161616";
      btnPlayNeuro.style.borderColor = play ? "#00ff88" : "#333";
    };
  }

  if (btnClearNeuro) {
    btnClearNeuro.onclick = () => {
      neuro.limpiarRejilla();
      sincronizarTodaLaMatriz();
    };
  }

  if (selPresetNeuro) {
    selPresetNeuro.onchange = () => {
      const idx = parseInt(selPresetNeuro.value, 10);
      neuro.cargarPresetPorIndice(idx);
      sincronizarTodaLaMatriz();
      const preset = PRESETS[idx];
      if (preset) {
        if (sliderBpmNeuro) sliderBpmNeuro.value = String(preset.bpm);
        if (valBpmNeuro) valBpmNeuro.textContent = String(preset.bpm);
        if (hudNeuroTitulo) hudNeuroTitulo.textContent = preset.nombre;
      }
    };
  }

  if (sliderBpmNeuro) {
    sliderBpmNeuro.oninput = () => {
      const bpm = parseInt(sliderBpmNeuro.value, 10);
      neuro.setBpm(bpm);
      if (valBpmNeuro) valBpmNeuro.textContent = String(bpm);
    };
  }

  if (sliderPotenciaNeuro) {
    sliderPotenciaNeuro.oninput = () => {
      const pot = parseInt(sliderPotenciaNeuro.value, 10);
      neuro.setIntensidad(pot / 100);
      if (valPotenciaNeuro) valPotenciaNeuro.textContent = `${pot}%`;
    };
  }

  // Gráfica de osciloscopio
  const canvasGrafica = document.getElementById("graficaCanvas") as HTMLCanvasElement;
  const grafica = canvasGrafica ? new Grafica(canvasGrafica) : null;

  // Modal Mantis
  const modalMantis = document.getElementById("modalMantis")!;
  const modalStats = document.getElementById("modalStats")!;
  const btnReintentarMantis = document.getElementById("btnReintentarMantis")!;
  const btnCompartirMantis = document.getElementById("btnCompartirMantis")!;

  // Motor y Render
  const motor = await Motor.cargar("/engine.wasm", 0n);
  const render = new Render(document.getElementById("juego")!, motor.ancho, motor.alto, motor.estaticos);

  // Cerebro 3D
  const panelCerebro = document.getElementById("cerebro")!;
  const lectura = document.getElementById("lectura")!;
  const escape = document.getElementById("escape")!;
  const agrandar = document.getElementById("agrandar");
  const esconder = document.getElementById("esconder");

  if (agrandar) {
    agrandar.onclick = () => {
      panelCerebro.classList.remove("oculto");
      agrandar.textContent = panelCerebro.classList.toggle("grande") ? "⤡" : "⤢";
    };
  }
  if (esconder) {
    esconder.onclick = () => {
      const oculto = panelCerebro.classList.toggle("oculto");
      esconder.textContent = oculto ? "cerebro ▸" : "–";
      if (agrandar) agrandar.hidden = oculto;
    };
  }

  const panelOjo = document.getElementById("ojo")!;

  // Determinar modo inicial (por defecto Mantis salvo que se pida ?pelea= o ?modo=replay)
  const params = new URLSearchParams(location.search);
  const peleaParam = params.get("pelea");
  const modoParam = params.get("modo");
  let modoActual: ModoJuego = (peleaParam || modoParam === "replay")
    ? "replay"
    : (modoParam === "baile" ? "baile" : (modoParam === "neuro" ? "neuro" : "mantis"));

  // Instancia de Mantis
  const mantis = new ModoMantis();
  let mantisTick = 0;
  let ultimoTextoCompartir = "";

  // Cerebro en vivo
  let cerebro: Cerebro | null = null;
  let ojo: Ojo | null = null;

  // Estado Replay
  let grabacion: Uint8Array | null = null;
  let ticksReplay = 0;
  let cualPelea = peleaParam ?? "fight_0";
  let estadoReplay = motor.estado();
  let hp0 = { jugador: 100, boss: 100 };
  let corriendo = true;

  const marcador = [
    { aciertos: 0, intentos: 0 },
    { aciertos: 0, intentos: 0 },
  ];

  function anotar(eventos: Evento[]) {
    for (const ev of eventos) {
      const m = marcador[ev.lado];
      if (ev.kind === EventKind.Hit) { m.aciertos++; m.intentos++; }
      else if (ev.kind === EventKind.Whiff || ev.kind === EventKind.Absorbed) m.intentos++;
    }
  }

  // --- Cargar Modo Replay ---
  async function iniciarReplay(pelea: string) {
    cualPelea = pelea;
    tel.textContent = "loading recording…";
    const r = await fetch(`/${cualPelea}.bin`, { cache: "no-store" });
    if (!r.ok) {
      tel.textContent = `failed to load fight (${r.status})`;
      return;
    }
    grabacion = new Uint8Array(await r.arrayBuffer());
    ticksReplay = motor.cargarPelea(grabacion);
    render.actualizarEstaticos(motor.estaticos);
    estadoReplay = motor.estado();
    hp0 = { jugador: estadoReplay.jugador.hp, boss: estadoReplay.boss.hp };
    for (const m of marcador) m.aciertos = m.intentos = 0;

    cerebro = await Cerebro.cargar(panelCerebro, cualPelea);
    if (cerebro) {
      panelCerebro.hidden = false;
      document.getElementById("neuronas")!.textContent = "164,506 neurons";
    }

    ojo = await Ojo.cargar(panelOjo.querySelector("canvas")!, cualPelea);
    panelOjo.hidden = !ojo;
    if (replayInfo) replayInfo.textContent = `${cualPelea} · ${ticksReplay} ticks`;

    corriendo = true;
    fin.style.display = "none";
  }

  // --- Cargar Modo Mantis ---
  async function iniciarMantis() {
    modalMantis.style.display = "none";
    render.actualizarEstaticos([]);
    mantis.reiniciar();
    mantisTick = 0;
    grafica?.reiniciar();

    // Cargar también la retina real de la mosca en vivo
    ojo = await Ojo.cargar(panelOjo.querySelector("canvas")!, "ojo");
    panelOjo.hidden = !ojo;

    // Cargar cerebro del conectoma para estimulación en vivo
    cerebro = await Cerebro.cargarEnVivo(panelCerebro);
    if (cerebro) {
      panelCerebro.hidden = false;
      document.getElementById("neuronas")!.textContent = "164,506 neurons (live)";
    }

    hp0 = { jugador: 100, boss: 100 };
    corriendo = true;
  }

  // --- Cargar Modo Baile ---
  async function iniciarBaile() {
    modalMantis.style.display = "none";
    render.actualizarEstaticos([]);
    render.encuadrarBaile();
    baileTick = 0;
    grafica?.reiniciar();

    if (!cerebro) {
      cerebro = await Cerebro.cargarEnVivo(panelCerebro);
      if (cerebro) {
        panelCerebro.hidden = false;
        document.getElementById("neuronas")!.textContent = "164,506 neurons (live)";
      }
    }

    ojo = await Ojo.cargar(panelOjo.querySelector("canvas")!, "ojo");
    panelOjo.hidden = !ojo;

    const ok = await audioBaile.reproducir();
    btnPlayBaile.textContent = ok ? "pause music" : "play music";
  }

  // --- Cargar Modo Neuro-Lab ---
  async function iniciarNeuro() {
    modalMantis.style.display = "none";
    render.actualizarEstaticos([]);
    render.encuadrarNeuro();
    neuroTick = 0;
    grafica?.reiniciar();

    if (!cerebro) {
      cerebro = await Cerebro.cargarEnVivo(panelCerebro);
      if (cerebro) {
        panelCerebro.hidden = false;
        document.getElementById("neuronas")!.textContent = "164,506 neurons (live)";
      }
    }

    ojo = await Ojo.cargar(panelOjo.querySelector("canvas")!, "ojo");
    panelOjo.hidden = !ojo;
  }

  function cambiarModo(nuevo: ModoJuego) {
    if (modoActual === "baile" && nuevo !== "baile") {
      audioBaile.pausar();
      btnPlayBaile.textContent = "play music";
    }
    if (modoActual === "neuro" && nuevo !== "neuro") {
      neuro.pausar();
      if (btnPlayNeuro) {
        btnPlayNeuro.textContent = "start [space]";
        btnPlayNeuro.style.background = "#161616";
        btnPlayNeuro.style.borderColor = "#333";
      }
    }
    if (nuevo !== "baile" && nuevo !== "neuro") {
      render.restaurarVistaNormal();
      document.body.classList.remove("modo-baile", "modo-neuro", "vista-normal", "vista-dual", "vista-cerebro");
      baileVistaSelector.style.display = "none";
    }

    modoActual = nuevo;
    btnMantis.classList.toggle("activo", nuevo === "mantis");
    btnReplay.classList.toggle("activo", nuevo === "replay");
    btnBaile.classList.toggle("activo", nuevo === "baile");
    btnNeuro?.classList.toggle("activo", nuevo === "neuro");
    grafica?.reiniciar();

    if (nuevo === "mantis") {
      document.body.classList.remove("modo-baile", "modo-neuro", "vista-normal", "vista-dual", "vista-cerebro");
      baileVistaSelector.style.display = "none";
      hud.style.display = "none";
      hudBaile.style.display = "none";
      hudNeuro.style.display = "none";
      mantisPanel.style.display = "flex";
      bailePanel.style.display = "none";
      neuroPanel.style.display = "none";
      if (replayPanel) replayPanel.style.display = "none";
      iniciarMantis();
    } else if (nuevo === "replay") {
      document.body.classList.remove("modo-baile", "modo-neuro", "vista-normal", "vista-dual", "vista-cerebro");
      baileVistaSelector.style.display = "none";
      hud.style.display = "block";
      hudBaile.style.display = "none";
      hudNeuro.style.display = "none";
      mantisPanel.style.display = "none";
      bailePanel.style.display = "none";
      neuroPanel.style.display = "none";
      if (replayPanel) replayPanel.style.display = "flex";
      modalMantis.style.display = "none";
      iniciarReplay(cualPelea);
    } else if (nuevo === "baile") {
      document.body.classList.remove("modo-neuro");
      document.body.classList.add("modo-baile", `vista-${vistaBaileActual}`);
      baileVistaSelector.style.display = "flex";
      hud.style.display = "none";
      hudBaile.style.display = "block";
      hudNeuro.style.display = "none";
      mantisPanel.style.display = "none";
      neuroPanel.style.display = "none";
      if (replayPanel) replayPanel.style.display = "none";
      bailePanel.style.display = "flex";
      modalMantis.style.display = "none";
      iniciarBaile();
    } else {
      document.body.classList.remove("modo-baile");
      document.body.classList.add("modo-neuro", `vista-${vistaBaileActual}`);
      baileVistaSelector.style.display = "flex";
      hud.style.display = "none";
      hudBaile.style.display = "none";
      hudNeuro.style.display = "block";
      mantisPanel.style.display = "none";
      bailePanel.style.display = "none";
      if (replayPanel) replayPanel.style.display = "none";
      neuroPanel.style.display = "flex";
      modalMantis.style.display = "none";
      iniciarNeuro();
    }
  }

  btnMantis.onclick = () => cambiarModo("mantis");
  btnReplay.onclick = () => cambiarModo("replay");
  btnBaile.onclick = () => cambiarModo("baile");
  if (btnNeuro) btnNeuro.onclick = () => cambiarModo("neuro");

  btnPlayBaile.onclick = async () => {
    if (audioBaile.estaReproduciendo()) {
      audioBaile.pausar();
      btnPlayBaile.textContent = "play music";
    } else {
      const ok = await audioBaile.reproducir();
      btnPlayBaile.textContent = ok ? "pause music" : "play music";
    }
  };

  btnReiniciarBaile.onclick = async () => {
    audioBaile.reiniciar();
    const ok = await audioBaile.reproducir();
    btnPlayBaile.textContent = ok ? "pause music" : "play music";
    grafica?.reiniciar();
    baileTick = 0;
  };

  btnReintentarMantis.onclick = () => {
    modalMantis.style.display = "none";
    mantis.reiniciar();
  };

  btnCompartirMantis.onclick = async () => {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(ultimoTextoCompartir);
      btnCompartirMantis.textContent = "copied";
      setTimeout(() => {
        btnCompartirMantis.textContent = "copy result";
      }, 2500);
    }
  };

  // Teclado global
  addEventListener("keydown", (ev) => {
    if (ev.code === "KeyR") {
      if (modoActual === "baile") {
        audioBaile.reiniciar();
        audioBaile.reproducir();
        grafica?.reiniciar();
        baileTick = 0;
      } else if (modoActual === "neuro") {
        neuro.reiniciar();
        sincronizarTodaLaMatriz();
        grafica?.reiniciar();
      } else if (modoActual === "mantis") {
        modalMantis.style.display = "none";
        mantis.reiniciar();
        grafica?.reiniciar();
      } else if (grabacion) {
        motor.cargarPelea(grabacion);
        estadoReplay = motor.estado();
        for (const m of marcador) m.aciertos = m.intentos = 0;
        cerebro?.reiniciar();
        grafica?.reiniciar();
        fin.style.display = "none";
        corriendo = true;
      }
    } else if (ev.code === "Space") {
      if (modoActual === "baile") {
        ev.preventDefault();
        if (audioBaile.estaReproduciendo()) {
          audioBaile.pausar();
          btnPlayBaile.textContent = "play music";
        } else {
          audioBaile.reproducir().then((ok) => {
            btnPlayBaile.textContent = ok ? "pause music" : "play music";
          });
        }
      } else if (modoActual === "neuro") {
        ev.preventDefault();
        const play = neuro.alternarReproduccion();
        if (btnPlayNeuro) {
          btnPlayNeuro.textContent = play ? "pause [space]" : "start [space]";
          btnPlayNeuro.style.background = play ? "#102618" : "#161616";
          btnPlayNeuro.style.borderColor = play ? "#00ff88" : "#333";
        }
      } else if (modoActual === "replay") {
        ev.preventDefault();
        corriendo = !corriendo;
      }
    } else if (modoActual === "neuro") {
      const num = parseInt(ev.key, 10);
      if (!isNaN(num) && num >= 1 && num <= 6) {
        const c = CANALES_INFO[num - 1];
        if (c) {
          ev.preventDefault();
          neuro.dispararCanal(c.id);
        }
      }
    }
  });

  // Inicializar el modo elegido
  cambiarModo(modoActual);

  // --- Bucle de render y animación ---
  let reloj = performance.now();
  let deuda = 0;

  function frame(ahora: number) {
    requestAnimationFrame(frame);
    const dt = Math.min((ahora - reloj) / 1000, 0.05);
    deuda += ahora - reloj;
    reloj = ahora;

    if (modoActual === "neuro") {
      // --- Lógica Modo Neuro-Lab (Optogenética y Secuenciador) ---
      neuroTick++;
      const res = neuro.actualizar(dt);
      const canales = neuro.obtenerCanales();
      const niveles = neuro.obtenerNiveles();

      // Renderizar mosca con biomecánica acoplada en tiempo real
      render.dibujarNeuro(canales, neuroTick, dt);

      // Actualizar cursor de la matriz (destello de paso en la rejilla)
      if (res.pasoCambiado) {
        if (neuroStepIndicator) {
          neuroStepIndicator.textContent = `step ${String(res.pasoActual + 1).padStart(2, "0")}/16`;
        }
        CANALES_INFO.forEach((c) => {
          for (let p = 0; p < 16; p++) {
            const celda = celdasMatriz.get(`${c.id}_${p}`);
            if (celda) {
              celda.classList.toggle("cursor-activo", p === res.pasoActual);
            }
          }
        });
      }

      // Feedback visual reactivo en pads de disparo
      CANALES_INFO.forEach((c) => {
        const pad = padBotones.get(c.id);
        if (pad) {
          const val = niveles[c.id];
          if (val > 0.05) {
            pad.classList.add("disparando");
            pad.style.borderColor = c.color;
            pad.style.boxShadow = `0 0 10px ${c.color}`;
          } else {
            pad.classList.remove("disparando");
            pad.style.borderColor = "";
            pad.style.boxShadow = "";
          }
        }
      });

      // Estimular conectoma MaleCNS en tiempo real con canales concurrentes
      let totalDisparos = 0;
      if (cerebro && !panelCerebro.classList.contains("oculto")) {
        const l = cerebro.estimularCanales(neuroTick, canales);
        cerebro.dibujar();
        totalDisparos = l.disparos;
        escape.classList.toggle("activa", l.escape);
      }

      ojo?.avanzar(neuroTick);

      // Resumen de circuitos estimulados
      const activosNombres: string[] = [];
      let sumaNivel = 0;
      let primerColor = "#00f0ff";
      for (const c of CANALES_INFO) {
        if (niveles[c.id] > 0.06) {
          activosNombres.push(c.nombreCorto);
          sumaNivel += niveles[c.id];
          if (activosNombres.length === 1) primerColor = c.color;
        }
      }

      const infoStr = activosNombres.length > 0 ? activosNombres.join(" + ") : "RESTING";
      lectura.textContent = `${totalDisparos.toLocaleString("en-US")} spikes · ${infoStr}`;
      grafica?.agregar(Math.min(1.0, sumaNivel / 2), Math.min(1.0, totalDisparos / 8000));

      if (hudNeuroCanales) {
        hudNeuroCanales.textContent = activosNombres.length > 0
          ? `ACTIVE CIRCUITS: ${activosNombres.map((id) => CANALES_INFO.find((x) => x.nombreCorto === id)?.nombreLargo).join(" · ")}`
          : "READY FOR STIMULATION · PRESS [1]-[6] OR START SEQUENCER";
        hudNeuroCanales.style.color = primerColor;
      }
      if (hudNeuroDisparos) {
        hudNeuroDisparos.textContent = `${totalDisparos.toLocaleString("en-US")} ACTIVE NEURONS`;
        hudNeuroDisparos.style.color = primerColor;
        hudNeuroDisparos.style.textShadow = `0 0 14px ${primerColor}`;
      }

      mantisEstadoTexto.textContent = "neuro-lab";
      mantisEstadoTexto.style.color = primerColor;
    } else if (modoActual === "baile") {
      // --- Lógica Modo Baile (Coreografía con Audio Reactivo) ---
      baileTick++;
      const audio = audioBaile.obtenerEstado();
      const info = render.dibujarBaile(audio.tiempo, baileTick, audio.beat, audio.bajo);

      // Color semántico según el circuito activo
      let colorCircuito = "#00f0ff";
      if (info.region === "t2_t3") colorCircuito = "#ff007f";
      else if (info.region === "alas") colorCircuito = "#00ff66";
      else if (info.region === "dopamina") colorCircuito = "#ffb700";
      else if (info.region === "grooming") colorCircuito = "#d866ff";

      if (cerebro && !panelCerebro.classList.contains("oculto")) {
        const l = cerebro.estimularBaile(baileTick, info.region, info.intensidad);
        cerebro.dibujar();
        lectura.textContent = `${l.disparos.toLocaleString("en-US")} spikes · ${info.circuitoNombre}`;
        escape.classList.toggle("activa", l.escape);
        grafica?.agregar(audio.bajo, Math.min(1.0, l.disparos / 10000));
        if (hudBaileDisparos) {
          hudBaileDisparos.textContent = `${l.disparos.toLocaleString("en-US")} ACTIVE NEURONS`;
          hudBaileDisparos.style.color = colorCircuito;
          hudBaileDisparos.style.textShadow = `0 0 14px ${colorCircuito}`;
        }
      }

      ojo?.avanzar(baileTick);

      // UI telemetría de baile con feedback visual cromático
      bailePaso.textContent = info.pasoNombre;
      baileCircuito.textContent = info.circuitoNombre;
      baileCircuito.style.color = colorCircuito;
      hudBailePaso.textContent = info.pasoNombre;
      hudBaileCircuito.textContent = `CONNECTOME: ${info.circuitoNombre}`;
      hudBaileCircuito.style.color = colorCircuito;
      hudBailePaso.style.textShadow = `0 0 16px ${colorCircuito}`;

      const beatPct = Math.round((audio.beat % 1) * 100);
      baileBeatBar.style.width = `${beatPct}%`;
      baileBeatBar.style.backgroundColor = colorCircuito;
      const s = Math.floor(audio.tiempo);
      baileTiempo.textContent = `0:${String(s).padStart(2, "0")} / 0:30`;
      mantisEstadoTexto.textContent = "dance";
      mantisEstadoTexto.style.color = colorCircuito;
    } else if (modoActual === "mantis") {
      // --- Lógica Modo Mantis (En Vivo) ---
      mantisTick++;
      const { jugador, boss, eventos, info } = mantis.actualizar(dt);

      const estadoMantis: Estado = {
        tick: mantisTick,
        terminado: info.fase === "atrapada",
        jugador,
        boss,
        proyectiles: [],
        cajas: [],
        minions: [],
        eventos,
      };

      render.dibujar(estadoMantis, eventos);

      // Estimular panel del cerebro 3D con looming en tiempo real
      if (cerebro && !panelCerebro.classList.contains("oculto")) {
        const l = cerebro.estimularEnVivo(mantisTick, info.looming, info.escapeEsteTick);
        cerebro.dibujar();
        lectura.textContent = `${String(l.disparos).padStart(5)} spikes · ${l.looming} LC4`;
        escape.classList.toggle("activa", l.escape);
      }

      ojo?.avanzar(mantisTick);
      grafica?.agregar(Math.min(1.0, info.looming / 2.5), info.potencialGf);

      // Actualizar telemetría de Mantis
      mantisLoomVal.textContent = `${info.looming.toFixed(2)} rad/s`;
      const loomPct = Math.min(100, Math.round(info.potencialGf * 100));
      mantisLoomBar.style.width = `${loomPct}%`;
      mantisDist.textContent = `${info.distancia.toFixed(1)}`;
      mantisCierre.textContent = `${Math.max(0, info.cierre).toFixed(2)}`;
      mantisGf.textContent = `${loomPct}%`;

      if (info.fase === "escapada") {
        mantisEstadoTexto.textContent = "escape";
      } else if (info.potencialGf > 0.65) {
        mantisEstadoTexto.textContent = "alert";
      } else if (info.esSigilo) {
        mantisEstadoTexto.textContent = "stealth";
      } else {
        mantisEstadoTexto.textContent = "moving";
      }

      // Victoria en Mantis
      if (info.fase === "atrapada" && modalMantis.style.display === "none") {
        modalMantis.style.display = "flex";
        const tiempoStr = info.tiempoAcechoS.toFixed(1);
        const velCierreStr = Math.max(0, info.cierre).toFixed(2);
        modalStats.innerHTML = `
          <div>STALKING TIME: <strong>${tiempoStr} s</strong></div>
          <div>APPROACH VELOCITY: <strong>${velCierreStr} m/s</strong> (Stealth)</div>
          <div>DNP01 SPIKES: <strong>0</strong> (Biologically outsmarted)</div>
          <div>PREVIOUS ATTEMPTS: <strong>${info.intentos}</strong></div>
          <div style="margin-top: 8px; color: #35d6c0;">STATUS: <strong>FLY BRAIN CAPTURED</strong></div>
        `;

        ultimoTextoCompartir = `Drosophila melanogaster captured in FlyBrain (Mantis Paradox)\n` +
          `Stalking: ${tiempoStr}s · Approach: ${velCierreStr} m/s · DNp01: 0 spikes\n` +
          `Can you outsmart a 164,000-neuron connectome? https://flybrain.io`;
      }

    } else {
      // --- Lógica Modo Replay (Original) ---
      const eventos: Evento[] = [];
      let pasos = 0;
      while (corriendo && deuda >= DT_MS && pasos < MAX_ATRASO) {
        deuda -= DT_MS;
        pasos++;
        if (!motor.paso()) {
          corriendo = false;
          fin.style.display = "grid";
          fin.textContent = estadoReplay.boss.hp <= 0 ? "specimen defeated" : "end of recording";
          break;
        }
        estadoReplay = motor.estado();
        eventos.push(...estadoReplay.eventos);
        anotar(estadoReplay.eventos);
      }
      if (deuda > DT_MS * MAX_ATRASO) deuda = 0;

      render.dibujar(estadoReplay, eventos);
      ojo?.avanzar(estadoReplay.tick - 1);

      if (cerebro && !panelCerebro.classList.contains("oculto")) {
        const l = cerebro.avanzar(estadoReplay.tick - 1);
        cerebro.dibujar();
        lectura.textContent = `${String(l.disparos).padStart(5)} spikes · ${l.looming} LC4`;
        escape.classList.toggle("activa", l.escape);
        grafica?.agregar(Math.min(1.0, l.disparos / 8000), l.escape ? 1.0 : Math.min(1.0, l.looming / 30));
      }

      const pct = (hp: number, max: number) => `${Math.max(0, (hp / max) * 100)}%`;
      barraJugador.style.width = pct(estadoReplay.jugador.hp, hp0.jugador);
      barraBoss.style.width = pct(estadoReplay.boss.hp, hp0.boss);

      tel.textContent = [
        `recording ${cualPelea}`,
        `tick ${String(estadoReplay.tick).padStart(4, "0")} / ${ticksReplay}`,
        `phase ${faseDe(estadoReplay.boss.fase)}`,
        `subject ${faseDe(estadoReplay.jugador.fase)}`,
        `pos ${estadoReplay.jugador.x.toFixed(1)} ${estadoReplay.jugador.y.toFixed(1)}`,
        "",
        `specimen ${marcador[Lado.Boss].aciertos}/${marcador[Lado.Boss].intentos}`,
        `subject ${marcador[Lado.Jugador].aciertos}/${marcador[Lado.Jugador].intentos}`,
        "",
        corriendo ? "" : "paused · space continue",
      ].join("\n");
    }
  }

  requestAnimationFrame(frame);
}

const faseDe = (f: Fase) =>
  ["idle", "charging", "active", "recovering", "dodging"][f] ?? "?";

main();
