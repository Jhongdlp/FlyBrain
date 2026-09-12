// El boss es una mosca. Drosophila, procedural: primitivas animadas por pose,
// sin pipeline de assets, igual que el resto de la escena.
//
// La cámara mira desde arriba a 60°, así que lo que manda es la silueta dorsal:
// alas, tórax y los dos ojos compuestos. Las patas se ven poco desde arriba,
// pero dibujan la sombra, y la sombra es lo que dice "insecto" en el suelo.
//
// **Camina.** El boss lo mueven las motoneuronas de las patas (`fly/patas.py`),
// así que se dibuja caminando: apoyada en el suelo, en trípode como Drosophila,
// con las alas plegadas y quietas. Solo despega en la esquiva, que es el salto
// de escape de la fibra gigante.
//
// Todo acá es presentación: lee el `Actor` del motor y no decide nada. El paso
// es cosmético —el motor no sabe de patas—, pero sale de cuánto avanzó el
// cuerpo, así que los pies no patinan y un video de la misma pelea es idéntico.

import * as THREE from "three";
import { Actor, Fase } from "./engine";
import { contorno, tinta } from "./tinta";
import type { CanalesEstimulacion } from "./cerebro";

export interface InfoBaile {
  pasoNombre: string;
  circuitoNombre: string;
  region: "t1_izq" | "t1_der" | "t1_ambos" | "t2_t3" | "alas" | "dopamina" | "grooming";
  intensidad: number;
}

// **Dirección de arte: una mosca de dibujo animado.** Cel-shading de tres
// tonos y contorno negro (`tinta.ts`), con la anatomía que dice "mosca" y no
// "abeja" desde la cámara a 60°: gris, con el tórax a rayas negras
// longitudinales, el abdomen grande y redondo con bandas oscuras, ojos rojos
// enormes que se comen la cabeza, alas celestes transparentes y la trompa con
// su ventosa.
//
// Los ojos son rojos porque los de una mosca lo son, y sin ellos no es una
// mosca. Carmesí oscuro y sin brillo propio, para no confundirse con el
// rojo-naranja de las telegrafías, que sigue siendo el del peligro.
const QUITINA = 0x8d949d;
const RAYA = 0x363a42;
const CABEZA = 0x9aa1aa;
const ANILLO = 0xa7aeb7;
const BANDA = 0x4a4f58;
const PATA = 0x4e545d;
const OJO = 0xc21f2b;
const OJO_FACETA = 0x6e0d14;
const CERDA = 0x15171b;
const MEMBRANA = 0xb8e0ff;
const VENA = 0xf4fbff;
const FANTASMA = 0xdbe6f2;
/** Radio del ojo compuesto, antes de achatarlo. */
const R_OJO = 0.28;
/** El destello al recibir un golpe: frames que dura. */
const DESTELLO = 6;

/** Largo del ala desde la bisagra. La envergadura sale mayor que el hitbox
 *  (0.9) a propósito: lo que golpea es el cuerpo, las alas son aire. */
const ALA = 1.25;
/** Semiamplitud del aleteo en el suelo de la pose, en radianes. */
const ARCO = 1.0;
/** Hacia dónde apunta el ala batiendo: el centro del abanico. */
const BATE = -1.75;
/** Frames de estela guardados y fantasmas dibujados con ellos. */
const HISTORIA = 12;
const FANTASMAS = 4;

/** Segmentos de la pata. El tarso apoya en el suelo inclinado `TARSO_CAE`. */
const FEMUR = 0.4, TIBIA = 0.46, TARSO = 0.2, TARSO_CAE = 0.35;
/** Altura del centro del cuerpo parada: las caderas quedan a ~0.3 del suelo y
 *  las rodillas por encima de ellas, que es la silueta de insecto. */
const DE_PIE = 0.55;
/** Distancia que avanza el cuerpo en un ciclo de paso. A velocidad máxima
 *  (4.5) son ~6 pasos por segundo. */
const ZANCADA = 0.75;
/** Cuánto levanta el pie en el vuelo del paso. */
const ALZA = 0.14;

/**
 * Una pose es un puñado de ángulos. Cada fase tiene la suya y el cuerpo la
 * persigue con un lerp, así que la animación no puede desincronizarse de la
 * fase del motor.
 */
interface Pose {
  /** Cabeceo: negativo se echa atrás (carga), positivo se tira adelante. */
  inclinacion: number;
  /** Amplitud del aleteo, 0 a ~1. Con 0 las alas quedan quietas. */
  aleteo: number;
  /** Hacia dónde apunta el ala en el plano: -π/2 es lateral, -π atrás. */
  barrido: number;
  /** Cuánto se levanta el plano del aleteo sobre el eje del cuerpo. */
  alzada: number;
  /** En el aire: caída de cada par de patas (delantero, medio, trasero). */
  patas: [number, number, number];
  rodilla: number;
  /** En el suelo: cuánto levanta el pie cada par. Es la telegrafía del golpe. */
  levanta: [number, number, number];
  /** Altura sobre la de pie. Carga agachándose, esquiva saltando. */
  altura: number;
  /** Squash & stretch: negativo se aplasta y ensancha, positivo se estira a
   *  lo largo. Exagera la anticipación y el golpe, que es lo que los hace
   *  legibles a la distancia de la cámara. */
  estira: number;
}

/**
 * - **Reposo**: caminando, con las alas plegadas una sobre otra encima del
 *   abdomen y quietas, como una Drosophila en el suelo.
 * - **Carga**: abre las alas en V, se echa atrás y levanta las patas
 *   delanteras. Desde arriba la silueta cambia de golpe: es la telegrafía.
 * - **Golpe**: abre las alas de un latigazo y se tira adelante.
 * - **Esquiva**: el escape de la fibra gigante tal como lo hace la mosca real —
 *   alas arriba, patas medias extendidas para el salto, y despega. Es la única
 *   vez que está en el aire.
 */
const POSE: Record<Fase, Pose> = {
  [Fase.Idle]: {
    inclinacion: 0.04, aleteo: 0, barrido: -3.2, alzada: 0.06,
    patas: [-0.3, -0.35, -0.45], rodilla: -1.9, levanta: [0, 0, 0], altura: 0, estira: 0,
  },
  [Fase.Windup]: {
    inclinacion: -0.25, aleteo: 0, barrido: -2.5, alzada: 0.12,
    patas: [0.35, -0.45, -0.6], rodilla: -0.6, levanta: [0.45, 0, 0], altura: -0.08, estira: -0.14,
  },
  [Fase.Active]: {
    inclinacion: 0.3, aleteo: 1.2, barrido: -1.4, alzada: 0.3,
    patas: [0.1, -0.5, -0.5], rodilla: -0.45, levanta: [0.2, 0, 0], altura: 0.04, estira: 0.2,
  },
  [Fase.Recovery]: {
    inclinacion: 0.08, aleteo: 0, barrido: -3.2, alzada: 0.06,
    patas: [-0.3, -0.4, -0.5], rodilla: -1.7, levanta: [0, 0, 0], altura: -0.03, estira: -0.05,
  },
  [Fase.Dodging]: {
    inclinacion: 0.2, aleteo: 1, barrido: -2.0, alzada: 1.15,
    patas: [-0.6, -1.3, -0.85], rodilla: -0.2, levanta: [0, 0, 0], altura: 0.8, estira: 0.12,
  },
};

