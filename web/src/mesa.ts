// La arena: una bandeja de madera con un mantel de cuadros, vista a escala de
// mosca. Minimalista a propósito: el mantel, unas migas y la madera. Lo que se
// mueve en pantalla es la pelea y nada más.
//
// **Todo lo que bloquea ocupa exactamente su rectángulo.** Cada `Estatico` del
// motor es un bloque de madera con esa misma planta, y el borde de la bandeja
// va por fuera de la arena, que es donde el motor para a todos.
//
// La paleta: mantel azul marino, para que resalten las tres cosas que
// importan —la mosca ámbar, el jugador azul pálido y el rojo del peligro—.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Estatico } from "./engine";
import { azar, tinta } from "./tinta";

/** Oscuro (cruce de franjas), medio (una franja) y claro (sin franja). */
const MANTEL = ["#1a3152", "#284870", "#3b6596"];
const MADERA = 0xc9925a;
/** Las cajas que se empujan: madera más clara, para que no se confundan con
 *  las paredes que no se mueven. */
const PINO = 0xf0cf95;
const MESA = 0x3a281d;
const MIGA = 0xc99255;

/** Alto de las paredes de adentro. `Render.encuadrar` lo usa para que entren. */
export const ALTURA_MURO = 1.5;
/** Ancho y alto del borde de la bandeja, por fuera de la arena. */
const BORDE = 0.8;
const BORDE_ALTO = 0.9;

function lienzo(w: number, h: number, pintar: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  pintar(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Un período de vichy: dos cuadros por lado, con la trama del tejido. */
function vichy(): THREE.Texture {
  const n = 128;
  return lienzo(n, n, (g) => {
    g.fillStyle = MANTEL[2];
    g.fillRect(0, 0, n, n);
    g.fillStyle = MANTEL[1];
    g.fillRect(0, 0, n / 2, n);
    g.fillRect(0, 0, n, n / 2);
    g.fillStyle = MANTEL[0];
    g.fillRect(0, 0, n / 2, n / 2);
    // Los hilos: finos, en las dos direcciones, apenas visibles.
    g.lineWidth = 1;
    for (let i = 0; i < n; i += 3) {
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.beginPath(); g.moveTo(0, i + 0.5); g.lineTo(n, i + 0.5); g.stroke();
      g.strokeStyle = "rgba(0,0,0,0.07)";
      g.beginPath(); g.moveTo(i + 1.5, 0); g.lineTo(i + 1.5, n); g.stroke();
    }
  });
}

/** Vetas de madera a lo largo de U. */
function vetas(): THREE.Texture {
  const r = azar(7);
  return lienzo(256, 64, (g) => {
    g.fillStyle = "#c08a52";
    g.fillRect(0, 0, 256, 64);
    // Pocas vetas y suaves: la madera tiene que leerse como madera sin
    // hacer ruido al lado de la pelea.
    for (let i = 0; i < 12; i++) {
      g.strokeStyle = `rgba(90,50,22,${0.06 + r() * 0.1})`;
      g.lineWidth = 1 + r() * 1.5;
      const y = r() * 64, a = r() * 6;
      g.beginPath();
      for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x / 40 + a) * 3);
      g.stroke();
    }
  });
}

const NEGRO = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });

/** Bloque redondeado apoyado en el suelo, con su contorno. El contorno es el
 *  mismo bloque un poco más grande y no la escalada de `contorno`: escalar
 *  una pared larga le engordaba el borde en las puntas. */
