// El personaje del jugador: una araña, el depredador que le toca a una mosca.
// Anatomía de araña de verdad, simplificada solo en lo que la cámara no ve:
//
// - Dos tagmas, prosoma y opistosoma, unidos por el pedicelo: la cintura que
//   deja al abdomen doblarse.
// - Ocho ojos en dos filas, los medianos anteriores grandes, de saltícida.
// - Quelíceros con su colmillo plegado, y los pedipalpos a los costados.
// - Ocho patas de siete artejos —coxa, trocánter, fémur, patela, tibia,
//   metatarso y tarso— que nacen todas del prosoma. I y IV las más largas,
//   III la más corta, como en casi todas las arañas.
// - Tres pares de hileras en la punta del abdomen.
//
// Camina en tetrápodo alternado: L1, R2, L3 y R4 pisan juntas y las otras
// cuatro a contrafase. Es el trípode de la mosca con una pata más por lado, y
// usa su misma IK (`mosca.ts`, `alcanzar`).
//
// **La seda sale de las hileras.** Durante la carga el motor ya la frena
// (`actor::locked`); en ella la araña se planta, dobla el abdomen por el
// pedicelo hasta que las hileras miran adelante por encima de la cabeza, y al
// salir del windup escupe. Es una postura real: la araña que va a soltar seda
// al aire —el *tiptoeing* antes del ballooning— se para en punta de patas y
// levanta el abdomen. El motor crea el proyectil a `PLAYER_RADIUS +
// PLAYER_CANNON_RADIUS` del centro (`weapons.rs`); vuela a la altura de las
// hileras alzadas y un hilo lo une a ellas (`balas.ts`).
//
// Cada acción, leída del `Actor` y nunca cronometrada acá:
// - **Caminar**: el tetrápodo, al ritmo de lo que avanzó el cuerpo.
// - **Habilidad**: se planta con las patas abiertas y alza el abdomen; las
//   hileras se encienden y juntan seda; escupe con un latigazo del abdomen.
// - **Ataque**: se para sobre las patas de atrás con el par I arriba y los
//   colmillos abiertos; en la activa se tira adelante y clava.
// - **Parry**: la amenaza. Pares I y II arriba y abiertos, palpos arriba.
// - **Esquiva**: el salto, con las patas I estiradas adelante.

import * as THREE from "three";
import { Accion, Actor, Fase } from "./engine";
import { Efectos } from "./efectos";
import { alcanzar, segmento } from "./mosca";
import { contorno, tinta } from "./tinta";

// Paleta de Viuda Negra (Latrodectus mactans):
// Exosqueleto de quitina negro obsidiana profundo con cel-shading y filo de luz.
// Reloj de arena y marcas aposemáticas en carmesí escarlata puro de alto contraste.
const CUERPO = 0x111317;            // Prosoma y opistosoma: negro obsidiana
const PATA = 0x14161c;              // Patas: negro azabache estilizado
const QUELA = 0x1a1d24;             // Quelíceros y pedipalpos: carbón oscuro
const OJO = 0x050709;               // Ojos compuestos: perlas de obsidiana
const ROJO_VIUDA = 0xff002e;        // El icónico reloj de arena carmesí
const ROJO_ARTICULACION = 0xcc0028; // Anillos de las articulaciones (rodillas/tobillos)
const ROJO_COLMILLO = 0xee002e;     // Puntas de colmillos venenosos

/** Altura del centro del cuerpo, parada. */
const DE_PIE = 0.3;
/** Lo que avanza el cuerpo en un ciclo de paso. A velocidad máxima (7) son
 *  unos nueve ciclos por segundo: las arañas corren así. */
const ZANCADA = 0.8;
/** Cuánto levanta el pie en el vuelo del paso. */
const ALZA = 0.12;
/** Frames del destello al recibir un golpe. */
const DESTELLO = 6;
const LERP = 0.3;

