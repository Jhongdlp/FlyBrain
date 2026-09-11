// El boss es una mosca. Drosophila, procedural y low-poly: primitivas facetadas
// animadas por pose, sin pipeline de assets, igual que el resto de la escena.
//
// La cámara mira desde arriba a 60°, así que lo que manda es la silueta dorsal:
// alas, tórax y los dos ojos compuestos. Las patas casi no se ven desde arriba,
// pero dibujan la sombra, y la sombra es lo que dice "insecto" en el suelo.
//
// Todo acá es presentación: lee el `Actor` del motor y no decide nada.

import * as THREE from "three";
import { Actor, Fase } from "./engine";

// Mismo monocromo frío que la escena. Los ojos llevan el acento cian de las
// armas y no el rojo de Drosophila: ese rojo está reservado para el peligro.
const QUITINA = 0xd4dfe9;
const BANDA = 0x566779;
const PATA = 0x26323f;
const OJO = 0x121d28;
const OJO_BRILLO = 0x2fb4d8;
const MEMBRANA = 0xcfe6f5;
const VENA = 0x9fc4dc;
const FANTASMA = 0x7fd8ff;

/** Largo del ala desde la bisagra. La envergadura sale mayor que el hitbox
 *  (0.9) a propósito: lo que golpea es el cuerpo, las alas son aire. */
const ALA = 1.25;
/** Semiamplitud del aleteo en el suelo de la pose, en radianes. */
const ARCO = 1.0;
/** Frames de estela guardados y fantasmas dibujados con ellos. */
const HISTORIA = 12;
const FANTASMAS = 4;

/** Contornos por inverted hull: malla duplicada, escalada, negra, BackSide. */
export function contorno(malla: THREE.Mesh, grosor = 1.06): THREE.Mesh {
  const m = new THREE.Mesh(
    malla.geometry,
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
  );
  m.name = "contorno";
  m.scale.multiplyScalar(grosor);
  malla.add(m);
  return m;
}

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
  /** Caída de cada par de patas (delantero, medio, trasero). */
  patas: [number, number, number];
  rodilla: number;
  /** Altura extra del vuelo. Carga agachándose, esquiva saltando. */
  altura: number;
}

/**
 * - **Carga**: pliega las alas en V sobre el abdomen, se echa atrás y levanta
 *   las patas delanteras. Desde arriba el abanico desaparece de golpe: es el
 *   cambio de silueta más grande que tiene, y por eso es la telegrafía.
 * - **Golpe**: abre las alas de un latigazo y se tira adelante.
 * - **Esquiva**: el escape de la fibra gigante tal como lo hace la mosca real —
 *   alas arriba, patas medias extendidas para el salto. Es la única acción que
 *   hoy maneja el conectoma, así que es la que tiene que verse mejor.
 */
const POSE: Record<Fase, Pose> = {
  [Fase.Idle]: {
    inclinacion: 0.05, aleteo: 1, barrido: -1.75, alzada: 0.15,
    patas: [-0.3, -0.35, -0.45], rodilla: -1.9, altura: 0,
  },
  [Fase.Windup]: {
    inclinacion: -0.3, aleteo: 0, barrido: -2.8, alzada: 0.05,
    patas: [0.35, -0.45, -0.6], rodilla: -0.6, altura: -0.1,
  },
  [Fase.Active]: {
    inclinacion: 0.5, aleteo: 1.2, barrido: -1.4, alzada: 0.3,
    patas: [0.1, -0.5, -0.5], rodilla: -0.45, altura: 0.05,
  },
  [Fase.Recovery]: {
    inclinacion: 0.15, aleteo: 0.8, barrido: -1.85, alzada: 0.1,
    patas: [-0.3, -0.4, -0.5], rodilla: -1.7, altura: -0.05,
  },
  [Fase.Dodging]: {
    inclinacion: 0.2, aleteo: 0.35, barrido: -2.0, alzada: 1.15,
    patas: [-0.6, -1.3, -0.85], rodilla: -0.2, altura: 0.25,
  },
};

const LERP = 0.28;
/** Ángulo dorado: muestrear el aleteo con él da una fase distinta cada frame
 *  sin patrón visible. Es lo que se ve al filmar a 60fps un ala que bate a
 *  200Hz, y sale del tick, así que un video de la misma pelea es idéntico. */
const ESTROBO = 2.39996;

const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.6, ...extra });

/** Segmento de pata a lo largo de +X local, con su origen en la articulación. */
function segmento(largo: number, r0: number, r1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, largo, 5);
  g.rotateZ(-Math.PI / 2);
  g.translate(largo / 2, 0, 0);
  return g;
}

/** Abdomen de revolución, apuntando a -X, con los terguitos marcados: una
 *  cintura en cada borde de segmento y la banda oscura detrás de cada uno, que
 *  es el dibujo de Drosophila. El color va por vértice para que sea una malla. */