/** La embestida (slot 3) se hace en el aire: es la mosca tirándosele encima al
 *  rival. Misma pose de vuelo que la esquiva —alas arriba, patas recogidas—
 *  pero echada hacia adelante y más baja, porque va a por él y no huyendo. */
export const EMBESTIDA = 3;
const POSE_EMBESTIDA: Pose = {
  ...structuredClone(POSE[Fase.Dodging]),
  inclinacion: 0.34, altura: 0.55, estira: 0.22, aleteo: 1.3,
};

const LERP = 0.28;
/** Ángulo dorado: muestrear el aleteo con él da una fase distinta cada frame
 *  sin patrón visible. Es lo que se ve al filmar a 60fps un ala que bate a
 *  200Hz, y sale del tick, así que un video de la misma pelea es idéntico. */
const ESTROBO = 2.39996;

/** Segmento de pata a lo largo de +X local, con su origen en la articulación. */
export function segmento(largo: number, r0: number, r1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, largo, 5);
  g.rotateZ(-Math.PI / 2);
  g.translate(largo / 2, 0, 0);
  return g;
}

/** Ángulos de una pata para que el tarso apoye en `pie`, los dos en el marco
 *  del lado: `[abre, fémur, rodilla, tobillo]`, en el orden de las rotaciones
 *  de `cadera` (YZX) y de las articulaciones hijas. Dos segmentos con la
 *  rodilla arriba; el tarso cae fijo `cae` hacia afuera. Los largos son los de
 *  la mosca salvo que se pasen otros: la araña (`jugador.ts`) usa esta misma. */
export function alcanzar(
  cadera: THREE.Vector3, pie: THREE.Vector3,
  [F, T, TA, cae]: readonly number[] = [FEMUR, TIBIA, TARSO, TARSO_CAE],
): [number, number, number, number] {
  const dx = pie.x - cadera.x, dz = pie.z - cadera.z;
  // Hasta el tobillo: el tarso ocupa el último tramo, hacia afuera y abajo.
  const r = Math.hypot(dx, dz) - TA * Math.cos(cae);
  const h = pie.y + TA * Math.sin(cae) - cadera.y;
  const d = Math.max(Math.min(Math.hypot(r, h), (F + T) * 0.999), Math.abs(F - T) + 1e-3);
  const cadera_ = Math.acos((F * F + d * d - T * T) / (2 * F * d));
  const rodilla = Math.acos((F * F + T * T - d * d) / (2 * F * T));
  const femur = Math.atan2(h, r) + cadera_;
  const flexion = rodilla - Math.PI;
  return [Math.atan2(-dz, dx), femur, flexion, -cae - femur - flexion];
}

/** Abdomen de revolución, apuntando a -X, con los terguitos marcados: una
 *  cintura en cada borde de segmento y la banda oscura detrás de cada uno, que
 *  es el dibujo de Drosophila. El color va por vértice para que sea una malla. */
function abdomen(): THREE.BufferGeometry {
  // Más redondo y más gordo que el de Drosophila: la panza es la mitad de la
  // silueta de una mosca de dibujo animado.
  const L = 0.85, R = 0.37, SEG = 5;
  const perfil: THREE.Vector2[] = [];
  for (let i = 0; i <= 36; i++) {
    const s = i / 36;
    const cintura = Math.pow(Math.cos(Math.PI * s * SEG), 16);
    const r = R * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * s)), 0.55) * (1 - 0.07 * cintura);
    perfil.push(new THREE.Vector2(Math.max(r, 0.001), s * L));
  }
  const g = new THREE.LatheGeometry(perfil, 18);
  const uv = g.getAttribute("uv");
  const claro = new THREE.Color(ANILLO), oscuro = new THREE.Color(BANDA), c = new THREE.Color();
  const colores: number[] = [];
  for (let i = 0; i < uv.count; i++) {
    const s = uv.getY(i);
    const t = (s * SEG) % 1;
    c.copy(claro).lerp(oscuro, t > 0.5 || s > 0.9 ? 1 : 0);
    colores.push(c.r, c.g, c.b);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(colores, 3));
  g.rotateZ(Math.PI / 2); // eje +Y → -X: la base en el tórax, la punta atrás
  return g;
}

/** El abanico que deja el ala batiendo, en el plano XZ. El ala se frena y se da
 *  vuelta en cada extremo del golpe, así que ahí pasa más tiempo y el borroso
 *  es más denso: bordes marcados y el centro casi transparente. Nace un poco
 *  afuera de la bisagra para no ensuciar el tórax. Alfa por vértice. */
function abanico(): THREE.BufferGeometry {
  const t0 = BATE - ARCO;
  const g = new THREE.RingGeometry(0.3, ALA, 24, 2, t0, ARCO * 2);
  const pos = g.getAttribute("position");
  const rgba: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const t = (Math.atan2(y, x) - t0) / (ARCO * 2);
    const borde = Math.pow(Math.abs(2 * t - 1), 3);
    const r = Math.hypot(x, y) / ALA;
    rgba.push(1, 1, 1, (0.25 + 0.75 * borde) * Math.min(1, r * 1.6) * (r > 0.99 ? 0.4 : 1));
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(rgba, 4));
  return g.rotateX(-Math.PI / 2);
}

/** Contorno de ala de Drosophila: paleta estrecha en la bisagra, borde de
 *  ataque casi recto y la punta redonda. En el plano XZ, apuntando a +X. */
function formaAla(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 0.03);
  s.bezierCurveTo(0.35, 0.12, 0.75, 0.2, 1.02, 0.15);
  s.bezierCurveTo(1.28, 0.1, 1.28, -0.12, 1.02, -0.17);
  s.bezierCurveTo(0.7, -0.22, 0.3, -0.14, 0, -0.03);
  s.closePath();
  return s;
}

/** Las venas longitudinales L2–L5 y los dos travesaños. Son el dibujo del ala,
 *  y a esta escala son lo único que la separa de un óvalo. */
function venas(): THREE.BufferGeometry {
  const v = (x: number, y: number) => new THREE.Vector3(x, y, 0);
  const tramos: [number, number, number, number][] = [
    [0.02, 0.01, 1.08, 0.14],   // L2
    [0.02, 0, 1.22, 0.0],       // L3
    [0.02, -0.01, 1.12, -0.14], // L4
    [0.05, -0.03, 0.8, -0.2],   // L5
    [0.5, 0.01, 0.52, -0.08],   // travesaño anterior
    [0.72, -0.1, 0.74, -0.18],  // travesaño posterior
  ];
  const puntos = tramos.flatMap(([a, b, c, d]) => [v(a, b), v(c, d)]);
  return new THREE.BufferGeometry().setFromPoints(puntos);
}

