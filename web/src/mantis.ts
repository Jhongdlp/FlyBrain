// Modo Paradoja de la Mantis: un minijuego interactivo donde el jugador
// intenta cazar a la mosca a paso ultra lento sin activar su circuito biológico
// de looming (LC4 + LPLC2 -> DNp01).

import { Actor, Evento, EventKind, Fase, Lado } from "./engine";

/** Radio del jugador (araña) y del boss (mosca). */
const RADIO_JUGADOR = 0.8;
const RADIO_BOSS = 0.9;
/** Umbral de activación de la fibra gigante DNp01. */
const UMBRAL_FIBRA_GIGANTE = 0.42;
/** Constante de tiempo de la membrana (leak) en segundos (~120 ms). */
const TAU_MEMBRANA = 0.12;
/** Ganancia sináptica del looming a corriente neuronal. */
const GANANCIA_LOOMING = 8.5;

export type FaseMantis = "cazando" | "escapada" | "atrapada";

export interface InfoMantis {
  looming: number;
  potencialGf: number;
  umbral: number;
  distancia: number;
  cierre: number;
  velocidadJugador: number;
  esSigilo: boolean;
  fase: FaseMantis;
  escapeEsteTick: boolean;
  tiempoAcechoS: number;
  intentos: number;
  atrapadas: number;
  moscaPaseando: boolean;
}

export class ModoMantis {
  private jugador: Actor;
  private boss: Actor;
  private potencialGf = 0;
  private fase: FaseMantis = "cazando";
  private tick = 0;
  private tiempoInicio = 0;
  private intentos = 0;
  private atrapadas = 0;
  private escapeEsteTick = false;

  // Locomoción biológica intermitente de la mosca (bouts de caminata y pausas)
  private tiempoEstadoMosca = 0;
  private duracionEstadoMosca = 2.0;
  private moscaPaseando = false;
  private rumboMosca = Math.PI;

  // Entrada de teclado
  private teclas = new Set<string>();

  // Límites de la arena
  private readonly minX = 2.5;
  private readonly maxX = 29.5;
  private readonly minY = 2.5;
  private readonly maxY = 17.5;

  constructor() {
    this.jugador = {
      x: 6, y: 10, vx: 0, vy: 0, facing: 0, hp: 100,
      fase: Fase.Idle, ticks: 0, slot: 0,
    };
    this.boss = {
      x: 22, y: 10, vx: 0, vy: 0, facing: Math.PI, hp: 100,
      fase: Fase.Idle, ticks: 0, slot: 0,
    };

    window.addEventListener("keydown", (e) => {
      this.teclas.add(e.code);
    });
    window.addEventListener("keyup", (e) => {
      this.teclas.delete(e.code);
    });
  }

  reiniciar(completo = false) {
    if (completo) {
      this.intentos = 0;
      this.atrapadas = 0;
    }
    this.jugador.x = 6;
    this.jugador.y = 10;
    this.jugador.vx = 0;
    this.jugador.vy = 0;
    this.jugador.facing = 0;
    this.jugador.fase = Fase.Idle;

    this.boss.x = 22;
    this.boss.y = 10;
    this.boss.vx = 0;
    this.boss.vy = 0;
    this.boss.facing = Math.PI;
    this.boss.fase = Fase.Idle;

    this.tiempoEstadoMosca = 0;
    this.duracionEstadoMosca = 1.5 + Math.random() * 2.0;
    this.moscaPaseando = false; // Comienza quieta y atenta
    this.rumboMosca = Math.PI;

    this.potencialGf = 0;
    this.fase = "cazando";
    this.escapeEsteTick = false;
    this.tiempoInicio = performance.now();
  }

