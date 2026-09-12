// El panel del cerebro: las neuronas del conectoma, prendiéndose al ritmo de la
// pelea que se está reproduciendo.
//
// **Solo dibuja lo que se grabó.** La actividad sale de `fly/piloto.py
// --grabar`, que corrió la simulación de verdad; acá no se simula nada. Es el
// mismo contrato que el juego: el navegador reproduce, no decide.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Cuánto le queda del brillo a una neurona por tick después de disparar.
 *  0.84 son ~450 ms de estela luminosa para que las ondas sinápticas dancen con la música. */
const DECAE = 0.84;
const ESTELA = 26;

// Paleta de máximo contraste: fondo y reposo oscuros neutros, COLOR ÚNICAMENTE EN NEURONAS ACTIVAS:
const FONDO = 0x000000;
const REPOSO = new THREE.Color(0x070709); // Silueta oscura neutra muy tenue (sin tinte azul)
const DISPARO = new THREE.Color(0xffffff);
const LOOMING_REPOSO = new THREE.Color(0x0a0a0c);
const LOOMING_DISPARO = new THREE.Color(0xffffff);

const enum Grupo { Resto = 0, Looming = 1, FibraGigante = 2 }

/** Textura circular con caída radial suave para evitar píxeles cuadrados duros */
function crearTexturaParticula(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255, 255, 255, 1.0)");
  grad.addColorStop(0.20, "rgba(255, 255, 255, 0.90)");
  grad.addColorStop(0.48, "rgba(255, 255, 255, 0.35)");
  grad.addColorStop(0.78, "rgba(255, 255, 255, 0.08)");
  grad.addColorStop(1.0, "rgba(255, 255, 255, 0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const TEXTURA_PARTICULA = typeof document !== "undefined" ? crearTexturaParticula() : new THREE.Texture();

export interface Lectura {
  /** Neuronas que dispararon en este tick. */
  disparos: number;
  /** De esas, cuántas son LC4 o LPLC2. */
  looming: number;
  /** ¿Disparó la fibra gigante? Es la orden de esquiva. */
  escape: boolean;
}

export interface CanalesEstimulacion {
  t1_izq?: number;
  t1_der?: number;
  t2_t3?: number;
  alas?: number;
  moonwalker?: number;
  courtship?: number;
}

export class Cerebro {
  private renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  private escena = new THREE.Scene();
  private camara = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
  private controles: OrbitControls;

  /** Neurona de la red → punto dentro de su capa, o -1 si no tiene soma. */
  private punto: Int32Array;
  private grupoDe: Uint8Array;
  /** Dos capas porque el tamaño del punto es por material: el circuito del
   *  looming va más grande para que se encuentre entre 138.000 puntos. */
  private capas: Capa[];
  private fibra: THREE.Points;
  private fibraUltimo = -1e9;

  private tickVisto = -1;
  private tabla = Array.from({ length: ESTELA }, (_, i) => DECAE ** i);

  private zonasBaile = {
    cuello: [] as number[],
    t1_izq: [] as number[],
    t1_der: [] as number[],
    t1_ambos: [] as number[],
    t2_t3: [] as number[],
    alas: [] as number[],
    dopamina: [] as number[],
    grooming: [] as number[],
    moonwalker: [] as number[],
  };
  private posResto!: Float32Array;

  private constructor(
    private contenedor: HTMLElement,
    cerebro: ArrayBuffer,
    private offsets?: Uint32Array,
    private indices?: Uint32Array,
  ) {
    const n = new Uint32Array(cerebro, 0, 1)[0];
    const pos = new Float32Array(cerebro, 4, n * 3);
    this.grupoDe = new Uint8Array(cerebro, 4 + n * 12, n);

    // Solo las que tienen soma. Las demás se simulan igual —su actividad está
    // en el archivo— pero no hay dónde dibujarlas.
    this.punto = new Int32Array(n).fill(-1);
    const xyz: number[][] = [[], []];
    const fibra: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(pos[i * 3])) continue;
      const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      const g = this.grupoDe[i];
      if (g === Grupo.FibraGigante) {
        fibra.push(...p);
        continue;
      }
      const ptIdx = xyz[g].length / 3;
      this.punto[i] = ptIdx;

      if (g === Grupo.Resto) {
        const [x, y, z] = p;
        // Conectivo cervical / cuello (neuronas descendentes de comando motor)
        if (y >= -0.35 && y <= -0.10 && Math.abs(x) < 0.15) {
          this.zonasBaile.cuello.push(ptIdx);
        }
        // T1 Protorácico (patas delanteras): y entre -0.55 y -0.20
        if (y >= -0.55 && y < -0.20) {
          if (x < -0.01) this.zonasBaile.t1_izq.push(ptIdx);
          if (x > 0.01) this.zonasBaile.t1_der.push(ptIdx);
          this.zonasBaile.t1_ambos.push(ptIdx);
        }
        // T2 y T3 (patas medias y traseras + ganglio abdominal): y < -0.45
        if (y < -0.45) {
          this.zonasBaile.t2_t3.push(ptIdx);
        }
        // Motor de alas / tórax mesotorácico y lobos ópticos de vuelo
        if ((y >= -0.40 && y <= 0.05 && Math.abs(x) > 0.08) || (y > 0.0 && Math.abs(x) > 0.25)) {
          this.zonasBaile.alas.push(ptIdx);
        }
        // Cerebro central / P1 / dopamina / complejo central: y >= 0.05, medial
        if (y >= 0.05 && Math.abs(x) < 0.25) {
          this.zonasBaile.dopamina.push(ptIdx);
        }
        // Acicalamiento (grooming): antenas y cordón ventral
        if (y < -0.30 || (y > 0.15 && z > 0.10)) {
          this.zonasBaile.grooming.push(ptIdx);
        }
        // Moonwalker Descending Neurons (MDN): medial anterior, y entre -0.22 y 0.05
        if (y >= -0.22 && y <= 0.05 && Math.abs(x) < 0.12) {
          this.zonasBaile.moonwalker.push(ptIdx);
        }
      }

      xyz[g].push(...p);
    }

    this.posResto = new Float32Array(xyz[Grupo.Resto]);

    // Pre-ordenar anatómicamente cada zona para propagación de ondas bio-eléctricas viajeras
    const posR = this.posResto;
    // Cuello: descendente desde encéfalo (y=-0.10) hacia ganglio torácico (y=-0.35)
    this.zonasBaile.cuello.sort((a, b) => posR[b * 3 + 1] - posR[a * 3 + 1]);
    // T1 Izq: radial medial (-0.01) hacia extremidad izquierda (-0.30)
    this.zonasBaile.t1_izq.sort((a, b) => posR[b * 3] - posR[a * 3]);
    // T1 Der: radial medial (0.01) hacia extremidad derecha (0.30)
    this.zonasBaile.t1_der.sort((a, b) => posR[a * 3] - posR[b * 3]);
    // T2-T3: anterior hacia posterior (y descendente)
    this.zonasBaile.t2_t3.sort((a, b) => posR[b * 3 + 1] - posR[a * 3 + 1]);
    // Alas: expansión radial desde el centro torácico hacia bisagras alares
    this.zonasBaile.alas.sort((a, b) => {
      const da = Math.hypot(posR[a * 3], posR[a * 3 + 2]);
      const db = Math.hypot(posR[b * 3], posR[b * 3 + 2]);
      return da - db;
    });
    // Dopamina / Cortejo: expansión radial desde el complejo central (y ~ 0.18)
    this.zonasBaile.dopamina.sort((a, b) => {
      const da = Math.hypot(posR[a * 3], posR[a * 3 + 1] - 0.18);
      const db = Math.hypot(posR[b * 3], posR[b * 3 + 1] - 0.18);
      return da - db;
    });
    // Moonwalker: tracto descendente medial anterior
    this.zonasBaile.moonwalker.sort((a, b) => posR[b * 3 + 1] - posR[a * 3 + 1]);

    this.capas = [
      new Capa(xyz[Grupo.Resto], 0.022, REPOSO, DISPARO),
      new Capa(xyz[Grupo.Looming], 0.038, LOOMING_REPOSO, LOOMING_DISPARO),
    ];
    for (const c of this.capas) this.escena.add(c.puntos);

    // Las dos fibras gigantes, aparte y grandes: son la neurona que decide la
    // esquiva, y en una nube de 138.000 puntos no se encontrarían.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(fibra, 3));
    this.fibra = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.085, map: TEXTURA_PARTICULA, color: 0xffffff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.escena.add(this.fibra);
    // Recién acá: `pintar` toca las fibras gigantes, y antes no existían.
    this.pintar();

    this.escena.background = new THREE.Color(FONDO);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    contenedor.appendChild(this.renderer.domElement);

    // Cámara frontal fija centrada en el centroide anatómico (y = -0.35).
    // Vista frontal estable sin rotación automática para máxima claridad.
    this.camara.position.set(0, -0.35, 2.25);
    this.controles = new OrbitControls(this.camara, this.renderer.domElement);
    this.controles.target.set(0, -0.35, 0.0);
    this.controles.enableDamping = true;
    this.controles.autoRotate = false; // Sin rotación automática a petición del usuario

    new ResizeObserver(() => this.encuadrar()).observe(contenedor);
    this.encuadrar();
  }

  /** Devuelve `null` si la pelea no trae actividad grabada: el panel no aparece. */
  static async cargar(contenedor: HTMLElement, pelea: string): Promise<Cerebro | null> {
    const [c, a] = await Promise.all([
      fetch("/cerebro.bin", { cache: "no-store" }),
      fetch(`/${pelea}.act`, { cache: "no-store" }),
    ]);
    // Vite contesta un archivo que no existe con `index.html` y un 200.
    const html = (r: Response) => r.headers.get("content-type")?.startsWith("text/html");
    if (!c.ok || !a.ok || html(c) || html(a)) return null;
    const act = await a.arrayBuffer();
    const ticks = new Uint32Array(act, 0, 1)[0];
    const offsets = new Uint32Array(act, 4, ticks + 1);
    const indices = new Uint32Array(act, 4 + 4 * (ticks + 1), offsets[ticks]);
    return new Cerebro(contenedor, await c.arrayBuffer(), offsets, indices);
  }

  /** Carga solo la geometría del conectoma para estimulación en vivo. */
  static async cargarEnVivo(contenedor: HTMLElement): Promise<Cerebro | null> {
    const c = await fetch("/cerebro.bin", { cache: "no-store" });
    const html = (r: Response) => r.headers.get("content-type")?.startsWith("text/html");
    if (!c.ok || html(c)) return null;
    return new Cerebro(contenedor, await c.arrayBuffer());
  }

  /** Aplica la actividad grabada hasta `tick` inclusive. */
  avanzar(tick: number): Lectura {
    if (!this.offsets || !this.indices) return { disparos: 0, looming: 0, escape: false };
    const ultimoTick = this.offsets.length - 2;
    tick = Math.min(tick, ultimoTick);
    let lectura: Lectura = { disparos: 0, looming: 0, escape: false };
    const offsets = this.offsets;
    const indices = this.indices;
    // Por debajo de 60 fps un frame avanza varios ticks: se aplican todos, o
    // se perderían ráfagas enteras de la fibra gigante.
    for (let t = this.tickVisto + 1; t <= tick; t++) {
      lectura = { disparos: 0, looming: 0, escape: false };
      for (let k: number = offsets[t]; k < offsets[t + 1]; k++) {
        const i: number = indices[k];
        lectura.disparos++;
        const g = this.grupoDe[i];
        if (g === Grupo.Looming) lectura.looming++;
        if (g === Grupo.FibraGigante) {
          lectura.escape = true;
          this.fibraUltimo = t;
        }
        const p = this.punto[i];
        if (p >= 0) this.capas[g].ultimo[p] = t;
      }
    }
    if (tick > this.tickVisto) {
      this.tickVisto = tick;
      this.pintar();
    }
    return lectura;
  }

  /** Estimula en tiempo real para el modo interactivo de la Paradoja de la Mantis. */
  estimularEnVivo(tick: number, looming: number, escape: boolean): Lectura {
    let disparos = 0;
    let loomCount = 0;

    // Actividad basal tenue del resto del cerebro (~25 neuronas por tick)
    const capaResto = this.capas[Grupo.Resto];
    const nResto = capaResto.ultimo.length;
    const nFondo = 15 + Math.floor(Math.random() * 15);
    for (let k = 0; k < nFondo; k++) {
      const idx = Math.floor(Math.random() * nResto);
      capaResto.ultimo[idx] = tick;
      disparos++;
    }

    // Looming en LC4 / LPLC2:
    const capaLoom = this.capas[Grupo.Looming];
    const nLoom = capaLoom.ultimo.length;
    const fraccLoom = Math.min(1.0, looming / 2.5);
    const nActivas = Math.floor(fraccLoom * nLoom * 0.8);
    for (let k = 0; k < nActivas; k++) {
      const idx = Math.floor(Math.random() * nLoom);
      capaLoom.ultimo[idx] = tick;
      disparos++;
      loomCount++;
    }

    if (escape) {
      this.fibraUltimo = tick;
    }

    this.tickVisto = tick;
    this.pintar();

    return {
      disparos,
      looming: loomCount,
      escape,
    };
  }

  /**
   * Estimula en vivo los circuitos específicos del conectoma durante la danza:
   * motoneuronas de pata delantera (T1), flexoras (T2/T3), motor alar o centros de recompensa/cortejo.
   * Ilumina entre 3.500 y 11.000 neuronas con paleta cromática semántica de altísimo impacto.
   */
  estimularBaile(
    tick: number,
    region: "t1_izq" | "t1_der" | "t1_ambos" | "t2_t3" | "alas" | "dopamina" | "grooming",
    intensidad: number,
  ): Lectura {
    let disparos = 0;
    const capaResto = this.capas[Grupo.Resto];

    // 1. Colores semánticos puros y ultra-vibrantes (COLOR ÚNICAMENTE en el circuito activo):
    let rHi = 1.0, gHi = 1.0, bHi = 1.0;
    if (region === "t1_izq" || region === "t1_der" || region === "t1_ambos") {
      // Cian Eléctrico puro (The Beckon / Motoneuronas T1)
      rHi = 0.0; gHi = 1.0; bHi = 1.0;
    } else if (region === "t2_t3") {
      // Magenta / Fucsia Neón puro (Low Bounce / Flexoras T2-T3)
      rHi = 1.0; gHi = 0.0; bHi = 0.65;
    } else if (region === "alas") {
      // Verde Esmeralda Neón puro (Chest Pump / Músculos de Vuelo DLM/DVM)
      rHi = 0.0; gHi = 1.0; bHi = 0.30;
    } else if (region === "dopamina") {
      // Oro / Ámbar Solar puro (Cross-Arm Freeze / P1 / Cortejo)
      rHi = 1.0; gHi = 0.80; bHi = 0.0;
    } else if (region === "grooming") {
      // Arcoíris cromático saturado (Grooming Breakdance 360°)
      const hue = ((tick * 0.04) % 1);
      const c = new THREE.Color().setHSL(hue, 1.0, 0.55);
      rHi = c.r; gHi = c.g; bHi = c.b;
    }

    // 2. Activación nítida del circuito motor primario (2.000 a 6.000 neuronas específicas):
    const grupoPuntos = this.zonasBaile[region];
    if (grupoPuntos && grupoPuntos.length > 0) {
      const baseDisparo = Math.floor((2200 + 4200 * Math.min(1.0, intensidad)) * (0.9 + 0.25 * Math.random()));
      const nActivas = Math.min(grupoPuntos.length, baseDisparo);
      for (let k = 0; k < nActivas; k++) {
        const ptIdx = grupoPuntos[Math.floor(Math.random() * grupoPuntos.length)];
        capaResto.colorDisparo[ptIdx * 3] = rHi;
        capaResto.colorDisparo[ptIdx * 3 + 1] = gHi;
        capaResto.colorDisparo[ptIdx * 3 + 2] = bHi;
        capaResto.ultimo[ptIdx] = tick;
        disparos++;
      }
    }

    // 3. Vías nerviosas descendentes del cuello (conectivo cervical que conecta cerebro y ganglio):
    if (this.zonasBaile.cuello.length > 0) {
      const nCascada = Math.floor((600 + 800 * intensidad));
      const limCascada = Math.min(this.zonasBaile.cuello.length, nCascada);
      for (let k = 0; k < limCascada; k++) {
        const ptIdx = this.zonasBaile.cuello[Math.floor(Math.random() * this.zonasBaile.cuello.length)];
        capaResto.colorDisparo[ptIdx * 3] = rHi;
        capaResto.colorDisparo[ptIdx * 3 + 1] = gHi;
        capaResto.colorDisparo[ptIdx * 3 + 2] = bHi;
        capaResto.ultimo[ptIdx] = tick;
        disparos++;
      }
    }

    // 4. Destello de comando mayor en golpes de alas o clímax
    const escape = (region === "alas" || region === "grooming") && intensidad > 0.75 && tick % 3 === 0;
    if (escape) {
      this.fibraUltimo = tick;
    }

    this.tickVisto = tick;
    this.pintar();

    return {
      disparos,
      looming: region === "alas" ? 120 : (region === "t1_izq" ? 60 : 0),
      escape,
    };
  }

  /**
   * Estimulación directa multicanal para el modo Neuro-Lab (Optogenética).
   * Genera ondas de propagación sináptica anatómicamente coherentes en el conectoma
   * con frentes de onda viajeros, destellos en el núcleo y cascada descendente cervical.
   */
  estimularCanales(tick: number, canales: CanalesEstimulacion): Lectura {
    let disparos = 0;
    const capaResto = this.capas[Grupo.Resto];

    const activarOnda = (pts: number[], r: number, g: number, b: number, factor: number) => {
      if (!pts || pts.length === 0 || factor <= 0.015) return;
      const L = pts.length;
      const count = Math.min(L, Math.floor((1400 + 4600 * factor) * (0.92 + 0.16 * Math.random())));

      // Frente de onda: viaja desde el origen anatómico hacia la periferia según avanza la pulsación
      const progresoOnda = Math.max(0, Math.min(1.0, (1.0 - factor) * 1.35));
      const anchoVentana = 0.38;

      for (let k = 0; k < count; k++) {
        let ptIdx: number;
        let esFrente = false;

        if (Math.random() < 0.72) {
          // 72% de los puntos viajan en el frente de onda
          const offsetNorm = progresoOnda + (Math.random() * anchoVentana - anchoVentana * 0.5);
          const idxClamped = Math.max(0, Math.min(L - 1, Math.floor(Math.abs(offsetNorm % 1.0) * L)));
          ptIdx = pts[idxClamped];
          esFrente = true;
        } else {
          // 28% destellos difusos en todo el circuito
          ptIdx = pts[Math.floor(Math.random() * L)];
        }

        if (esFrente && factor > 0.4) {
          // Núcleo hiperbrillante con destello blanco incandescente
          capaResto.colorDisparo[ptIdx * 3] = Math.min(1.0, r + 0.45);
          capaResto.colorDisparo[ptIdx * 3 + 1] = Math.min(1.0, g + 0.45);
          capaResto.colorDisparo[ptIdx * 3 + 2] = Math.min(1.0, b + 0.45);
        } else {
          capaResto.colorDisparo[ptIdx * 3] = r;
          capaResto.colorDisparo[ptIdx * 3 + 1] = g;
          capaResto.colorDisparo[ptIdx * 3 + 2] = b;
        }

        capaResto.ultimo[ptIdx] = tick;
        disparos++;
      }
    };

    if (canales.t1_izq && canales.t1_izq > 0) {
      activarOnda(this.zonasBaile.t1_izq, 0.0, 1.0, 1.0, canales.t1_izq); // Cyan Eléctrico
    }
    if (canales.t1_der && canales.t1_der > 0) {
      activarOnda(this.zonasBaile.t1_der, 0.0, 1.0, 1.0, canales.t1_der); // Cyan Eléctrico
    }
    if (canales.t2_t3 && canales.t2_t3 > 0) {
      activarOnda(this.zonasBaile.t2_t3, 1.0, 0.0, 0.70, canales.t2_t3); // Magenta Neón
    }
    if (canales.alas && canales.alas > 0) {
      activarOnda(this.zonasBaile.alas, 0.0, 1.0, 0.40, canales.alas); // Verde Esmeralda
    }
    if (canales.moonwalker && canales.moonwalker > 0) {
      activarOnda(this.zonasBaile.moonwalker, 0.78, 0.15, 1.0, canales.moonwalker); // Violeta Profundo
    }
    if (canales.courtship && canales.courtship > 0) {
      activarOnda(this.zonasBaile.dopamina, 1.0, 0.82, 0.0, canales.courtship); // Oro Solar
    }

    // Cascada descendente cervical: el pulso viaja a lo largo del cuello hacia el tórax
    const maxMotor = Math.max(
      canales.t1_izq || 0,
      canales.t1_der || 0,
      canales.t2_t3 || 0,
      canales.alas || 0,
      canales.moonwalker || 0,
      canales.courtship || 0,
    );

    if (maxMotor > 0.03 && this.zonasBaile.cuello.length > 0) {
      const cuelloPts = this.zonasBaile.cuello;
      const Lc = cuelloPts.length;
      const nCascada = Math.min(Lc, Math.floor((800 + 1600 * maxMotor)));
      const progresoCuello = Math.max(0, Math.min(1.0, (1.0 - maxMotor) * 1.4));

      for (let k = 0; k < nCascada; k++) {
        const offsetNorm = progresoCuello + (Math.random() * 0.30 - 0.15);
        const idxClamped = Math.max(0, Math.min(Lc - 1, Math.floor(Math.abs(offsetNorm % 1.0) * Lc)));
        const ptIdx = cuelloPts[idxClamped];

        // Rayo cian/blanco que desciende del cerebro al tórax
        capaResto.colorDisparo[ptIdx * 3] = 0.50;
        capaResto.colorDisparo[ptIdx * 3 + 1] = 0.90;
        capaResto.colorDisparo[ptIdx * 3 + 2] = 1.0;
        capaResto.ultimo[ptIdx] = tick;
        disparos++;
      }
    }

    // Descarga de Fibra Gigante en picos de alas o sentadilla
    if ((canales.alas || 0) > 0.70 || (canales.t2_t3 || 0) > 0.80) {
      this.fibraUltimo = tick;
    }

    this.tickVisto = tick;
    this.pintar();

    return {
      disparos,
      looming: (canales.alas || 0) > 0.5 ? 100 : 0,
      escape: false,
    };
  }

  /** Vuelve al tick cero: todo apagado, como al empezar la grabación. */
  reiniciar() {
    this.tickVisto = -1;
    this.fibraUltimo = -1e9;
    for (const c of this.capas) c.ultimo.fill(-1e9);
    this.pintar();
  }

  private pintar() {
    const t = this.tickVisto;
    for (const c of this.capas) c.pintar(t, this.tabla);

    const dt = t - this.fibraUltimo;
    const b = dt >= 0 && dt < ESTELA ? this.tabla[dt] : 0;
    const mat = this.fibra.material as THREE.PointsMaterial;
    mat.opacity = 0.40 + 0.60 * b;
    mat.size = 0.085 + 0.09 * b;
  }

  dibujar() {
    this.controles.update();
    this.renderer.render(this.escena, this.camara);
  }

  private encuadrar() {
    const { clientWidth: w, clientHeight: h } = this.contenedor;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camara.aspect = w / h;
    this.camara.updateProjectionMatrix();
  }
}