/** Un lado de la mosca: el ala derecha y las tres patas derechas. El izquierdo
 *  es el mismo grupo con `scale.z = -1`: se modela una vez y no pueden quedar
 *  asimétricas por error. */
interface Lado {
  plano: THREE.Group;
  barrido: THREE.Group;
  ala: THREE.Group;
  abanico: THREE.MeshBasicMaterial;
  caderas: THREE.Group[];
  rodillas: THREE.Group[];
  tobillos: THREE.Group[];
}

/** Las tres patas de un lado, en el marco del lado (+z hacia afuera): dónde
 *  está la cadera en el tórax, hacia dónde abre en el aire, y dónde apoya el
 *  pie parada, relativo a la cadera. Delanteras adelante, medias al costado,
 *  traseras atrás: la huella de Drosophila. */
const PATAS: { cadera: THREE.Vector3; abre: number; pie: THREE.Vector3 }[] = [
  { cadera: new THREE.Vector3(0.26, -0.17, 0.1), abre: -0.7, pie: new THREE.Vector3(0.58, 0, 0.55) },
  { cadera: new THREE.Vector3(0.08, -0.21, 0.12), abre: -1.6, pie: new THREE.Vector3(0.04, 0, 0.82) },
  { cadera: new THREE.Vector3(-0.1, -0.19, 0.1), abre: -2.4, pie: new THREE.Vector3(-0.62, 0, 0.6) },
];

export class Mosca {
  /** Posición y rumbo. Las armas del boss cuelgan de acá. */
  readonly grupo = new THREE.Group();
  /** Cabeceo, alabeo y vaivén: la animación, separada del rumbo para que
   *  inclinarse no cambie hacia dónde mira. */
  private cuerpo = new THREE.Group();
  /** Cabeza, tórax y abdomen: lo que se aplasta y se estira. Las patas y las
   *  alas quedan fuera para que los pies no patinen al deformarse. */
  private tronco = new THREE.Group();
  private panza: THREE.Mesh;
  private antenas: THREE.Group[] = [];
  private lados: Lado[] = [];
  private ojos: THREE.MeshToonMaterial;
  /** El brillo de cada ojo, que mira siempre a la cámara. Ver `mirar`. */
  private reflejos: { ojo: THREE.Mesh; reflejo: THREE.Mesh }[] = [];
  /** Los materiales que se ponen blancos al recibir un golpe. */
  private piel: THREE.MeshToonMaterial[] = [];
  private destello = 0;

  private p: Pose = structuredClone(POSE[Fase.Idle]);
  private alabeo = 0;
  private cabeceo = 0;
  private brillo = 0;

  private historia: { x: number; y: number; h: number; f: number }[] = [];
  private fantasmas: { o: THREE.Object3D; m: THREE.MeshBasicMaterial }[] = [];
  /** 1 mientras esquiva, y se apaga en unos frames después. */
  private rastro = 0;

  /** 1 con las patas en el suelo, 0 en el aire (la esquiva). Mezcla la pata
   *  que apoya con la pose de vuelo, así despegar y aterrizar no saltan. */
  private suelo = 0;
  /** Fase del paso, de 0 a 1, y cuánto está caminando (0 quieta, 1 a tope):
   *  quieta, los pies vuelven a su lugar en vez de congelarse a medio paso. */
  private paso = 0;
  private marcha = 0;
  private antes: { x: number; y: number; f: number } | null = null;
  private pie = new THREE.Vector3();
  private vuelta = new THREE.Quaternion();
  private aCamara = new THREE.Vector3();
  private luz = new THREE.Vector3();
  private derecha = new THREE.Vector3();
  private traspuesta = new THREE.Matrix3();

  /** Cinemática suavizada continua para las 6 patas en modo neuro-lab */
  private neuroOffsets: [number, number, number][][] = [
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
  ];
  private neuroZ = 0;