function abdomen(): THREE.BufferGeometry {
  const L = 0.9, R = 0.3, SEG = 6;
  const perfil: THREE.Vector2[] = [];
  for (let i = 0; i <= 36; i++) {
    const s = i / 36;
    const cintura = Math.pow(Math.cos(Math.PI * s * SEG), 16);
    const r = R * Math.pow(Math.sin(Math.PI * (0.15 + 0.85 * s)), 0.8) * (1 - 0.09 * cintura);
    perfil.push(new THREE.Vector2(Math.max(r, 0.001), s * L));
  }
  const g = new THREE.LatheGeometry(perfil, 10);
  const uv = g.getAttribute("uv");
  const claro = new THREE.Color(QUITINA), oscuro = new THREE.Color(BANDA), c = new THREE.Color();
  const colores: number[] = [];
  for (let i = 0; i < uv.count; i++) {
    const s = uv.getY(i);
    const t = (s * SEG) % 1;
    c.copy(claro).lerp(oscuro, t > 0.55 || s > 0.85 ? 1 : 0);
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
  const t0 = POSE[Fase.Idle].barrido - ARCO;
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
  const borde = formaAla().getPoints(12);
  for (let i = 0; i < borde.length; i++) {
    const p = borde[i], q = borde[(i + 1) % borde.length];
    puntos.push(v(p.x, p.y), v(q.x, q.y));
  }
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
}

export class Mosca {
  /** Posición y rumbo. Las armas del boss cuelgan de acá. */
  readonly grupo = new THREE.Group();
  /** Cabeceo, alabeo y vaivén: la animación, separada del rumbo para que
   *  inclinarse no cambie hacia dónde mira. */
  private cuerpo = new THREE.Group();
  private lados: Lado[] = [];
  private ojos: THREE.MeshStandardMaterial;

  private p: Pose = structuredClone(POSE[Fase.Idle]);
  private alabeo = 0;
  private cabeceo = 0;
  private brillo = 0;

  private historia: { x: number; y: number; h: number; f: number }[] = [];
  private fantasmas: { o: THREE.Object3D; m: THREE.MeshBasicMaterial }[] = [];
  /** 1 mientras esquiva, y se apaga en unos frames después. */
  private rastro = 0;

  constructor(escena: THREE.Scene) {
    const quitina = mat(QUITINA);

    const torax = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 7), quitina);
    torax.scale.set(1.1, 0.88, 0.95);
    torax.position.x = 0.1;

    const cabeza = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 7), quitina);
    cabeza.scale.set(0.7, 0.9, 1.15);
    cabeza.position.set(0.52, 0.03, 0);

    const panza = new THREE.Mesh(abdomen(), mat(0xffffff, { vertexColors: true }));
    panza.position.set(-0.18, -0.02, 0);
    panza.rotation.z = 0.12; // cuelga un poco, como en vuelo

    // Los ojos compuestos son la mitad de la cabeza y el órgano con el que la
    // mosca ve venir el golpe: la señal de looming entra por acá. Icosaedro
    // facetado, cada cara un grupo de omatidios. Se encienden al esquivar.
    this.ojos = mat(OJO, {
      roughness: 0.2, metalness: 0.2, emissive: OJO_BRILLO, emissiveIntensity: 0.5,
    });
    const geoOjo = new THREE.IcosahedronGeometry(0.2, 1);
    for (const z of [-1, 1]) {
      const ojo = new THREE.Mesh(geoOjo, this.ojos);
      ojo.scale.set(0.75, 1, 0.78);
      ojo.position.set(0.56, 0.05, z * 0.17);
      ojo.castShadow = true;
      contorno(ojo, 1.08);
      this.cuerpo.add(ojo);
    }

    for (const m of [torax, cabeza, panza]) {
      m.castShadow = true;
      contorno(m);
      this.cuerpo.add(m);
    }

    const geoAla = new THREE.ShapeGeometry(formaAla(), 6).rotateX(-Math.PI / 2);
    const geoVenas = venas().rotateX(-Math.PI / 2);
    // Membrana iridiscente: las alas de mosca hacen interferencia de capa fina
    // de verdad. Sin sombra: una membrana transparente proyectaría una sombra
    // opaca, y la sombra del cuerpo ya dice todo lo que hace falta.
    const membrana = new THREE.MeshPhysicalMaterial({
      color: MEMBRANA, transparent: true, opacity: 0.32, roughness: 0.25,
      iridescence: 1, iridescenceIOR: 1.35, iridescenceThicknessRange: [180, 520],
      side: THREE.DoubleSide, depthWrite: false,
    });
    const vena = new THREE.LineBasicMaterial({ color: VENA, transparent: true, opacity: 0.75 });
    const geoAbanico = abanico();

    const pata = mat(PATA, { roughness: 0.8 });
    const femur = segmento(0.36, 0.035, 0.03);
    const tibia = segmento(0.42, 0.028, 0.02);
    const tarso = segmento(0.2, 0.018, 0.01);
    const caderas: [number, number, number, number][] = [
      // x, y, z de la cadera en el tórax, y hacia dónde abre la pata
      [0.26, -0.17, 0.1, -0.7],
      [0.08, -0.21, 0.12, -1.6],
      [-0.1, -0.19, 0.1, -2.4],
    ];

    for (const signo of [1, -1]) {
      const lado = new THREE.Group();
      lado.scale.z = signo;

      // Ala: plano del aleteo (alzada) → barrido → giro sobre su eje largo.
      const plano = new THREE.Group();
      plano.position.set(0.12, 0.25, 0.12);
      const barrido = new THREE.Group();
      const ala = new THREE.Group();
      ala.add(new THREE.Mesh(geoAla, membrana), new THREE.LineSegments(geoVenas, vena));
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

      const cs: THREE.Group[] = [], rs: THREE.Group[] = [];
      for (const [x, y, z, abre] of caderas) {
        const cadera = new THREE.Group();
        cadera.position.set(x, y, z);
        cadera.rotation.order = "YZX"; // primero abre, después cae
        cadera.rotation.y = abre;
        const rodilla = new THREE.Group();
        rodilla.position.x = 0.36;
        const tobillo = new THREE.Group();
        tobillo.position.x = 0.42;
        tobillo.rotation.z = 0.5; // el tarso abre hacia afuera
        for (const [g, geo] of [[cadera, femur], [rodilla, tibia], [tobillo, tarso]] as const) {
          const m = new THREE.Mesh(geo, pata);
          m.castShadow = true;
          g.add(m);
        }
        rodilla.add(tobillo);
        cadera.add(rodilla);
        lado.add(cadera);
        cs.push(cadera);
        rs.push(rodilla);
      }

      this.cuerpo.add(lado);
      this.lados.push({ plano, barrido, ala, abanico, caderas: cs, rodillas: rs });
    }

    this.grupo.add(this.cuerpo);
    escena.add(this.grupo);

    // Los fantasmas son copias de la mosca congelada en la pose de esquiva, así
    // que la estela ya tiene la silueta del escape y no hay que animarla.
    this.p = structuredClone(POSE[Fase.Dodging]);
    this.posar(0, 0);
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
  }

  /** Aplica la pose actual. `fase` es la del aleteo, de 0 a 2π. */
  private posar(fase: number, tick: number) {
    const p = this.p;
    const bate = p.aleteo * ARCO;
    for (const l of this.lados) {
      l.plano.rotation.x = -p.alzada;
      l.barrido.rotation.y = p.barrido + bate * Math.sin(fase);
      // En cada extremo del golpe el ala se da vuelta. Desde arriba se ve como
      // un ala que se afina y se ensancha, que es lo que la hace parecer viva.
      l.ala.rotation.x = 0.9 * Math.cos(fase) * Math.min(p.aleteo, 1);
      l.abanico.opacity = 0.35 * Math.min(p.aleteo, 1);
      l.caderas.forEach((c, i) => {
        // Las patas cuelgan y se mecen apenas, desfasadas entre pares.
        c.rotation.z = p.patas[i] + 0.06 * Math.sin(tick * 0.09 + i * 1.7);
      });
      for (const r of l.rodillas) r.rotation.z = p.rodilla;
    }
  }

  actualizar(a: Actor, altura: number, tick: number) {
    const objetivo = POSE[a.fase];
    const p = this.p;
    for (const k of ["inclinacion", "aleteo", "barrido", "alzada", "rodilla", "altura"] as const) {
      p[k] += (objetivo[k] - p[k]) * LERP;
    }
    for (let i = 0; i < 3; i++) p.patas[i] += (objetivo.patas[i] - p.patas[i]) * LERP;

    // Se inclina hacia donde va, como un helicóptero: el empuje de las alas
    // apunta a la velocidad. Sale de la velocidad del motor, no se inventa.
    const s = Math.sin(a.facing), c = Math.cos(a.facing);
    const adelante = a.vx * c + a.vy * s;
    const costado = -a.vx * s + a.vy * c;
    const lim = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    this.cabeceo += (lim(adelante * 0.05, 0.4) - this.cabeceo) * 0.15;
    this.alabeo += (lim(costado * 0.08, 0.6) - this.alabeo) * 0.15;

    const h = altura + p.altura + 0.05 * Math.sin(tick * 0.13);
    this.grupo.position.set(a.x, h, a.y);
    this.grupo.rotation.y = -a.facing;
    this.cuerpo.rotation.set(this.alabeo, 0, -(p.inclinacion + this.cabeceo));
    this.posar(tick * ESTROBO, tick);

    const esquiva = a.fase === Fase.Dodging;
    this.brillo += ((esquiva ? 2.4 : 0.5) - this.brillo) * (esquiva ? 0.5 : 0.08);
    this.ojos.emissiveIntensity = this.brillo;

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
}