/** El pedicelo, en el marco del cuerpo: la bisagra del abdomen. */
const PEDICELO = new THREE.Vector3(-0.1, 0.03, 0);
/** Las hileras, en el marco del abdomen, que apunta a -X. */
const HILERAS = new THREE.Vector3(-0.68, -0.03, 0);
/** Ángulo del abdomen en el pedicelo. En reposo, apenas levantado. Para
 *  escupir, apenas pasado de la vertical: las hileras quedan arriba de la
 *  cabeza, un poco adelante, mirando al blanco. */
const COLA = -0.25, COLA_ALZADA = -1.85;
/** Lo que se agacha para escupir. */
const AGACHA = -0.06;
/** A qué altura quedan las hileras alzadas. Las balas del jugador vuelan a
 *  esta altura: es cosmética, pero así la seda sale de las hileras. */
export const ALTURA_DISPARO = DE_PIE + AGACHA + PEDICELO.y
  + HILERAS.x * Math.sin(COLA_ALZADA) + HILERAS.y * Math.cos(COLA_ALZADA);

/** Las cuatro patas de un lado, en el marco del lado (+z afuera): cadera, pie
 *  parada relativo a la cadera, y largo relativo. */
const PATAS: { cadera: THREE.Vector3; pie: THREE.Vector3; k: number }[] = [
  { cadera: new THREE.Vector3(0.24, -0.05, 0.1), pie: new THREE.Vector3(0.5, 0, 0.5), k: 1 },
  { cadera: new THREE.Vector3(0.16, -0.06, 0.13), pie: new THREE.Vector3(0.18, 0, 0.72), k: 0.88 },
  { cadera: new THREE.Vector3(0.07, -0.06, 0.13), pie: new THREE.Vector3(-0.18, 0, 0.66), k: 0.78 },
  { cadera: new THREE.Vector3(-0.02, -0.05, 0.1), pie: new THREE.Vector3(-0.55, 0, 0.55), k: 0.95 },
];
/** Fémur, patela con tibia, y metatarso con tarso de la pata de largo 1. El
 *  último tramo cae `CAE` hacia el suelo. */
const FEMUR = 0.36, TIBIA = 0.4, TARSO = 0.3, CAE = 0.6;

type Pie = [number, number, number];
/** Una pose: lo que el cuerpo persigue con un lerp, así la animación no puede
 *  desincronizarse de la fase del motor. */
interface Pose {
  /** Cabeceo: positivo levanta el frente. */
  inclina: number;
  /** Altura sobre la de pie. */
  alto: number;
  /** Ángulo del abdomen en el pedicelo. */
  cola: number;
  /** Colmillos abiertos, de 0 a 1. */
  quelas: number;
  /** Palpos arriba, de 0 a 1. */
  palpos: number;
  /** Corrimiento del pie de cada par, en el marco del lado. En el suelo sube
   *  la pata; en el aire la recoge. */
  patas: [Pie, Pie, Pie, Pie];
}

const QUIETA: Pose = { inclina: 0, alto: 0, cola: COLA, quelas: 0, palpos: 0, patas: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] };
const POSES = {
  escupe: {
    inclina: 0, alto: AGACHA, cola: COLA_ALZADA, quelas: 0, palpos: 0.3,
    patas: [[0.06, 0, 0.1], [0, 0, 0.12], [0, 0, 0.12], [-0.06, 0, 0.1]],
  },
  alza: {
    inclina: 0.4, alto: 0.06, cola: -0.1, quelas: 1, palpos: 0.6,
    patas: [[-0.05, 0.55, -0.15], [0.05, 0.2, 0], [0, 0, 0], [0, 0, 0]],
  },
  clava: {
    inclina: -0.25, alto: -0.04, cola: -0.4, quelas: 1, palpos: 0.2,
    patas: [[0.35, 0.03, -0.15], [0.15, 0, 0], [0, 0, 0], [0, 0, 0]],
  },
  amenaza: {
    inclina: 0.5, alto: 0.05, cola: 0, quelas: 1, palpos: 1,
    patas: [[-0.1, 0.65, 0.1], [0, 0.4, 0.2], [0, 0, 0], [0, 0, 0]],
  },
  salto: {
    inclina: 0.1, alto: 0, cola: -0.4, quelas: 0, palpos: 0.5,
    patas: [[0.25, 0.3, -0.25], [0, 0.22, -0.3], [-0.05, 0.22, -0.3], [-0.1, 0.18, -0.2]],
  },
} satisfies Record<string, Pose>;