  actualizar(dt: number): { jugador: Actor; boss: Actor; eventos: Evento[]; info: InfoMantis } {
    this.tick++;
    const dtSegundos = Math.min(dt, 0.05);
    const eventos: Evento[] = [];
    this.escapeEsteTick = false;

    // --- Control del Jugador ---
    let inputX = 0;
    let inputY = 0;
    if (this.teclas.has("KeyW") || this.teclas.has("ArrowUp")) inputY -= 1;
    if (this.teclas.has("KeyS") || this.teclas.has("ArrowDown")) inputY += 1;
    if (this.teclas.has("KeyA") || this.teclas.has("ArrowLeft")) inputX -= 1;
    if (this.teclas.has("KeyD") || this.teclas.has("ArrowRight")) inputX += 1;

    const tieneInput = inputX !== 0 || inputY !== 0;
    const len = Math.hypot(inputX, inputY);
    if (len > 0) {
      inputX /= len;
      inputY /= len;
    }

    const esSigilo = this.teclas.has("ShiftLeft") || this.teclas.has("ShiftRight");
    const velMax = esSigilo ? 0.75 : 3.8;
    const acel = esSigilo ? 6.0 : 16.0;

    if (this.fase === "cazando") {
      if (tieneInput) {
        this.jugador.vx += (inputX * velMax - this.jugador.vx) * Math.min(1, acel * dtSegundos);
        this.jugador.vy += (inputY * velMax - this.jugador.vy) * Math.min(1, acel * dtSegundos);
        this.jugador.facing = Math.atan2(this.jugador.vy, this.jugador.vx);
      } else {
        this.jugador.vx *= Math.max(0, 1 - 12 * dtSegundos);
        this.jugador.vy *= Math.max(0, 1 - 12 * dtSegundos);
      }
    } else {
      this.jugador.vx *= 0.8;
      this.jugador.vy *= 0.8;
    }

    this.jugador.x = Math.max(this.minX, Math.min(this.maxX, this.jugador.x + this.jugador.vx * dtSegundos));
    this.jugador.y = Math.max(this.minY, Math.min(this.maxY, this.jugador.y + this.jugador.vy * dtSegundos));

    const velJugador = Math.hypot(this.jugador.vx, this.jugador.vy);

    // --- Locomoción Biológica de la Mosca (Caminata vs Pausa) ---
    if (this.fase === "cazando") {
      this.tiempoEstadoMosca += dtSegundos;
      if (this.tiempoEstadoMosca >= this.duracionEstadoMosca) {
        this.tiempoEstadoMosca = 0;
        this.moscaPaseando = !this.moscaPaseando;
        if (this.moscaPaseando) {
          // Camina en ráfagas de 1.5 a 3.5 segundos
          this.duracionEstadoMosca = 1.5 + Math.random() * 2.0;
          this.rumboMosca += (Math.random() - 0.5) * 1.6;
        } else {
          // Pausa / reposo / acicalamiento durante 2.0 a 4.0 segundos
          this.duracionEstadoMosca = 2.0 + Math.random() * 2.0;
          this.boss.vx = 0;
          this.boss.vy = 0;
        }
      }

      if (this.moscaPaseando) {
        // Giro suave al acercarse a los bordes de la mesa
        const margen = 3.5;
        const centroX = (this.minX + this.maxX) / 2;
        const centroY = (this.minY + this.maxY) / 2;
        if (this.boss.x < this.minX + margen || this.boss.x > this.maxX - margen ||
            this.boss.y < this.minY + margen || this.boss.y > this.maxY - margen) {
          const anguloAlCentro = Math.atan2(centroY - this.boss.y, centroX - this.boss.x);
          let diff = (anguloAlCentro - this.rumboMosca + Math.PI * 3) % (Math.PI * 2) - Math.PI;
          this.rumboMosca += diff * Math.min(1, 4.0 * dtSegundos);
        } else {
          this.rumboMosca += (Math.random() - 0.5) * 0.4 * dtSegundos;
        }

        const velPaseo = 2.1;
        this.boss.vx = Math.cos(this.rumboMosca) * velPaseo;
        this.boss.vy = Math.sin(this.rumboMosca) * velPaseo;
        this.boss.facing = this.rumboMosca;
        this.boss.x = Math.max(this.minX, Math.min(this.maxX, this.boss.x + this.boss.vx * dtSegundos));
        this.boss.y = Math.max(this.minY, Math.min(this.maxY, this.boss.y + this.boss.vy * dtSegundos));
      } else {
        // En reposo: frenada
        this.boss.vx *= Math.max(0, 1 - 10 * dtSegundos);
        this.boss.vy *= Math.max(0, 1 - 10 * dtSegundos);
      }
    } else if (this.fase === "escapada") {
      // Movimiento durante el salto de escape
      this.boss.x = Math.max(this.minX, Math.min(this.maxX, this.boss.x + this.boss.vx * dtSegundos));
      this.boss.y = Math.max(this.minY, Math.min(this.maxY, this.boss.y + this.boss.vy * dtSegundos));
      this.boss.vx *= Math.max(0, 1 - 4 * dtSegundos);
      this.boss.vy *= Math.max(0, 1 - 4 * dtSegundos);

      if (Math.hypot(this.boss.vx, this.boss.vy) < 0.3) {
        this.boss.fase = Fase.Idle;
        this.fase = "cazando";
        this.moscaPaseando = false;
        this.tiempoEstadoMosca = 0;
        this.duracionEstadoMosca = 2.5;
      }
    }

    // --- Física biológica del Looming (expansión angular) ---
    const dx = this.boss.x - this.jugador.x;
    const dy = this.boss.y - this.jugador.y;
    const distancia = Math.hypot(dx, dy);

    // Cierre: velocidad relativa proyectada en el vector hacia el boss
    const velRelX = this.jugador.vx - this.boss.vx;
    const velRelY = this.jugador.vy - this.boss.vy;
    let cierre = 0;
    let looming = 0;

    if (distancia > RADIO_JUGADOR + RADIO_BOSS) {
      cierre = (velRelX * dx + velRelY * dy) / distancia;
      if (cierre > 0) {
        // dθ/dt = 2 * r * v / d²
        looming = (2 * RADIO_JUGADOR * cierre) / (distancia * distancia);
      }
    }

    // --- Integrador Leaky Integrate-and-Fire en DNp01 ---
    const leak = Math.exp(-dtSegundos / TAU_MEMBRANA);
    this.potencialGf = this.potencialGf * leak + GANANCIA_LOOMING * looming * dtSegundos;

    // --- Detección de Disparo o Captura ---
    if (this.fase === "cazando") {
      if (this.potencialGf >= UMBRAL_FIBRA_GIGANTE) {
        this.fase = "escapada";
        this.intentos++;
        this.escapeEsteTick = true;
        this.boss.fase = Fase.Dodging;

        // Salto de escape hacia el lado opuesto al jugador
        const anguloEscape = Math.atan2(this.boss.y - this.jugador.y, this.boss.x - this.jugador.x);
        this.boss.facing = anguloEscape;
        const impulso = 13.0;
        this.boss.vx = Math.cos(anguloEscape) * impulso;
        this.boss.vy = Math.sin(anguloEscape) * impulso;

        eventos.push({
          kind: EventKind.Telegraph,
          lado: Lado.Boss,
          slot: 4, // Dash
          dano: 0,
          forma: null,
        });
      } else if (distancia <= RADIO_JUGADOR + RADIO_BOSS + 0.3) {
        // Victoria en sigilo
        this.fase = "atrapada";
        this.atrapadas++;
        this.jugador.fase = Fase.Active;
        this.boss.hp = 0;
        this.boss.vx = 0;
        this.boss.vy = 0;

        eventos.push({
          kind: EventKind.Hit,
          lado: Lado.Jugador,
          slot: 0,
          dano: 100,
          forma: null,
        });
      }
    }

    const tiempoAcechoS = Math.max(0, (performance.now() - this.tiempoInicio) / 1000);

    return {
      jugador: this.jugador,
      boss: this.boss,
      eventos,
      info: {
        looming,
        potencialGf: Math.min(1.0, this.potencialGf / UMBRAL_FIBRA_GIGANTE),
        umbral: UMBRAL_FIBRA_GIGANTE,
        distancia,
        cierre,
        velocidadJugador: velJugador,
        esSigilo,
        fase: this.fase,
        escapeEsteTick: this.escapeEsteTick,
        tiempoAcechoS,
        intentos: this.intentos,
        atrapadas: this.atrapadas,
        moscaPaseando: this.moscaPaseando,
      },
    };
  }
}