  constructor(escena: THREE.Scene, private camara: THREE.Camera) {
    // Esferas suaves y no facetadas: con cel-shading, las bandas de luz
    // dibujan la forma, y las facetas las rompían en astillas.
    const cara = tinta(CABEZA, { emissive: 0xffffff, emissiveIntensity: 0 });
    const rayado = tinta(0xffffff, { vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0 });

    // El tórax, con las cuatro rayas negras longitudinales de la mosca
    // doméstica: desde arriba es lo más reconocible que tiene después de los
    // ojos. Van por vértice, así el tórax sigue siendo una sola malla.
    const geoTorax = new THREE.SphereGeometry(0.36, 32, 20);
    const pt = geoTorax.getAttribute("position");
    const gris = new THREE.Color(QUITINA), negro = new THREE.Color(RAYA);
    const colTorax: number[] = [];
    for (let i = 0; i < pt.count; i++) {
      const x = pt.getX(i) / 0.36, y = pt.getY(i) / 0.36, z = Math.abs(pt.getZ(i) / 0.36);
      const raya = y > 0.15 && x > -0.75 && ((z > 0.07 && z < 0.2) || (z > 0.36 && z < 0.5));
      const c = raya ? negro : gris;
      colTorax.push(c.r, c.g, c.b);
    }
    geoTorax.setAttribute("color", new THREE.Float32BufferAttribute(colTorax, 3));
    const torax = new THREE.Mesh(geoTorax, rayado);
    torax.scale.set(1.1, 0.88, 0.95);
    torax.position.x = 0.1;

    // La cabeza es chica: los ojos se la comen casi entera.
    const cabeza = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), cara);
    cabeza.scale.set(0.75, 0.92, 1.1);
    cabeza.position.set(0.52, 0.03, 0);

    this.panza = new THREE.Mesh(abdomen(), tinta(0xffffff, {
      vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0,
    }));
    this.panza.position.set(-0.16, -0.02, 0);
    this.panza.rotation.z = 0.08; // cuelga un poco
    this.piel.push(cara, rayado, this.panza.material as THREE.MeshToonMaterial);

    // Los ojos compuestos: rojos, enormes, facetados. Cada faceta es un grupo
    // de omatidios y con tres tonos titilan al girar; las aristas en rojo
    // oscuro son la grilla del ojo de mosca. Es el órgano con el que ve venir
    // el golpe —la señal de looming entra por acá— y se aviva al esquivar.
    this.ojos = tinta(OJO, { emissive: 0xff6b5a, emissiveIntensity: 0 });
    // El toon no tiene `flatShading`: las facetas salen de la geometría. El
    // icosaedro no está indexado, así que recalcular normales las deja planas.
    const geoOjo = new THREE.IcosahedronGeometry(R_OJO, 2);
    geoOjo.computeVertexNormals();
    const geoFacetas = new THREE.EdgesGeometry(geoOjo, 1);
    const facetas = new THREE.LineBasicMaterial({ color: OJO_FACETA, transparent: true, opacity: 0.55 });
    const geoReflejo = new THREE.SphereGeometry(0.045, 10, 8);
    const blanco = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const z of [-1, 1]) {
      const ojo = new THREE.Mesh(geoOjo, this.ojos);
      ojo.scale.set(0.78, 1, 0.82);
      ojo.position.set(0.58, 0.07, z * 0.18);
      ojo.castShadow = true;
      contorno(ojo, 1.07);
      const grilla = new THREE.LineSegments(geoFacetas, facetas);
      grilla.scale.setScalar(1.005);
      const reflejo = new THREE.Mesh(geoReflejo, blanco);
      ojo.add(grilla, reflejo);
      this.tronco.add(ojo);
      this.reflejos.push({ ojo, reflejo });
    }

    for (const m of [torax, cabeza, this.panza]) {
      m.castShadow = true;
      contorno(m);
      this.tronco.add(m);
    }

    // La trompa: el tubo que baja de la cabeza y termina en la ventosa con la
    // que la mosca chupa. En el dibujo de una mosca es tan de ella como los
    // ojos.
    const trompa = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.26, 10), cara);
    trompa.position.set(0.63, -0.18, 0);
    trompa.rotation.z = 0.5;
    const ventosa = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), cara);
    ventosa.scale.set(1.2, 0.55, 1.5);
    ventosa.position.set(0.7, -0.3, 0);
    for (const m of [trompa, ventosa]) {
      m.castShadow = true;
      contorno(m, 1.15);
      this.tronco.add(m);
    }

    // Las macroquetas: las cerdas negras del dorso, en pares, y unas pocas en
    // la punta del abdomen. Trazos de tinta, del mismo negro que el contorno.
    const geoCerda = new THREE.ConeGeometry(0.02, 0.24, 4).translate(0, 0.12, 0);
    const tintaCerda = new THREE.MeshBasicMaterial({ color: CERDA });
    for (const [dx, dz] of [[0.18, 0.12], [0.0, 0.17], [-0.16, 0.11], [-0.28, 0.05]]) {
      const y = 0.317 * Math.sqrt(1 - (dx / 0.396) ** 2 - (dz / 0.342) ** 2) * 0.94;
      for (const s of [-1, 1]) {
        const cerda = new THREE.Mesh(geoCerda, tintaCerda);
        cerda.position.set(0.1 + dx, y, dz * s);
        cerda.rotation.set(0.35 * s, 0, 1.05); // hacia atrás y un poco afuera
        this.tronco.add(cerda);
      }
    }
    for (const [x, y, z] of [[-0.85, 0.18, 0.1], [-0.9, 0.15, -0.08], [-0.95, 0.08, 0.02]]) {
      const cerda = new THREE.Mesh(geoCerda, tintaCerda);
      cerda.position.set(x, y, z);
      cerda.rotation.set(z * 3, 0, 1.3);
      this.tronco.add(cerda);
    }

    // Las antenas: un botón gris con la arista, la pluma negra. No hacen nada
    // en el motor, pero tiemblan, y es lo que la hace parecer atenta.
    const geoBoton = new THREE.SphereGeometry(0.045, 10, 8);
    const geoArista = new THREE.ConeGeometry(0.013, 0.2, 4).translate(0, 0.1, 0);
    for (const s of [-1, 1]) {
      const antena = new THREE.Group();
      antena.position.set(0.67, 0.12, 0.05 * s);
      const boton = new THREE.Mesh(geoBoton, cara);
      contorno(boton, 1.25);
      const arista = new THREE.Mesh(geoArista, tintaCerda);
      arista.rotation.set(0.7 * s, 0, -0.6); // arriba, adelante y afuera
      antena.add(boton, arista);
      this.tronco.add(antena);
      this.antenas.push(antena);
    }
    this.cuerpo.add(this.tronco);

    // Alas de dibujo animado: celeste transparente, venas blancas y el borde
    // en tinta oscura, que es lo que las recorta contra el mantel. Sin
    // sombra: una membrana transparente proyectaría una sombra opaca.
    const geoAla = new THREE.ShapeGeometry(formaAla(), 6).rotateX(-Math.PI / 2);
    const geoVenas = venas().rotateX(-Math.PI / 2);
    const geoBorde = new THREE.BufferGeometry()
      .setFromPoints(formaAla().getPoints(12).map((p) => new THREE.Vector3(p.x, 0, -p.y)));
    const membrana = new THREE.MeshBasicMaterial({
      color: MEMBRANA, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
    });
    const vena = new THREE.LineBasicMaterial({ color: VENA, transparent: true, opacity: 0.85 });
    const bordeAla = new THREE.LineBasicMaterial({ color: 0x1f2a36 });
    const geoAbanico = abanico();

    const pata = tinta(PATA, { emissive: 0xffffff, emissiveIntensity: 0 });
    this.piel.push(pata);
    // Un segmento y su contorno. El inverted hull de `contorno` escala desde el
    // origen, que en una pata es la articulación: la alargaría. Acá el casco es
    // el mismo cilindro, más grueso y un pelo más largo por los dos extremos.
    const tinta0 = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
    const hueso = (largo: number, r0: number, r1: number) => {
      const casco = segmento(largo + 0.03, r0 + 0.018, r1 + 0.018).translate(-0.015, 0, 0);
      return [segmento(largo, r0, r1), casco] as const;
    };
    const femur = hueso(FEMUR, 0.065, 0.05);
    const tibia = hueso(TIBIA, 0.046, 0.032);
    const tarso = hueso(TARSO, 0.03, 0.018);

    for (const signo of [1, -1]) {
      const lado = new THREE.Group();
      lado.scale.z = signo;

      // Ala: plano del aleteo (alzada) → barrido → giro sobre su eje largo.
      const plano = new THREE.Group();
      plano.position.set(0.12, 0.25, 0.12);
      const barrido = new THREE.Group();
      const ala = new THREE.Group();
      ala.add(new THREE.Mesh(geoAla, membrana), new THREE.LineSegments(geoVenas, vena),
        new THREE.LineLoop(geoBorde, bordeAla));
      barrido.add(ala);
      // El ala de verdad bate a 200Hz; a 60fps se ve un abanico borroso con el
      // ala congelada en un punto distinto cada frame. Se dibujan las dos cosas.
      const abanico = new THREE.MeshBasicMaterial({
        color: MEMBRANA, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false, vertexColors: true,
      });
      const disco = new THREE.Mesh(geoAbanico, abanico);
      disco.name = "abanico";
      plano.add(disco, barrido);
      lado.add(plano);

      const cs: THREE.Group[] = [], rs: THREE.Group[] = [], ts: THREE.Group[] = [];
      for (const { cadera: c } of PATAS) {
        const cadera = new THREE.Group();
        cadera.position.copy(c);
        cadera.rotation.order = "YZX"; // primero abre, después cae
        const rodilla = new THREE.Group();
        rodilla.position.x = FEMUR;
        const tobillo = new THREE.Group();
        tobillo.position.x = TIBIA;
        for (const [g, [geo, casco]] of [[cadera, femur], [rodilla, tibia], [tobillo, tarso]] as const) {
          const m = new THREE.Mesh(geo, pata);
          m.castShadow = true;
          const borde = new THREE.Mesh(casco, tinta0);
          borde.name = "contorno";
          g.add(m, borde);
        }
        rodilla.add(tobillo);
        cadera.add(rodilla);
        lado.add(cadera);
        cs.push(cadera);
        rs.push(rodilla);
        ts.push(tobillo);
      }

      this.cuerpo.add(lado);
      this.lados.push({ plano, barrido, ala, abanico, caderas: cs, rodillas: rs, tobillos: ts });
    }

    this.grupo.add(this.cuerpo);
    escena.add(this.grupo);

    // Los fantasmas son copias de la mosca congelada en la pose de esquiva, así
    // que la estela ya tiene la silueta del escape y no hay que animarla.
    this.p = structuredClone(POSE[Fase.Dodging]);
    this.posar(0, 0, DE_PIE);
    for (let i = 0; i < FANTASMAS; i++) {
      const f = this.cuerpo.clone();
      const m = new THREE.MeshBasicMaterial({
        color: FANTASMA, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      f.traverse((o) => {
        if (o.name === "contorno" || o.name === "abanico" || o instanceof THREE.LineSegments) {
          o.visible = false;
        } else if (o instanceof THREE.Mesh) {
          o.material = m;
          o.castShadow = false;
        }
      });
      f.visible = false;
      escena.add(f);
      this.fantasmas.push({ o: f, m });
    }
    this.p = structuredClone(POSE[Fase.Idle]);
    this.suelo = 1;
  }

  /** Aplica la pose actual. `fase` es la del aleteo, de 0 a 2π; `alto`, a
   *  cuánto del suelo está el centro del cuerpo. */
  private posar(
    fase: number,
    tick: number,
    alto: number,
    danceOffset?: (k: number, i: number) => [number, number, number],
  ) {
    const p = this.p;
    const bate = p.aleteo * ARCO;
    // Las patas apoyan en el suelo del mundo, no en el del cuerpo: si el
    // cuerpo cabecea, los pies se quedan donde están. Por eso el pie se lleva
    // al marco del lado deshaciendo la rotación de `cuerpo`.
    this.vuelta.copy(this.cuerpo.quaternion).invert();
    this.lados.forEach((l, k) => {
      l.plano.rotation.x = -p.alzada;
      l.barrido.rotation.y = p.barrido + bate * Math.sin(fase);
      // En cada extremo del golpe el ala se da vuelta. Desde arriba se ve como
      // un ala que se afina y se ensancha, que es lo que la hace parecer viva.
      l.ala.rotation.x = 0.9 * Math.cos(fase) * Math.min(p.aleteo, 1);
      l.abanico.opacity = 0.35 * Math.min(p.aleteo, 1);

      const signo = k === 0 ? 1 : -1;
      PATAS.forEach(({ cadera, abre, pie }, i) => {
        // En el aire: la pose, con las patas meciéndose apenas.
        const aire = [abre, p.patas[i] + 0.06 * Math.sin(tick * 0.09 + i * 1.7), p.rodilla, 0.5];
        // En el suelo: trípode. Delantera y trasera de un lado pisan con la
        // media del otro; los dos trípodes, a contrafase.
        const s = (this.paso + ((i + k) % 2) * 0.5) % 1;
        const apoyo = s < 0.5;
        const u = apoyo ? s * 2 : (s - 0.5) * 2;
        // Apoyado, el pie va hacia atrás lo mismo que avanza el cuerpo; en el
        // vuelo vuelve adelante, levantado.
        const ida = apoyo ? 0.5 - u : u * u * (3 - 2 * u) - 0.5;
        const alza = (apoyo ? 0 : ALZA * Math.sin(Math.PI * u)) * this.marcha;
        let froteX = 0, froteY = 0, froteZ = 0;
        if (danceOffset) {
          const [dx, dy, dz] = danceOffset(k, i);
          froteX = dx;
          froteY = dy;
          froteZ = dz;
        } else if (this.marcha < 0.05 && i === 0 && this.suelo > 0.8) {
          const faseGroom = tick % 280;
          if (faseGroom < 80) {
            froteY = 0.05 + 0.015 * Math.sin(tick * 0.3);
            froteX = 0.04 * Math.sin(tick * 0.7 * signo);
            froteZ = -0.07 * signo;
          }
        }
        this.pie.set(
          cadera.x + pie.x + ida * (ZANCADA / 2) * this.marcha + froteX,
          -alto + alza + p.levanta[i] + froteY,
          (cadera.z + pie.z) * signo + froteZ,
        ).applyQuaternion(this.vuelta);
        this.pie.z *= signo;
        const tierra = alcanzar(cadera, this.pie);

        const w = this.suelo;
        const [y, z, r, t] = aire.map((v, j) => v + (tierra[j] - v) * w);
        l.caderas[i].rotation.y = y;
        l.caderas[i].rotation.z = z;
        l.rodillas[i].rotation.z = r;
        l.tobillos[i].rotation.z = t;
      });
    });
  }

  /** El jugador le acertó. Lo llama el render al ver el evento del motor. */
  golpeada() {
    this.destello = DESTELLO;
  }

  /** El brillo de los ojos: un punto blanco que busca siempre la cámara,
   *  arriba a la izquierda, de donde viene la luz. Es lo que los hace de
   *  vidrio y no de goma. */
  private mirar() {
    const c = this.camara.getWorldDirection(this.aCamara).negate();
    this.luz.setFromMatrixColumn(this.camara.matrixWorld, 1)
      .sub(this.derecha.setFromMatrixColumn(this.camara.matrixWorld, 0))
      .multiplyScalar(0.45).add(c);
    for (const { ojo, reflejo } of this.reflejos) {
      // La normal del ojo que en el mundo apunta a `luz` es Mᵀ·luz: las
      // normales se transforman con la inversa traspuesta, y esto la deshace.
      this.traspuesta.setFromMatrix4(ojo.matrixWorld).transpose();
      reflejo.position.copy(this.luz).applyMatrix3(this.traspuesta).setLength(R_OJO * 0.93);
    }
  }

  actualizar(a: Actor, altura: number, tick: number) {
    // La embestida vuela: desde que despega (Active) hasta que aterriza.
    const embiste = a.slot === EMBESTIDA && a.fase === Fase.Active;
    const objetivo = embiste ? POSE_EMBESTIDA : POSE[a.fase];
    const p = this.p;
    for (const k of ["inclinacion", "aleteo", "barrido", "alzada", "rodilla", "altura", "estira"] as const) {
      p[k] += (objetivo[k] - p[k]) * LERP;
    }
    for (let i = 0; i < 3; i++) {
      p.patas[i] += (objetivo.patas[i] - p.patas[i]) * LERP;
      p.levanta[i] += (objetivo.levanta[i] - p.levanta[i]) * LERP;
    }
    const enElAire = a.fase === Fase.Dodging || embiste;
    this.suelo += ((enElAire ? 0 : 1) - this.suelo) * (enElAire ? 0.5 : 0.2);

    // El paso avanza con lo que avanzó el cuerpo, más un poco por girar en el
    // lugar: una mosca que rota también da pasos.
    const s = Math.sin(a.facing), c = Math.cos(a.facing);
    if (this.antes) {
      const avance = Math.abs((a.x - this.antes.x) * c + (a.y - this.antes.y) * s);
      const giro = Math.abs(Math.atan2(Math.sin(a.facing - this.antes.f), Math.cos(a.facing - this.antes.f)));
      // Un salto de posición (la pelea reinicia) no es caminar.
      if (avance < 1) this.paso = (this.paso + (avance + giro * 0.5) / ZANCADA) % 1;
    }
    this.antes = { x: a.x, y: a.y, f: a.facing };
    const rapidez = Math.min(Math.hypot(a.vx, a.vy) / 4.5, 1);
    this.marcha += (rapidez - this.marcha) * 0.2;

    // En el aire se inclina hacia donde va, como un helicóptero: el empuje de
    // las alas apunta a la velocidad. En el suelo camina derecha.
    const adelante = a.vx * c + a.vy * s;
    const costado = -a.vx * s + a.vy * c;
    const lim = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    const vuelo = 1 - this.suelo;
    this.cabeceo += (lim(adelante * 0.05, 0.4) * vuelo - this.cabeceo) * 0.15;
    this.alabeo += (lim(costado * 0.08, 0.6) * vuelo - this.alabeo) * 0.15;

    const alto = DE_PIE + p.altura + vuelo * 0.05 * Math.sin(tick * 0.13);
    const h = altura + alto;
    this.grupo.position.set(a.x, h, a.y);
    this.grupo.rotation.y = -a.facing;
    this.cuerpo.rotation.set(this.alabeo, 0, -(p.inclinacion + this.cabeceo));
    this.posar(tick * ESTROBO, tick, alto);

    const esquiva = a.fase === Fase.Dodging || embiste;
    this.brillo += ((esquiva ? 0.7 : 0) - this.brillo) * (esquiva ? 0.5 : 0.08);
    this.ojos.emissiveIntensity = this.brillo;

    // El golpe recibido: blanco de un frame que se apaga, y un apretón del
    // cuerpo, como si el golpe lo aplastara. Es el "le di" que el jugador
    // necesita ver antes de mirar la barra.
    const blanco = this.destello / DESTELLO;
    if (this.destello > 0) this.destello--;
    for (const m of this.piel) m.emissiveIntensity = 0.85 * blanco;
    const e = p.estira - 0.25 * blanco;
    this.tronco.scale.set(1 + e, 1 + 0.5 * e, 1 - 0.7 * e);
    // El abdomen bombea, que es como respira Drosophila: quieta, es lo que la
    // hace parecer viva. Las antenas tiemblan a otro ritmo, cada una al suyo.
    const bombea = 1 + 0.035 * Math.sin(tick * 0.11);
    this.panza.scale.set(1, bombea, bombea);
    this.antenas.forEach((an, i) => {
      an.rotation.set(0.14 * Math.sin(tick * 0.23 + i * 2.1), 0, 0.12 * Math.sin(tick * 0.17 + i));
    });
    this.grupo.updateMatrixWorld(true);
    this.mirar();

    this.historia.unshift({ x: a.x, y: a.y, h, f: a.facing });
    if (this.historia.length > HISTORIA) this.historia.pop();
    this.rastro = esquiva ? 1 : Math.max(0, this.rastro - 0.1);
    this.fantasmas.forEach(({ o, m }, i) => {
      const e = this.historia[2 + i * 3];
      o.visible = this.rastro > 0 && e !== undefined;
      if (!e) return;
      o.position.set(e.x, e.h, e.y);
      o.rotation.set(this.alabeo, -e.f, 0, "YXZ");
      m.opacity = 0.3 * (1 - i / FANTASMAS) * this.rastro;
    });
  }

  /**
   * Modo Baile: ejecuta la coreografía de 5 fases sincronizada con la pista de audio a 156.5 BPM.
   * Modifica poses, deformación elástica, batido de alas y posición de las 6 patas.
   */
  actualizarBaile(
    tSegundos: number,
    tick: number,
    beat: number,
    bajo: number,
    centroArena: { x: number; y: number },
  ): InfoBaile {
    this.suelo = 1;
    this.marcha = 0;
    const ciclo = tSegundos % 30.22;

    let pasoNombre = "";
    let circuitoNombre = "";
    let region: InfoBaile["region"] = "t1_izq";
    let intensidad = 1.0;

    let targetInclinacion = 0;
    let targetCabeceo = 0;
    let targetAlabeo = 0;
    let targetAltura = 0;
    let targetEstira = 0;
    let targetAleteo = 0;
    let targetBarrido = -3.2;
    let targetAlzada = 0.06;
    let targetRodilla = -1.9;
    let facing = 0.4;

    let offsetPata: (k: number, i: number) => [number, number, number];

    if (ciclo < 4.5) {
      // FASE 1: THE BECKON (0s - 4.5s)
      pasoNombre = "THE BECKON";
      circuitoNombre = "T1-L MOTOR NEURONS (LEFT FRONT LEG)";
      region = "t1_izq";
      intensidad = 0.7 + 0.3 * bajo;

      targetInclinacion = -0.22;
      targetCabeceo = 0.08 * Math.sin(beat * Math.PI);
      targetAlabeo = 0.06 * Math.sin(beat * Math.PI * 0.5);
      targetAltura = 0.02;
      targetEstira = 0.04 * Math.sin(beat * Math.PI);
      targetAleteo = 0.25 * bajo;
      targetBarrido = -2.3 + 0.12 * Math.sin(beat * Math.PI);
      targetAlzada = 0.16;

      offsetPata = (k, i) => {
        const signo = k === 0 ? 1 : -1;
        if (i === 0 && k === 0) {
          const llamando = Math.sin(beat * Math.PI * 2);
          return [0.24 + 0.12 * llamando, 0.32 + 0.08 * Math.cos(beat * Math.PI * 2), 0.12];
        }
        if (i === 0 && k === 1) {
          return [0, 0.05 * Math.max(0, Math.sin(beat * Math.PI * 2)), 0];
        }
        return [0, 0.02 * Math.sin(beat * Math.PI + i), 0.03 * signo];
      };
    } else if (ciclo < 9.0) {
      // FASE 2: THE LOW BOUNCE (4.5s - 9.0s)
      pasoNombre = "THE LOW BOUNCE";
      circuitoNombre = "T2-T3 FLEXOR MOTOR NEURONS";
      region = "t2_t3";
      intensidad = 0.8 + 0.4 * bajo;

      const bounce = Math.abs(Math.sin(beat * Math.PI));
      targetAltura = -0.22 + 0.12 * bounce;
      targetEstira = -0.26 * bounce;
      targetInclinacion = 0.18;
      targetCabeceo = -0.12 * bounce;
      targetRodilla = -1.15 + 0.35 * bounce;
      targetAleteo = 0.45 * bounce;
      targetBarrido = -2.5;
      targetAlzada = 0.12;

      offsetPata = (k, i) => {
        const signo = k === 0 ? 1 : -1;
        if (i === 0) {
          return [-0.06, 0.08 + 0.04 * bounce, -0.16 * signo];
        }
        if (i === 1) {
          return [0, 0, 0.20 * signo];
        }
        return [-0.04, 0, 0.06 * signo];
      };
    } else if (ciclo < 16.5) {
      // FASE 3: CHEST PUMP & WING FLEX (9.0s - 16.5s)
      pasoNombre = "CHEST PUMP & WING FLEX";
      circuitoNombre = "DLM/DVM FLIGHT POWER MUSCLES";
      region = "alas";
      intensidad = 1.0;

      const pump = Math.max(0, Math.sin(beat * Math.PI));
      targetInclinacion = 0.28 * Math.sin(beat * Math.PI);
      targetEstira = 0.26 * pump;
      targetAltura = 0.05 + 0.05 * pump;
      targetAleteo = 1.35 * Math.abs(Math.sin(beat * Math.PI));
      targetBarrido = -1.6 + 0.35 * Math.cos(beat * Math.PI);
      targetAlzada = 0.38;

      offsetPata = (k, i) => {
        const signo = k === 0 ? 1 : -1;
        if (i === 0) {
          return [0.16, 0.44 + 0.12 * pump, 0.08 * signo];
        }
        return [-0.04 * pump, 0, 0];
      };
    } else if (ciclo < 23.5) {
      // FASE 4: CROSS-ARM CHILL FREEZE (16.5s - 23.5s)
      pasoNombre = "CROSS-ARM CHILL FREEZE";
      circuitoNombre = "DOPAMINE PAM/PPL1 & P1 COURTSHIP";
      region = "dopamina";
      intensidad = 0.6 + 0.2 * bajo;

      const sway = Math.sin(beat * Math.PI * 0.5);
      targetAlabeo = 0.22 * sway;
      targetInclinacion = -0.08;
      targetCabeceo = 0.10;
      targetAltura = 0.01;
      targetEstira = 0.02;
      targetAleteo = 0.05 * bajo;
      targetBarrido = -3.2;
      targetAlzada = 0.06;

      offsetPata = (k, i) => {
        const signo = k === 0 ? 1 : -1;
        if (i === 0) {
          return [0.12, 0.28, -0.26 * signo];
        }
        return [0, (signo > 0 ? 0.06 : -0.06) * sway, 0];
      };
    } else {
      // FASE 5: GROOMING BREAKDANCE & 360 SPIN (23.5s - 30.22s)
      pasoNombre = "GROOMING BREAKDANCE (360° SPIN)";
      circuitoNombre = "CPG GROOMING & VENTRAL NERVE CORD";
      region = "grooming";
      intensidad = 1.0;

      const tFase = ciclo - 23.5;
      const spin = (tFase / 6.0) * Math.PI * 2;
      facing = 0.4 + spin;

      if (ciclo >= 29.6) {
        pasoNombre = "FINAL FREEZE";
        targetAltura = 0.12;
        targetInclinacion = -0.15;
        targetEstira = 0.15;
        targetAleteo = 1.0;
        targetBarrido = -1.5;
        targetAlzada = 0.4;
        offsetPata = (k, i) => {
          if (i === 0 && k === 0) return [0.1, 0.65, 0.2];
          if (i === 0 && k === 1) return [-0.05, 0.22, -0.1];
          return [0, 0, 0];
        };
      } else {
        targetAltura = 0.06 + 0.04 * Math.sin(beat * Math.PI * 2);
        targetEstira = 0.12 * Math.sin(beat * Math.PI * 2);
        targetAleteo = 1.15;
        targetBarrido = -1.8;
        targetAlzada = 0.25;

        offsetPata = (k, i) => {
          const signo = k === 0 ? 1 : -1;
          if (i === 0) {
            const roll = tSegundos * 18;
            return [
              0.18 + 0.08 * Math.cos(roll),
              0.34 + 0.08 * Math.sin(roll * signo),
              -0.14 * signo + 0.06 * Math.sin(roll),
            ];
          }
          const tap = Math.max(0, Math.sin(beat * Math.PI * 2 + (i + k) * Math.PI));
          return [0, 0.08 * tap, 0];
        };
      }
    }

    // Suavizado
    const p = this.p;
    p.inclinacion += (targetInclinacion - p.inclinacion) * 0.35;
    p.altura += (targetAltura - p.altura) * 0.35;
    p.estira += (targetEstira - p.estira) * 0.35;
    p.aleteo += (targetAleteo - p.aleteo) * 0.35;
    p.barrido += (targetBarrido - p.barrido) * 0.35;
    p.alzada += (targetAlzada - p.alzada) * 0.35;
    p.rodilla += (targetRodilla - p.rodilla) * 0.35;
    this.cabeceo += (targetCabeceo - this.cabeceo) * 0.35;
    this.alabeo += (targetAlabeo - this.alabeo) * 0.35;

    const alto = DE_PIE + p.altura;
    this.grupo.position.set(centroArena.x, alto, centroArena.y);
    this.grupo.rotation.y = -facing;
    this.cuerpo.rotation.set(this.alabeo, 0, -(p.inclinacion + this.cabeceo));

    this.posar(tick * ESTROBO, tick, alto, offsetPata);

    const e = p.estira;
    this.tronco.scale.set(1 + e, 1 + 0.5 * e, 1 - 0.7 * e);
    const bombea = 1 + 0.06 * Math.sin(beat * Math.PI * 2);
    this.panza.scale.set(1, bombea, bombea);

    this.antenas.forEach((an, i) => {
      an.rotation.set(
        0.2 * Math.sin(beat * Math.PI * 2 + i * 2.1),
        0,
        0.18 * Math.sin(beat * Math.PI + i),
      );
    });

    this.ojos.emissiveIntensity = 0.2 + 0.6 * bajo;
    this.grupo.updateMatrixWorld(true);
    this.mirar();

    return {
      pasoNombre,
      circuitoNombre,
      region,
      intensidad,
    };
  }

  /**
   * Modo Neuroestimulación: acoplamiento cinemático biomecánico directo.
   * Modifica en tiempo real poses, postura, ángulos articulares de las 6 patas y alas
   * en respuesta directa a los canales optogenéticos estimulados.
   */
  actualizarNeuroestimulacion(
    canales: CanalesEstimulacion,
    tick: number,
    dt: number,
    centroArena: { x: number; y: number },
  ) {
    this.suelo = 1;

    const t1L = canales.t1_izq || 0;
    const t1R = canales.t1_der || 0;
    const t23 = canales.t2_t3 || 0;
    const alas = canales.alas || 0;
    const mdn = canales.moonwalker || 0;
    const court = canales.courtship || 0;

    // Respiración y balanceo micro-orgánico continuo para evitar rigidez
    const respiro = 0.016 * Math.sin(tick * 0.07);
    const balanceo = 0.012 * Math.cos(tick * 0.05);

    let targetInclinacion = 0.04;
    let targetCabeceo = 0;
    let targetAlabeo = balanceo;
    let targetAltura = respiro;
    let targetEstira = 0;
    let targetAleteo = 0;
    let targetBarrido = -3.2;
    let targetAlzada = 0.06;
    let targetRodilla = -1.9;

    // 1. T1: Extensión y gestualidad rítmica de patas delanteras (The Reach & Swipe)
    const minT1 = Math.min(t1L, t1R);
    if (minT1 > 0.08) {
      // Doble elevación celebratoria (pump)
      targetInclinacion -= 0.22 * minT1;
      targetAltura += 0.05 * minT1;
      targetEstira += 0.12 * minT1;
    } else {
      if (t1L > 0.03) {
        targetInclinacion -= 0.14 * t1L;
        targetAlabeo -= 0.16 * t1L;
        targetCabeceo += 0.07 * t1L;
        targetAltura += 0.025 * t1L;
      }
      if (t1R > 0.03) {
        targetInclinacion -= 0.14 * t1R;
        targetAlabeo += 0.16 * t1R;
        targetCabeceo += 0.07 * t1R;
        targetAltura += 0.025 * t1R;
      }
    }

    // 2. T2-T3: Sentadilla torácica profunda y rebote elástico (The Bass Squat)
    if (t23 > 0.03) {
      targetAltura -= 0.25 * t23;
      targetEstira -= 0.24 * t23;
      targetInclinacion += 0.15 * t23;
      targetRodilla = -1.9 * (1 - t23) + (-1.0) * t23;
    }

    // 3. ALAS: Motores de vuelo y vibración resonante (DLM / DVM)
    if (alas > 0.03) {
      targetAleteo += 1.45 * alas;
      targetBarrido = -3.2 * (1 - alas) + (-1.45) * alas;
      targetAlzada = 0.06 * (1 - alas) + 0.36 * alas;
      targetEstira += 0.15 * alas * Math.sin(tick * 0.55);
    }

    // 4. MOONWALKER: MDN marcha en reversa y deslizamiento fluido
    if (mdn > 0.03) {
      this.marcha = Math.min(1.0, this.marcha + (mdn * 0.95 - this.marcha) * 0.18);
      // Tripod gait invertido suave
      this.paso = (this.paso - dt * 2.8 * mdn + 1.0) % 1.0;
      targetInclinacion += 0.15 * mdn;
      targetCabeceo += 0.06 * mdn * Math.sin(this.paso * Math.PI * 2);
      const targetZ = Math.sin(this.paso * Math.PI * 2) * 0.14;
      this.neuroZ += (targetZ - this.neuroZ) * 0.16;
    } else {
      this.marcha += (0 - this.marcha) * 0.14;
      this.neuroZ += (0 - this.neuroZ) * 0.14;
    }

    // 5. COURTSHIP: P1 despliegue de cortejo y vibración unilateral de ala
    if (court > 0.03) {
      targetAlabeo += 0.24 * court * Math.sin(tick * 0.16);
      targetInclinacion -= 0.10 * court;
      targetBarrido = -3.2 * (1 - court * 0.65) + (-1.65) * (court * 0.65);
      targetAleteo = Math.max(targetAleteo, 0.55 * court);
    }

    // Suavizado dinámico de la pose corporal con factor críticamente amortiguado (0.18)
    const factorPose = 0.18;
    const p = this.p;
    p.inclinacion += (targetInclinacion - p.inclinacion) * factorPose;
    p.altura += (targetAltura - p.altura) * factorPose;
    p.estira += (targetEstira - p.estira) * factorPose;
    p.aleteo += (targetAleteo - p.aleteo) * factorPose;
    p.barrido += (targetBarrido - p.barrido) * factorPose;
    p.alzada += (targetAlzada - p.alzada) * factorPose;
    p.rodilla += (targetRodilla - p.rodilla) * factorPose;
    this.cabeceo += (targetCabeceo - this.cabeceo) * factorPose;
    this.alabeo += (targetAlabeo - this.alabeo) * factorPose;

    // Matriz de posiciones deseadas (targets) para las 6 patas
    const targets: [number, number, number][][] = [
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    ];

    for (let k = 0; k < 2; k++) {
      const signo = k === 0 ? 1 : -1;
      // Patas delanteras T1
      let dx0 = 0, dy0 = 0, dz0 = 0;
      if (k === 0 && t1L > 0.02) {
        dx0 = (0.24 + 0.06 * Math.cos(tick * 0.25)) * t1L;
        dy0 = (0.34 + 0.06 * Math.sin(tick * 0.28)) * t1L;
        dz0 = 0.12 * t1L;
      }
      if (k === 1 && t1R > 0.02) {
        dx0 = (0.24 + 0.06 * Math.cos(tick * 0.25)) * t1R;
        dy0 = (0.34 + 0.06 * Math.cos(tick * 0.28)) * t1R;
        dz0 = -0.12 * t1R;
      }
      if (court > 0.03) {
        dx0 += 0.10 * court;
        dy0 += (0.20 + 0.05 * Math.sin(tick * 0.35)) * court;
        dz0 += -0.18 * signo * court;
      }
      targets[k][0] = [dx0, dy0, dz0];

      // Patas intermedias T2
      let dx1 = 0, dy1 = 0, dz1 = 0;
      if (t23 > 0.02) {
        dx1 = -0.06 * t23;
        dy1 = 0.06 * t23;
        dz1 = 0.20 * signo * t23;
      }
      targets[k][1] = [dx1, dy1, dz1];

      // Patas traseras T3
      let dx2 = 0, dy2 = 0, dz2 = 0;
      if (t23 > 0.02) {
        dx2 = -0.04 * t23;
        dy2 = 0.04 * t23;
        dz2 = 0.14 * signo * t23;
      }
      targets[k][2] = [dx2, dy2, dz2];
    }

    // Suavizado continuo de las 6 patas: elimina todo temblor y salto discontinuo
    const lerpPatas = 0.18;
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < 3; i++) {
        for (let axis = 0; axis < 3; axis++) {
          this.neuroOffsets[k][i][axis] += (targets[k][i][axis] - this.neuroOffsets[k][i][axis]) * lerpPatas;
        }
      }
    }

    const offsetPata = (k: number, i: number): [number, number, number] => {
      return this.neuroOffsets[k][i];
    };

    const alto = DE_PIE + p.altura;
    this.grupo.position.set(centroArena.x, alto, centroArena.y + this.neuroZ);
    this.grupo.rotation.y = -0.4;
    this.cuerpo.rotation.set(this.alabeo, 0, -(p.inclinacion + this.cabeceo));

    this.posar(tick * ESTROBO, tick, alto, offsetPata);

    const e = p.estira;
    this.tronco.scale.set(1 + e, 1 + 0.5 * e, 1 - 0.7 * e);
    const pump = alas > 0.05 ? 1 + 0.12 * alas * Math.sin(tick * 0.6) : 1 + 0.035 * Math.sin(tick * 0.11);
    this.panza.scale.set(1, pump, pump);

    this.antenas.forEach((an, i) => {
      const freq = court > 0.1 ? 0.6 : 0.15;
      an.rotation.set(
        0.2 * Math.sin(tick * freq + i * 2.1),
        0,
        0.18 * Math.sin(tick * freq * 0.8 + i),
      );
    });

    this.ojos.emissive.setHex(0xff6b5a);
    this.ojos.emissiveIntensity = 0;
    this.grupo.updateMatrixWorld(true);
    this.mirar();
  }
}
