// Pegamento fino con el motor. **Cero reglas de juego acá**: si una decisión de
// gameplay vive en TypeScript, se rompen el replay y el entrenamiento a la vez.
// Este archivo lee el buffer plano del wasm y lo expone tipado; nada más.

interface Exports {
  memory: WebAssembly.Memory;
  create(seedLo: number, seedHi: number): number;
  destroy(g: number): void;
  step_tick(g: number, player: number, boss: number, param: number): number;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  load_log(g: number, data: number, len: number): number;
  step_log(g: number): number;
  state_ptr(g: number): number;
  state_len(): number;
  arena_width(): number;
  arena_height(): number;
  arena_statics(g: number): number;
  arena_static(g: number, i: number): number;
}

// Distribución del buffer de estado. Tiene que seguir a `engine/src/wasm.rs`.
const HEADER = 6;
const ACTOR_STRIDE = 9;
const PROJ_STRIDE = 4;
const DYN_STRIDE = 4;
const MINION_STRIDE = 8;
const EVENT_STRIDE = 10;
const MAX_PROJ = 32;
const MAX_DYN = 16;
const MAX_MINIONS = 2;

const OFF_ACTORS = HEADER;
const OFF_PROJ = OFF_ACTORS + 2 * ACTOR_STRIDE;
const OFF_DYN = OFF_PROJ + MAX_PROJ * PROJ_STRIDE;
const OFF_MINIONS = OFF_DYN + MAX_DYN * DYN_STRIDE;
const OFF_EVENTS = OFF_MINIONS + MAX_MINIONS * MINION_STRIDE;

/** Slots del boss: cuatro armas y el dash de esquiva. Sigue a
 *  `engine/src/types.rs`. */
export const N_TOOLS = 5;
/** El dash. No hace daño y no telegrafía: es la decisión defensiva del boss. */
export const DASH = 4;

/** Fase de un actor, tal como la codifica el motor. */
export const enum Fase { Idle = 0, Windup = 1, Active = 2, Recovery = 3, Dodging = 4 }
export const enum EventKind {
  Telegraph = 0, Hit = 1, Whiff = 2, Parried = 3, Death = 4, Absorbed = 5,
  MinionSpawned = 6, MinionDespawned = 7, MinionHit = 8,
  GuardianAbsorbed = 9, ControllerSlowed = 10,
}
export const enum Lado { Jugador = 0, Boss = 1 }
export const enum FormaKind { Circulo = 0, Arco = 1, Rect = 2 }

export interface Actor {
  x: number; y: number; vx: number; vy: number;
  facing: number; hp: number; fase: Fase; ticks: number; slot: number;
}

export interface Forma {
  kind: FormaKind; x: number; y: number; r: number; a: number; b: number;
}

export interface Evento {
  kind: EventKind; lado: Lado; slot: number; dano: number; forma: Forma | null;
}

export interface Estado {
  tick: number;
  terminado: boolean;
  jugador: Actor;
  boss: Actor;
  proyectiles: { x: number; y: number }[];
  cajas: { x: number; y: number; hx: number; hy: number }[];
  minions: { x: number; y: number; vx: number; vy: number; radius: number; hp: number; kind: number; ttl: number }[];
  eventos: Evento[];
}

export interface Estatico { x: number; y: number; hx: number; hy: number }

function leerActor(s: Float32Array, o: number): Actor {
  return {
    x: s[o], y: s[o + 1], vx: s[o + 2], vy: s[o + 3],
    facing: s[o + 4], hp: s[o + 5],
    fase: s[o + 6] as Fase, ticks: s[o + 7], slot: s[o + 8],
  };
}

export class Motor {
  private g: number;
  private len: number;

  readonly ancho: number;
  readonly alto: number;
  /** Los muros de la arena **actual**: se releen al cargar una pelea, que
   *  puede ser de otra arena que la de arranque. */
  estaticos: Estatico[] = [];

