// Las balas. El motor da posición y velocidad de cada proyectil; acá se les da
// cuerpo: un núcleo blanco, una cáscara que tiembla como gelatina, dos chispas
// en órbita que dejan una hélice, la estela, y el impacto cuando desaparecen.
// Las del jugador son seda: una tela que gira, el hilo que la ata a las
// hileras de la araña, y al pegar, la tela queda en el suelo.
//
// **La posición es siempre la del motor.** El dibujo no adelanta ni atrasa lo
// que golpea: la estela va detrás y el impacto se dibuja donde el motor la
// borró. La sombra del núcleo en el suelo es por dónde pasa de verdad.
//
// El motor no da identidad a los proyectiles —los borra con `swap_remove`, que
// reordena—, pero su velocidad no cambia nunca: se siguen de frame a frame por
// velocidad idéntica y cercanía. Así se sabe cuándo nace una y cuándo muere.

import * as THREE from "three";
import { Efectos } from "./efectos";
import { resplandor, telarana } from "./tinta";

/** Entre `CANNON_SPEED` (18, el del boss) y `PLAYER_CANNON_SPEED` (26, el del
 *  jugador) de `weapons.rs`. Solo decide el color: una bala del jugador nunca
 *  va en el color del peligro. */
const VEL_JUGADOR = 22;
const DT = 1 / 60;
/** Largo máximo de la estela: lo que la bala recorre en ~5 frames. */
const ESTELA = 2.2;
/** Largo máximo del hilo de seda: unos 14 frames atado a las hileras. */
const HILO = 6;

interface Bala {
  x: number; y: number; vx: number; vy: number;
  /** Dónde nació: la estela no se dibuja detrás de la boca, y el hilo de la
   *  seda llega hasta las hileras. */
  ox: number; oy: number;
  edad: number;
  jugador: boolean;
  n: Nodo;
}

type Lado = "boss" | "jugador";

/** Cono abierto a lo largo de -X, de radio 1 en el origen a 0 en x = -1, con
 *  el color de vértice de blanco a negro: aditivo, eso es de opaco a nada. */
function trazadora(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 0, 1, 12, 4, true);
  const pos = g.getAttribute("position");
  const col: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const f = (pos.getY(i) + 0.5) ** 2;
    col.push(f, f, f);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g.rotateZ(Math.PI / 2).translate(-0.5, 0, 0);
}

interface Nodo {
  g: THREE.Group;
  borde: THREE.Mesh;
  halo: THREE.Sprite;
  orbita: THREE.Group;
  estela: THREE.Mesh;
}

export class Balas {
  private vivas: Bala[] = [];
  private libres: Nodo[] = [];
  private p = new THREE.Vector3();
  private mat: Record<Lado, { borde: THREE.Material; halo: THREE.SpriteMaterial; estela: THREE.Material }>;
  private geo = {
    nucleo: new THREE.SphereGeometry(0.15, 14, 10),
    borde: new THREE.SphereGeometry(0.22, 14, 10),
    orbita: new THREE.SphereGeometry(0.06, 8, 6),
    estela: trazadora(),
  };
  private blanco = new THREE.MeshBasicMaterial({ color: 0xffffff });