/** Cápsula de `a` a `b`. */
function hueso(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const d = b.clone().sub(a);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, d.length(), 4, 10), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

/** Esfera achatada a `escala`, en `p`. */
function bola(p: THREE.Vector3, escala: THREE.Vector3, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
  m.position.copy(p);
  m.scale.copy(escala);
  return m;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export class Jugador {
  readonly grupo = new THREE.Group();
  /** Donde nace la seda: la punta de las hileras. `balas.ts` ata el hilo acá. */
  readonly hilera = new THREE.Object3D();
  /** Cabeceo y altura: separado del rumbo. */
  private cuerpo = new THREE.Group();
  private cola = new THREE.Group();
  private quelas: THREE.Group[] = [];
  private colmillos: THREE.Group[] = [];
  private palpos: THREE.Group[] = [];
  private lados: { caderas: THREE.Group[]; rodillas: THREE.Group[]; tobillos: THREE.Group[] }[] = [];
  private banda: THREE.MeshToonMaterial;
  private seda: THREE.MeshToonMaterial;
  private anillo: THREE.MeshToonMaterial;
  private piel: THREE.MeshToonMaterial[] = [];

  private p: Pose = structuredClone(QUIETA);
  private rumbo = 0;
  private paso = 0;
  private marcha = 0;
  /** 1 con las patas en el suelo, 0 en el aire (la esquiva). */
  private suelo = 1;
  private antes: { x: number; y: number } | null = null;
  private apunte: number | null = null;
  /** La acción en curso: el motor manda `slot` 0 en la recuperación, así que
   *  se recuerda la de la carga para saber de qué se está recuperando. */
  private accion = -1;
  private fase = Fase.Idle;
  private total = 1;
  private patada = 0;
  private destello = 0;
  private frame = 0;
  private pie = new THREE.Vector3();
  private vuelta = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(escena: THREE.Scene, private efectos: Efectos, private color: number) {
    const cuerpo = tinta(CUERPO, { emissive: 0xffffff, emissiveIntensity: 0 });
    const pata = tinta(PATA, { emissive: 0xffffff, emissiveIntensity: 0 });
    const quela = tinta(QUELA, { emissive: 0xffffff, emissiveIntensity: 0 });
    const colmilloMat = tinta(ROJO_COLMILLO, { emissive: ROJO_COLMILLO, emissiveIntensity: 0.4 });
    this.anillo = tinta(ROJO_ARTICULACION, { emissive: ROJO_ARTICULACION, emissiveIntensity: 0.3 });
    this.piel.push(cuerpo, pata, quela);
    this.banda = tinta(ROJO_VIUDA, { emissive: ROJO_VIUDA, emissiveIntensity: 0.65 });
    this.seda = tinta(PATA, { emissive: ROJO_VIUDA, emissiveIntensity: 0 });
    const ojo = tinta(OJO);
    const brillo = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const borde = <T extends THREE.Mesh>(m: T, grosor = 1.08): T => {
      m.castShadow = true;
      contorno(m, grosor);
      return m;
    };

    // El centro del cuerpo va un poco adelante del abdomen: el hitbox es un
    // círculo, y así lo que queda dentro de él es la araña y no su cola.
    this.cuerpo.position.x = 0.12;

    // Prosoma: el escudo dorsal, más alto adelante, donde están los ojos.
    const prosoma = borde(bola(v3(0.12, 0.02, 0), v3(0.24, 0.13, 0.18), cuerpo));
    prosoma.rotation.z = 0.08;
    // Los ocho ojos: los medianos anteriores enormes, mirando al frente; los
    // laterales anteriores al lado; y la fila de atrás, arriba del escudo.
    for (const s of [-1, 1]) {
      for (const [x, y, z, r] of [
        [0.335, 0.07, 0.045, 0.042], [0.315, 0.075, 0.105, 0.024],
        [0.26, 0.13, 0.06, 0.018], [0.2, 0.12, 0.11, 0.026],
      ]) {
        const o = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), ojo);
        o.position.set(x, y, z * s);
        if (r > 0.04) {
          contorno(o, 1.15);
          const b = new THREE.Mesh(new THREE.SphereGeometry(r * 0.28, 6, 4), brillo);
          b.position.set(r * 0.6, r * 0.55, r * 0.35 * s);
          o.add(b);
        }
        this.cuerpo.add(o);
      }

      // Quelíceros: dos columnas bajo los ojos, con el colmillo plegado hacia
      // adentro. Abrirlos es separarlas y desplegar el colmillo.
      const q = new THREE.Group();
      q.position.set(0.3, -0.01, 0.045 * s);
      q.add(borde(hueso(v3(0, 0, 0), v3(0.05, -0.12, 0), 0.042, quela)));
      const colmillo = new THREE.Group();
      colmillo.position.set(0.05, -0.15, 0);
      const punta = borde(new THREE.Mesh(
        new THREE.ConeGeometry(0.02, 0.08, 6).translate(0, 0.04, 0).rotateX(Math.PI), colmilloMat,
      ), 1.2);
      colmillo.add(punta);
      q.add(colmillo);
      this.quelas.push(q);
      this.colmillos.push(colmillo);
      this.cuerpo.add(q);

      // Pedipalpos: patitas cortas a los costados de la boca.
      const palpo = new THREE.Group();
      palpo.position.set(0.28, -0.03, 0.085 * s);
      const codo = v3(0.1, 0.05, 0.03 * s), punta2 = v3(0.17, -0.06, 0.035 * s);
      palpo.add(
        borde(hueso(v3(0, 0, 0), codo, 0.025, pata)),
        borde(hueso(codo, punta2, 0.022, quela)),
      );
      this.palpos.push(palpo);
      this.cuerpo.add(palpo);
    }
    this.cuerpo.add(prosoma, hueso(v3(-0.06, 0.02, 0), PEDICELO, 0.035, pata));

    // Opistosoma: el abdomen de la viuda negra, negro azabache esférico con
    // su icónico reloj de arena carmesí en el lomo y vientre, y las hileras en la punta.
    this.cola.position.copy(PEDICELO);
    const centro = v3(-0.32, 0.01, 0);
    this.cola.add(
      borde(bola(centro, v3(0.33, 0.25, 0.26), cuerpo)),
      // Reloj de arena geométrico (hourglass) y franja dorsal:
      // Lóbulo anterior ancho, cintura conectora al centro, lóbulo posterior ancho y cresta dorsal continua.
      bola(v3(-0.24, 0.01, 0), v3(0.12, 0.258, 0.095), this.banda), // lóbulo anterior (triángulo)
      bola(v3(-0.32, 0.01, 0), v3(0.10, 0.258, 0.045), this.banda), // cintura que conecta
      bola(v3(-0.40, 0.01, 0), v3(0.13, 0.258, 0.090), this.banda), // lóbulo posterior (triángulo)
      bola(centro, v3(0.31, 0.256, 0.035), this.banda),             // cresta dorsal continua hacia hileras
    );
    for (const s of [-1, 1]) {
      // Anteriores, medianas y posteriores.
      for (const [y, z, r, l] of [[-0.06, 0.035, 0.028, 0.08], [-0.04, 0.012, 0.015, 0.05], [-0.01, 0.04, 0.022, 0.09]]) {
        const h = borde(new THREE.Mesh(new THREE.ConeGeometry(r, l, 8).rotateZ(Math.PI / 2), this.seda), 1.15);
        h.position.set(-0.6 - l / 2, y, z * s);
        this.cola.add(h);
      }
    }
    this.hilera.position.copy(HILERAS);
    this.cola.add(this.hilera);
    this.cuerpo.add(this.cola);

    // Las patas. Cada artejo con su casco de tinta, que es el mismo cilindro
    // más grueso: el de `contorno` escalaría desde la articulación.
    const tinta0 = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
    const artejo = (g: THREE.Group, largo: number, r0: number, r1: number, mat: THREE.Material, x = 0) => {
      const m = new THREE.Mesh(segmento(largo, r0, r1).translate(x, 0, 0), mat);
      m.castShadow = true;
      const casco = new THREE.Mesh(segmento(largo + 0.03, r0 + 0.016, r1 + 0.016).translate(x - 0.015, 0, 0), tinta0);
      casco.name = "contorno";
      g.add(m, casco);
    };
    const articulacion = (g: THREE.Group, r: number) => {
      const m = borde(new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), this.anillo), 1.25);
      g.add(m);
    };
    for (const signo of [1, -1]) {
      const lado = new THREE.Group();
      lado.scale.z = signo;
      const cs: THREE.Group[] = [], rs: THREE.Group[] = [], ts: THREE.Group[] = [];
      for (const { cadera: c, k } of PATAS) {
        // Coxa y trocánter: fijos, del esternón a la cadera.
        lado.add(borde(hueso(v3(c.x * 0.7, c.y - 0.02, 0.03), c, 0.036, pata)));
        const cadera = new THREE.Group();
        cadera.position.copy(c);
        cadera.rotation.order = "YZX";
        articulacion(cadera, 0.04);
        artejo(cadera, FEMUR * k, 0.046, 0.038, pata);
        const rodilla = new THREE.Group();
        rodilla.position.x = FEMUR * k;
        articulacion(rodilla, 0.042);
        artejo(rodilla, TIBIA * k, 0.036, 0.028, pata);
        const tobillo = new THREE.Group();
        tobillo.position.x = TIBIA * k;
        articulacion(tobillo, 0.03);
        artejo(tobillo, TARSO * k * 0.7, 0.026, 0.02, pata);
        artejo(tobillo, TARSO * k * 0.3, 0.02, 0.012, quela, TARSO * k * 0.7);
        rodilla.add(tobillo);
        cadera.add(rodilla);
        lado.add(cadera);
        cs.push(cadera);
        rs.push(rodilla);
        ts.push(tobillo);
      }
      this.cuerpo.add(lado);
      this.lados.push({ caderas: cs, rodillas: rs, tobillos: ts });
    }

    this.grupo.add(this.cuerpo);
    escena.add(this.grupo);
  }

  /** Le pegó el boss. */
  golpeado() {
    this.destello = DESTELLO;
  }

  /** La habilidad empezó a cargar hacia `angulo`: el de su telegrafía. */
  apuntar(angulo: number) {
    this.apunte = angulo;
  }

  /** La pose de la acción en curso, en la fase en curso. */
  private objetivo(fase: Fase): Pose {
    if (fase === Fase.Dodging) return POSES.salto;
    if (fase === Fase.Idle || fase === Fase.Recovery) return QUIETA;
    switch (this.accion) {
      case Accion.Habilidad: return POSES.escupe;
      case Accion.Ataque: return fase === Fase.Windup ? POSES.alza : POSES.clava;
      case Accion.Parry: return POSES.amenaza;
      default: return QUIETA;
    }
  }

  actualizar(a: Actor, tick: number) {
    this.frame++;
    const L = (v: number, o: number, k: number) => v + (o - v) * k;

    // Qué está haciendo. El windup y la activa traen el slot; la
    // recuperación no, y hereda el de la carga.
    const comprometido = a.fase === Fase.Windup || a.fase === Fase.Active;
    if (comprometido) this.accion = a.slot;
    let escupio = false;
    if (a.fase !== this.fase) {
      if (a.fase === Fase.Windup || a.fase === Fase.Dodging) this.total = Math.max(a.ticks, 1);
      // Sale de la carga de la habilidad —a la activa, o directo a la
      // recuperación si este frame se comió la activa—: es el escupitajo.
      if (this.fase === Fase.Windup && this.accion === Accion.Habilidad
        && (a.fase === Fase.Active || a.fase === Fase.Recovery)) escupio = true;
      if (a.fase === Fase.Dodging || this.fase === Fase.Dodging) this.polvo(3);
      if (a.fase === Fase.Idle) this.accion = -1;
      this.fase = a.fase;
    }
    const escupe = this.accion === Accion.Habilidad && this.apunte !== null;
    const progreso = a.fase === Fase.Windup || a.fase === Fase.Dodging ? 1 - a.ticks / this.total : 0;

    // La pose. En la activa, rápido: el golpe tiene que verse de golpe.
    const o = this.objetivo(a.fase);
    const k = a.fase === Fase.Active ? 0.6 : LERP;
    const p = this.p;
    for (const c of ["inclina", "alto", "cola", "quelas", "palpos"] as const) p[c] = L(p[c], o[c], k);
    p.patas.forEach((d, i) => d.forEach((_, j) => (d[j] = L(d[j], o.patas[i][j], k))));
    const aire = a.fase === Fase.Dodging;
    this.suelo = L(this.suelo, aire ? 0 : 1, aire ? 0.5 : 0.25);

    // El rumbo: el del motor, salvo mientras escupe, que mira al blanco.
    const rumbo = escupe ? this.apunte! : a.facing;
    this.rumbo += Math.atan2(Math.sin(rumbo - this.rumbo), Math.cos(rumbo - this.rumbo)) * 0.4;
    this.grupo.position.set(a.x, 0, a.y);
    this.grupo.rotation.y = -this.rumbo;

    // El paso sale de lo que avanzó el cuerpo, como en la mosca.
    if (this.antes) {
      const avance = Math.hypot(a.x - this.antes.x, a.y - this.antes.y);
      // Un salto de posición (la pelea reinicia) no es caminar.
      if (avance < 1 && !aire) this.paso = (this.paso + avance / ZANCADA) % 1;
    }
    this.antes = { x: a.x, y: a.y };
    this.marcha = L(this.marcha, aire ? 0 : Math.min(Math.hypot(a.vx, a.vy) / 7, 1), 0.25);

    // El latigazo del escupitajo: el abdomen se tira adelante y vuelve con un
    // rebote, y el cuerpo recibe la patada hacia atrás.
    this.patada = escupio ? 1 : this.patada * 0.8;
    const rebote = this.patada * Math.cos(this.patada * 2.5);
    const blanco = this.destello / DESTELLO;
    if (this.destello > 0) this.destello--;
    for (const m of this.piel) m.emissiveIntensity = 0.8 * blanco;
    this.anillo.emissiveIntensity = 0.3 + 0.7 * blanco;

    const salto = aire ? Math.sin(Math.PI * progreso) * 0.6 : 0;
    const vaiven = Math.abs(Math.sin(this.paso * Math.PI * 4)) * 0.025 * this.marcha;
    this.cuerpo.position.y = DE_PIE + p.alto + salto + vaiven;
    this.cuerpo.rotation.z = p.inclina + 0.12 * rebote - 0.15 * blanco;
    // Quieta, el abdomen respira; cargando, bombea.
    const cargando = this.accion === Accion.Habilidad && a.fase === Fase.Windup;
    this.cola.rotation.z = p.cola - 0.45 * rebote + 0.03 * Math.sin(tick * 0.08);
    this.cola.scale.setScalar(1 + (cargando ? 0.05 * progreso * Math.sin(tick * 1.1) : 0));
    this.quelas.forEach((q, i) => {
      const s = i === 0 ? -1 : 1;
      q.rotation.x = -s * 0.35 * p.quelas;
      this.colmillos[i].rotation.set(s * (Math.PI / 2) * (1 - p.quelas), 0, 0.3 * p.quelas);
    });
    // Los palpos tamborilean, cada uno a su ritmo: quieta, es lo que la hace
    // parecer viva.
    this.palpos.forEach((g, i) => {
      g.rotation.z = 0.9 * p.palpos + 0.12 * Math.max(0, Math.sin(tick * 0.21 + i * 2.3));
    });
    this.posar(salto + vaiven);

    // La carga: las hileras se encienden y juntan seda; el reloj de arena carmesí también.
    this.seda.emissiveIntensity = L(this.seda.emissiveIntensity, cargando ? 0.6 + 2.0 * progreso : 0, 0.3);
    this.banda.emissiveIntensity = 0.65 + (cargando ? 1.4 * progreso : 0) + 1.6 * this.patada;
    if (cargando && this.frame % 2 === 0) this.efectos.succion(this.hilera.getWorldPosition(this.v), 0xffffff);
    if (escupio) this.escupir();
  }

  /** Las patas. Apoyan en el suelo del mundo, no en el del cuerpo: si el
   *  cuerpo cabecea, los pies se quedan donde están. `sobre` es lo que el
   *  cuerpo está por encima de su altura de pie sin contar la pose. */
  private posar(sobre: number) {
    const p = this.p;
    this.vuelta.copy(this.cuerpo.quaternion).invert();
    this.lados.forEach((l, k) => {
      const signo = k === 0 ? 1 : -1;
      PATAS.forEach(({ cadera, pie, k: largo }, i) => {
        // Tetrápodo: I y III de un lado pisan con II y IV del otro.
        const s = (this.paso + ((i + k) % 2) * 0.5) % 1;
        const apoyo = s < 0.5;
        const u = apoyo ? s * 2 : (s - 0.5) * 2;
        const ida = apoyo ? 0.5 - u : u * u * (3 - 2 * u) - 0.5;
        const alza = (apoyo ? 0 : ALZA * Math.sin(Math.PI * u)) * this.marcha;
        const [dx, dy, dz] = p.patas[i];
        // En el suelo el pie baja hasta el piso; en el aire cuelga del cuerpo.
        this.pie.set(
          cadera.x + pie.x + ida * (ZANCADA / 2) * this.marcha + dx,
          -DE_PIE - (p.alto + sobre) * this.suelo + alza + dy,
          (cadera.z + pie.z + dz) * signo,
        ).applyQuaternion(this.vuelta);
        this.pie.z *= signo;
        const [y, z, r, t] = alcanzar(cadera, this.pie, [FEMUR * largo, TIBIA * largo, TARSO * largo, CAE]);
        l.caderas[i].rotation.y = y;
        l.caderas[i].rotation.z = z;
        l.rodillas[i].rotation.z = r;
        l.tobillos[i].rotation.z = t;
      });
    });
  }

  /** La seda sale: destello en las hileras y un chorro de hebras hacia el
   *  blanco. La bala en sí la dibuja `balas.ts`. */
  private escupir() {
    this.grupo.updateMatrixWorld(true);
    const p = this.hilera.getWorldPosition(this.v);
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(this.grupo.quaternion);
    this.efectos.destello(p, 0xffffff, 0.7);
    this.efectos.destello(p, ROJO_VIUDA, 0.55);
    this.efectos.chispas(p, dir, 8, 0xffffff, 0.9);
  }

  /** Polvo en las patas. */
  private polvo(n: number) {
    const p = this.grupo.position;
    this.efectos.humo(this.v.set(p.x, 0.08, p.z), null, n, 0.09);
  }
}
