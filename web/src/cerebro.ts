// El panel del cerebro: las neuronas del conectoma, prendiéndose al ritmo de la
// pelea que se está reproduciendo.
//
// **Solo dibuja lo que se grabó.** La actividad sale de `fly/piloto.py
// --grabar`, que corrió la simulación de verdad; acá no se simula nada. Es el
// mismo contrato que el juego: el navegador reproduce, no decide.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Cuánto le queda del brillo a una neurona por tick después de disparar.
 *  0.8 son ~50 ms de estela: lo justo para que una ráfaga se lea como ráfaga y
 *  no como un parpadeo. */
const DECAE = 0.8;
const ESTELA = 30; // ticks hasta que el brillo se da por apagado

// Paleta del proyecto: fondo casi negro, líneas azul acero, y el acento cian
// para el circuito que importa. El color de peligro no se usa acá.
//
// **El resto de la red dispara tenue a propósito.** Son ~5.800 neuronas por
// tick de actividad de fondo; con la estela quedan ~20.000 encendidas a la vez.
// Con el mismo brillo que el circuito, todo el cerebro se veía blanco y lo
// único que interesa —LC4 y LPLC2 prendiéndose antes de la esquiva— no se
// distinguía. Siguen siendo todos los disparos grabados; solo cambia el volumen.
const FONDO = 0x070a0f;
const REPOSO = new THREE.Color(0x0b1420);
const DISPARO = new THREE.Color(0x3a5470);
const LOOMING_REPOSO = new THREE.Color(0x0f3a36);
const LOOMING_DISPARO = new THREE.Color(0x5ff5dc);

const enum Grupo { Resto = 0, Looming = 1, FibraGigante = 2 }

export interface Lectura {
  /** Neuronas que dispararon en este tick. */
  disparos: number;
  /** De esas, cuántas son LC4 o LPLC2. */
  looming: number;
  /** ¿Disparó la fibra gigante? Es la orden de esquiva. */
  escape: boolean;
}

export class Cerebro {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
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

  private constructor(
    private contenedor: HTMLElement,
    cerebro: ArrayBuffer,
    private offsets: Uint32Array,
    private indices: Uint32Array,
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
      this.punto[i] = xyz[g].length / 3;
      xyz[g].push(...p);
    }
    this.capas = [
      new Capa(xyz[Grupo.Resto], 0.006, REPOSO, DISPARO),
      new Capa(xyz[Grupo.Looming], 0.016, LOOMING_REPOSO, LOOMING_DISPARO),
    ];
    for (const c of this.capas) this.escena.add(c.puntos);

    // Las dos fibras gigantes, aparte y grandes: son la neurona que decide la
    // esquiva, y en una nube de 138.000 puntos no se encontrarían.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(fibra, 3));
    this.fibra = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.05, color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false,
    }));
    this.escena.add(this.fibra);
    // Recién acá: `pintar` toca las fibras gigantes, y antes no existían.
    this.pintar();

    this.escena.background = new THREE.Color(FONDO);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    contenedor.appendChild(this.renderer.domElement);

    // Lo bastante lejos para que el cordón ventral no se meta debajo de la
    // leyenda, que está abajo a la derecha.
    this.camara.position.set(0, 0.1, 4.3);
    this.controles = new OrbitControls(this.camara, this.renderer.domElement);
    this.controles.enableDamping = true;
    // Gira sola despacio: una nube de puntos quieta se lee plana, y es la
    // rotación lo que dice que esto es un volumen.
    this.controles.autoRotate = true;
    this.controles.autoRotateSpeed = 0.5;

    new ResizeObserver(() => this.encuadrar()).observe(contenedor);
    this.encuadrar();
  }

  /** Devuelve `null` si la pelea no trae actividad grabada: el panel no aparece. */
  static async cargar(contenedor: HTMLElement, pelea: string): Promise<Cerebro | null> {
    const [c, a] = await Promise.all([
      fetch("/cerebro.bin", { cache: "no-store" }),
      fetch(`/${pelea}.act`, { cache: "no-store" }),
    ]);
    if (!c.ok || !a.ok) return null;
    const act = await a.arrayBuffer();
    const ticks = new Uint32Array(act, 0, 1)[0];
    const offsets = new Uint32Array(act, 4, ticks + 1);
    const indices = new Uint32Array(act, 4 + 4 * (ticks + 1), offsets[ticks]);
    return new Cerebro(contenedor, await c.arrayBuffer(), offsets, indices);
  }

  /** Aplica la actividad grabada hasta `tick` inclusive. */
  avanzar(tick: number): Lectura {
    const ultimoTick = this.offsets.length - 2;
    tick = Math.min(tick, ultimoTick);
    let lectura: Lectura = { disparos: 0, looming: 0, escape: false };
    // Por debajo de 60 fps un frame avanza varios ticks: se aplican todos, o
    // se perderían ráfagas enteras de la fibra gigante.
    for (let t = this.tickVisto + 1; t <= tick; t++) {
      lectura = { disparos: 0, looming: 0, escape: false };
      for (let k = this.offsets[t]; k < this.offsets[t + 1]; k++) {
        const i = this.indices[k];
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
    mat.opacity = 0.25 + 0.75 * b;
    mat.size = 0.05 + 0.07 * b;
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

  constructor(xyz: number[], tamano: number, private lo: THREE.Color, private hi: THREE.Color) {
    const n = xyz.length / 3;
    this.ultimo = new Float32Array(n).fill(-1e9);
    this.colores = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(xyz, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.colores, 3));
    // Aditivo: donde hay muchas neuronas juntas el brillo se acumula, y el
    // cerebro se lee como un volumen y no como una nube plana.
    this.puntos = new THREE.Points(geo, new THREE.PointsMaterial({
      size: tamano, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  }

  pintar(t: number, tabla: number[]) {
    const { lo, hi, colores } = this;
    for (let p = 0; p < this.ultimo.length; p++) {
      const dt = t - this.ultimo[p];
      const b = dt >= 0 && dt < tabla.length ? tabla[dt] : 0;
      colores[p * 3] = lo.r + (hi.r - lo.r) * b;
      colores[p * 3 + 1] = lo.g + (hi.g - lo.g) * b;
      colores[p * 3 + 2] = lo.b + (hi.b - lo.b) * b;
    }
    this.puntos.geometry.attributes.color.needsUpdate = true;
  }
}