  private constructor(private e: Exports, seed: bigint) {
    this.g = e.create(Number(seed & 0xffffffffn), Number((seed >> 32n) & 0xffffffffn));
    this.len = e.state_len();
    this.ancho = e.arena_width();
    this.alto = e.arena_height();
    this.leerEstaticos();
  }

  private leerEstaticos() {
    const e = this.e;
    this.estaticos = [];
    for (let i = 0; i < e.arena_statics(this.g); i++) {
      const p = e.arena_static(this.g, i) / 4;
      const v = new Float32Array(e.memory.buffer, 0, p + 4);
      this.estaticos.push({ x: v[p], y: v[p + 1], hx: v[p + 2], hy: v[p + 3] });
    }
  }

  static async cargar(url: string, seed: bigint): Promise<Motor> {
    const r = await WebAssembly.instantiateStreaming(fetch(url), {});
    return new Motor(r.instance.exports as unknown as Exports, seed);
  }

  /** Carga una pelea grabada y la deja lista para reproducir. Devuelve cuántos
   *  ticks dura, o 0 si el log no decodifica.
   *
   *  El log lo expande el motor, no este archivo: el formato lo define
   *  `engine/src/log.rs`, y una segunda implementación en TypeScript es
   *  exactamente lo que rompe la reproducibilidad. */
  cargarPelea(log: Uint8Array): number {
    const p = this.e.alloc(log.byteLength);
    try {
      new Uint8Array(this.e.memory.buffer, p, log.byteLength).set(log);
      const ticks = this.e.load_log(this.g, p, log.byteLength);
      // El log trae su arena: los muros a dibujar son los de ésa.
      this.leerEstaticos();
      return ticks;
    } finally {
      this.e.dealloc(p, log.byteLength);
    }
  }

  /** Avanza un tick de la pelea cargada. `false` cuando se acabó. */
  paso(): boolean {
    return this.e.step_log(this.g) === 1;
  }

  /**
   * El estado del tick actual. La vista se rehace por frame porque `memory`
   * puede crecer y desanclar el ArrayBuffer; el buffer en sí no se copia.
   */
  estado(): Estado {
    const s = new Float32Array(this.e.memory.buffer, this.e.state_ptr(this.g), this.len);
    const nProj = s[2], nDyn = s[3], nMinions = s[4], nEv = s[5];

    const proyectiles = [];
    for (let i = 0; i < nProj; i++) {
      const o = OFF_PROJ + i * PROJ_STRIDE;
      proyectiles.push({ x: s[o], y: s[o + 1] });
    }
    const cajas = [];
    for (let i = 0; i < nDyn; i++) {
      const o = OFF_DYN + i * DYN_STRIDE;
      cajas.push({ x: s[o], y: s[o + 1], hx: s[o + 2], hy: s[o + 3] });
    }
    const minions = [];
    for (let i = 0; i < nMinions; i++) {
      const o = OFF_MINIONS + i * MINION_STRIDE;
      minions.push({
        x: s[o], y: s[o + 1], vx: s[o + 2], vy: s[o + 3],
        radius: s[o + 4], hp: s[o + 5], kind: s[o + 6], ttl: s[o + 7],
      });
    }
    const eventos: Evento[] = [];
    for (let i = 0; i < nEv; i++) {
      const o = OFF_EVENTS + i * EVENT_STRIDE;
      const kind = s[o] as EventKind;
      eventos.push({
        kind,
        lado: s[o + 1] as Lado,
        slot: s[o + 2],
        dano: s[o + 3],
        forma: kind === EventKind.Telegraph
          ? { kind: s[o + 4] as FormaKind, x: s[o + 5], y: s[o + 6], r: s[o + 7], a: s[o + 8], b: s[o + 9] }
          : null,
      });
    }

    return {
      tick: s[0],
      terminado: s[1] === 1,
      jugador: leerActor(s, OFF_ACTORS),
      boss: leerActor(s, OFF_ACTORS + ACTOR_STRIDE),
      proyectiles,
      cajas,
      minions,
      eventos,
    };
  }

  liberar() {
    this.e.destroy(this.g);
  }
}