function bloque(w: number, h: number, d: number, mat: THREE.Material) {
  const r = Math.min(0.14, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
  m.position.y = h / 2;
  m.castShadow = true;
  m.receiveShadow = true;
  const t = 0.035;
  const c = new THREE.Mesh(new RoundedBoxGeometry(w + 2 * t, h + 2 * t, d + 2 * t, 3, r + t), NEGRO);
  c.name = "contorno";
  m.add(c);
  return m;
}

export class Mesa {
  private pino = tinta(PINO, { map: vetas() });
  private madera = tinta(MADERA, { map: vetas() });
  private grupoParedes = new THREE.Group();

  constructor(escena: THREE.Scene, ancho: number, alto: number, estaticos: Estatico[]) {
    const centro = new THREE.Vector3(ancho / 2, 0, alto / 2);

    // Luz de mañana desde arriba a la izquierda: cálida, con sombras duras
    // —son mecánica: dicen dónde está cada cosa en el suelo— y un relleno frío
    // del lado opuesto para que la sombra no sea un agujero.
    const sol = new THREE.DirectionalLight(0xffe4bd, 2.7);
    sol.position.set(centro.x - 18, 30, centro.z - 10);
    // El target por defecto es el origen, no el centro de la arena: sin esto
    // la cámara de sombras quedaba descentrada y malgastaba su resolución.
    sol.target.position.copy(centro);
    sol.castShadow = true;
    sol.shadow.mapSize.set(1024, 1024);
    sol.shadow.normalBias = 0.05;
    // Una sombra al 100% se lee como un agujero recortado en el suelo.
    sol.shadow.intensity = 0.6;
    const s = Math.max(ancho, alto) * 0.8;
    Object.assign(sol.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 120 });
    sol.shadow.camera.updateProjectionMatrix();
    const relleno = new THREE.DirectionalLight(0x7d9fd6, 1.0);
    relleno.position.set(centro.x + 20, 14, centro.z + 16);
    escena.add(sol, sol.target, relleno, new THREE.AmbientLight(0x5a6a8c, 1.35));

    const madera = this.madera;

    // La mesa de afuera, en penumbra: la bandeja es el escenario.
    const vetasMesa = vetas();
    vetasMesa.repeat.set(20, 60);
    const mesa = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), tinta(MESA, { map: vetasMesa }));
    mesa.position.set(centro.x, -0.3, centro.z);
    mesa.receiveShadow = true;

    // El mantel: cuadros de dos unidades, así el piso también es la regla con
    // la que se miden las distancias.
    const tela = vichy();
    tela.repeat.set(ancho / 4, alto / 4);
    const mantel = new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto).rotateX(-Math.PI / 2), tinta(0xffffff, { map: tela }));
    mantel.position.copy(centro);
    mantel.receiveShadow = true;
    escena.add(mesa, mantel);

    // La bandeja: cuatro listones y el fondo, por fuera del borde de la arena.
    const listones: [number, number, number, number][] = [
      [ancho / 2, -BORDE / 2, ancho + BORDE * 2, BORDE],
      [ancho / 2, alto + BORDE / 2, ancho + BORDE * 2, BORDE],
      [-BORDE / 2, alto / 2, BORDE, alto],
      [ancho + BORDE / 2, alto / 2, BORDE, alto],
    ];
    for (const [x, z, w, d] of listones) {
      const m = bloque(w, BORDE_ALTO, d, madera);
      m.position.set(x, BORDE_ALTO / 2 - 0.3, z);
      escena.add(m);
    }
    const fondo = new THREE.Mesh(new THREE.BoxGeometry(ancho + BORDE * 2, 0.3, alto + BORDE * 2), madera);
    fondo.position.set(centro.x, -0.151, centro.z);
    fondo.receiveShadow = true;
    escena.add(fondo);

    // Las paredes interiores dinámicas en su propio grupo
    escena.add(this.grupoParedes);
    this.actualizarEstaticos(estaticos);

    // Unas migas por el mantel, lejos de las paredes: dan la escala sin
    // ensuciar nada que importe.
    const r = azar(0xcafe);
    const migas = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), tinta(0xffffff), 28);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), giro = new THREE.Euler();
    const c = new THREE.Color();
    for (let i = 0; i < migas.count;) {
      const x = 0.4 + r() * (ancho - 0.8), z = 0.4 + r() * (alto - 0.8);
      if (estaticos.some((e) => Math.abs(x - e.x) < e.hx + 0.4 && Math.abs(z - e.y) < e.hy + 0.4)) continue;
      const t = 0.06 + r() * 0.1;
      q.setFromEuler(giro.set(r() * 3, r() * 3, r() * 3));
      m.compose(new THREE.Vector3(x, t * 0.4, z), q, new THREE.Vector3(t, t * 0.7, t));
      migas.setMatrixAt(i, m);
      migas.setColorAt(i, c.set(MIGA).multiplyScalar(0.75 + r() * 0.3));
      i++;
    }
    migas.castShadow = true;
    escena.add(migas);
  }

  /** La caja que se empuja: un cubo de pino. Mide 1: el render lo escala. */
  caja(): THREE.Mesh {
    const m = bloque(1, 1, 1, this.pino);
    m.position.y = 0;
    return m;
  }

  /** Actualiza los muros estáticos según la arena actual. */
  actualizarEstaticos(estaticos: Estatico[]) {
    while (this.grupoParedes.children.length > 0) {
      this.grupoParedes.remove(this.grupoParedes.children[0]);
    }
    for (const e of estaticos) {
      const enX = e.hx >= e.hy;
      const m = bloque(Math.max(e.hx, e.hy) * 2, ALTURA_MURO, Math.min(e.hx, e.hy) * 2, this.madera);
      m.position.set(e.x, ALTURA_MURO / 2, e.y);
      if (!enX) m.rotation.y = Math.PI / 2;
      this.grupoParedes.add(m);
    }
  }
}