  constructor(
    private escena: THREE.Scene,
    private efectos: Efectos,
    private colores: Record<Lado, number>,
    /** Altura de vuelo: la de las hileras alzadas para el jugador. */
    private alturas: Record<Lado, number>,
    /** Las hileras de la araña: de ahí sale el hilo. */
    private hilera: THREE.Object3D,
  ) {
    const de = (color: number) => ({
      // El borde de color detrás del núcleo blanco: el mismo truco que el
      // contorno negro de los personajes, pero en el color de quien disparó.
      borde: new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }),
      halo: new THREE.SpriteMaterial({
        map: resplandor(), color, transparent: true, opacity: 0.9,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
      estela: new THREE.MeshBasicMaterial({
        color, vertexColors: true, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    });
    this.mat = { boss: de(colores.boss), jugador: de(colores.jugador) };
    // La seda: la tela en vez del halo, y un hilo blanco en vez de la estela.
    this.mat.jugador.halo = new THREE.SpriteMaterial({ map: telarana(), transparent: true, depthWrite: false });
    this.mat.jugador.estela = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
  }

  private nodo(lado: Lado): Nodo {
    let n = this.libres.pop();
    if (!n) {
      const g = new THREE.Group();
      const nucleo = new THREE.Mesh(this.geo.nucleo, this.blanco);
      nucleo.castShadow = true;
      const borde = new THREE.Mesh(this.geo.borde, this.mat.boss.borde);
      const halo = new THREE.Sprite(this.mat.boss.halo);
      halo.scale.setScalar(1.3);
      const orbita = new THREE.Group();
      for (const s of [-1, 1]) {
        const o = new THREE.Mesh(this.geo.orbita, this.blanco);
        o.position.set(-0.08, 0.26 * s, 0);
        orbita.add(o);
      }
      const estela = new THREE.Mesh(this.geo.estela, this.mat.boss.estela);
      g.add(estela, halo, borde, nucleo, orbita);
      this.escena.add(g);
      n = { g, borde, halo, orbita, estela };
    }
    n.borde.material = this.mat[lado].borde;
    n.halo.material = this.mat[lado].halo;
    n.estela.material = this.mat[lado].estela;
    n.orbita.visible = lado === "boss";
    n.g.visible = true;
    return n;
  }

  /** Un frame: sigue las balas del motor, dibuja las vivas, revienta las que
   *  ya no están. */
  actualizar(proyectiles: { x: number; y: number; vx: number; vy: number }[]) {
    const antes = this.vivas;
    const usadas = new Set<Bala>();
    this.vivas = proyectiles.map((p) => {
      // La misma bala: misma velocidad exacta y la más cercana.
      let mejor: Bala | undefined;
      let dmin = 4;
      for (const b of antes) {
        if (usadas.has(b) || b.vx !== p.vx || b.vy !== p.vy) continue;
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < dmin) { dmin = d; mejor = b; }
      }
      if (mejor) {
        usadas.add(mejor);
        Object.assign(mejor, { x: p.x, y: p.y });
        mejor.edad++;
        return mejor;
      }
      const jugador = Math.hypot(p.vx, p.vy) > VEL_JUGADOR;
      // El destello de la salida lo pone la araña, en sus hileras.
      const o = jugador ? this.hilera.getWorldPosition(this.p) : this.p.set(p.x, 0, p.y);
      return { ...p, ox: o.x, oy: o.z, edad: 0, jugador, n: this.nodo(jugador ? "jugador" : "boss") };
    });

    for (const b of antes) {
      if (!usadas.has(b)) this.reventar(b);
    }

    for (const b of this.vivas) {
      const lado: Lado = b.jugador ? "jugador" : "boss";
      const rumbo = Math.atan2(b.vy, b.vx);
      const { g, borde, halo, orbita, estela } = b.n;
      g.position.set(b.x, this.alturas[lado], b.y);
      g.rotation.set(0, -rumbo, 0);
      // Gelatina: se estira en la dirección del viaje y tiembla. El halo late.
      const t = b.edad;
      const tiembla = Math.sin(t * 0.9) * 0.12;
      borde.scale.set(1.35 + tiembla, 1 - tiembla * 0.5, 1 - tiembla * 0.5);
      halo.scale.setScalar(b.jugador ? 0.85 : 1.25 + 0.2 * Math.sin(t * 1.7));
      if (b.jugador) this.mat.jugador.halo.rotation = t * 0.25;
      orbita.rotation.x = t * 0.7;
      // La trazadora, sin pasar de la boca: detrás del punto donde nació no
      // hay nada que dejar. El hilo, en cambio, llega hasta las hileras.
      const largo = Math.min(b.jugador ? HILO : ESTELA, Math.hypot(b.x - b.ox, b.y - b.oy));
      const grueso = b.jugador ? 0.04 : 0.2;
      estela.visible = largo > 0.05;
      estela.scale.set(largo, grueso, grueso);
    }
  }

  /** Donde el motor la borró: contra una pared, un borde o alguien. */
  private reventar(b: Bala) {
    b.n.g.visible = false;
    this.libres.push(b.n);
    const clave = b.jugador ? "jugador" : "boss";
    const color = this.colores[clave];
    const x = b.x + b.vx * DT, z = b.y + b.vy * DT;
    const p = this.p.set(x, this.alturas[clave], z);
    if (b.jugador) {
      // La seda no explota: se abre y queda pegada.
      this.efectos.destello(p, 0xffffff, 0.8);
      this.efectos.chispas(p, null, 10, 0xffffff, 0.7);
      this.efectos.onda(x, z, color, 1.1);
      this.efectos.tela(x, z, 1.1);
      return;
    }
    this.efectos.destello(p, color, 1.1);
    this.efectos.destello(p, 0xffffff, 0.5);
    this.efectos.chispas(p, null, 12, color);
    this.efectos.humo(p, null, 2, 0.26);
    this.efectos.onda(x, z, color, 1.3);
    this.efectos.mancha(x, z, 0.55);
  }
}