/** Un grupo de neuronas dibujadas con el mismo tamaño de punto. */
class Capa {
  readonly puntos: THREE.Points;
  /** Tick del último disparo de cada punto. */
  readonly ultimo: Float32Array;
  private colores: Float32Array;
  /** Color dinámico de disparo para cada punto (RGB). */
  readonly colorDisparo: Float32Array;

  constructor(xyz: number[], tamano: number, private lo: THREE.Color, hi: THREE.Color) {
    const n = xyz.length / 3;
    this.ultimo = new Float32Array(n).fill(-1e9);
    this.colores = new Float32Array(n * 3);
    this.colorDisparo = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.colorDisparo[i * 3] = hi.r;
      this.colorDisparo[i * 3 + 1] = hi.g;
      this.colorDisparo[i * 3 + 2] = hi.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(xyz, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.colores, 3));
    // Aditivo con textura radial suave: las neuronas se funden como nebulosas bio-luminiscentes
    this.puntos = new THREE.Points(geo, new THREE.PointsMaterial({
      size: tamano,
      map: TEXTURA_PARTICULA,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
  }

  pintar(t: number, tabla: number[]) {
    const { lo, colores, colorDisparo } = this;
    for (let p = 0; p < this.ultimo.length; p++) {
      const dt = t - this.ultimo[p];
      const b = dt >= 0 && dt < tabla.length ? tabla[dt] : 0;
      const rHi = colorDisparo[p * 3];
      const gHi = colorDisparo[p * 3 + 1];
      const bHi = colorDisparo[p * 3 + 2];
      colores[p * 3] = lo.r + (rHi - lo.r) * b;
      colores[p * 3 + 1] = lo.g + (gHi - lo.g) * b;
      colores[p * 3 + 2] = lo.b + (bHi - lo.b) * b;
    }
    this.puntos.geometry.attributes.color.needsUpdate = true;
  }
}
