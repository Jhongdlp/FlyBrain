// Partículas: el jugo de la pelea. Chispas, humo, destellos, ondas en el
// suelo, manchas de quemado y la seda que queda pegada. Cosmético puro: nacen de algo que el
// motor ya decidió —un disparo, un impacto— y no le devuelven nada.
//
// Un pool por tipo. Cada partícula tiene su material porque la opacidad y el
// color son suyos; los pools son chicos y se reciclan de la más vieja.

import * as THREE from "three";
import { azar, contorno, telarana, tinta } from "./tinta";

type Tipo = "chispa" | "humo" | "destello" | "onda" | "mancha" | "tela";

interface Particula {
  m: THREE.Mesh;
  v: THREE.Vector3;
  /** Frames que le quedan y los que tenía al nacer. */
  vida: number;
  total: number;
  tam: number;
  giro: number;
  gravedad: number;
}

const MAX: Record<Tipo, number> = {
  chispa: 160, humo: 48, destello: 12, onda: 10, mancha: 14, tela: 6,
};

/** Estrella de `puntas` en el plano XY: el fogonazo de historieta. */
function estrella(puntas: number, fuera: number, dentro: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < puntas * 2; i++) {
    const a = (i / (puntas * 2)) * Math.PI * 2;
    const r = i % 2 ? dentro : fuera;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return new THREE.ShapeGeometry(s);
}

const brillo = (color = 0xffffff) => new THREE.MeshBasicMaterial({
  color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});

export class Efectos {
  private pools = new Map<Tipo, Particula[]>();
  private rnd = azar(0x5eed);
  private geo = {
    chispa: new THREE.BoxGeometry(0.05, 0.05, 0.32),
    humo: new THREE.SphereGeometry(1, 14, 10),
    destello: estrella(8, 1, 0.42),
    onda: new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2),
    mancha: new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2),
    tela: new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
  };
  private humoMat = tinta(0xc4d2df);

  constructor(private escena: THREE.Scene, private camara: THREE.Camera) {}

  private crear(tipo: Tipo): THREE.Mesh {
    switch (tipo) {
      case "humo": {
        const m = new THREE.Mesh(this.geo.humo, this.humoMat);
        contorno(m, 1.1);
        return m;
      }
      case "tela": {
        const m = new THREE.Mesh(this.geo.tela, new THREE.MeshBasicMaterial({
          map: telarana(), transparent: true, depthWrite: false,
        }));
        m.renderOrder = -1;
        return m;
      }
      case "mancha": {
        const m = new THREE.Mesh(this.geo.mancha, new THREE.MeshBasicMaterial({
          color: 0x000000, transparent: true, depthWrite: false,
        }));
        m.renderOrder = -1;
        return m;
      }
      default:
        return new THREE.Mesh(this.geo[tipo], brillo());
    }
  }

  private emitir(tipo: Tipo, p: THREE.Vector3, vida: number, tam: number): Particula {
    let pool = this.pools.get(tipo);
    if (!pool) this.pools.set(tipo, (pool = []));
    let q = pool.find((x) => x.vida <= 0);
    if (!q && pool.length < MAX[tipo]) {
      const m = this.crear(tipo);
      this.escena.add(m);
      q = { m, v: new THREE.Vector3(), vida: 0, total: 0, tam: 0, giro: 0, gravedad: 0 };
      pool.push(q);
    }
    q ??= pool.reduce((a, b) => (a.vida < b.vida ? a : b));
    q.m.position.copy(p);
    q.m.visible = true;
    q.m.rotation.set(0, 0, 0);
    q.v.set(0, 0, 0);
    q.vida = q.total = vida;
    q.tam = tam;
    q.giro = (this.rnd() - 0.5) * 0.6;
    q.gravedad = 0;
    return q;
  }

  private color(q: Particula, color: number) {
    (q.m.material as THREE.MeshBasicMaterial).color.set(color);
  }

  /** Dirección al azar dentro de un cono de `abre` alrededor de `dir`, o en
   *  cualquier dirección si no hay `dir`. */
  private rumbo(dir: THREE.Vector3 | null, abre: number, out: THREE.Vector3) {
    const r = this.rnd;
    out.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    if (dir) out.multiplyScalar(abre).add(dir).normalize();
    return out;
  }

  /** Chispas que salen despedidas y caen. */
  chispas(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, color: number, fuerza = 1) {
    for (let i = 0; i < n; i++) {
      const q = this.emitir("chispa", p, 14 + Math.floor(this.rnd() * 12), 0.8 + this.rnd() * 0.7);
      this.rumbo(dir, 0.7, q.v).multiplyScalar((0.12 + this.rnd() * 0.16) * fuerza);
      if (!dir) q.v.y = Math.abs(q.v.y) + 0.03;
      q.gravedad = 0.012;
      this.color(q, color);
    }
  }

  /** La carga: chispas que convergen al punto en vez de salir de él. */
  succion(p: THREE.Vector3, color: number) {
    const lejos = new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      this.rumbo(null, 0, lejos).multiplyScalar(0.55 + this.rnd() * 0.25);
      const q = this.emitir("chispa", lejos.add(p), 9, 0.7);
      q.v.copy(p).sub(q.m.position).divideScalar(9);
      this.color(q, color);
    }
  }

  /** Bocanadas de humo de historieta: aparecen de golpe, derivan y se
   *  achican hasta desaparecer. Se achican en vez de desvanecerse porque el
   *  contorno negro no se puede hacer transparente sin verse sucio. */
  humo(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, tam = 0.22) {
    for (let i = 0; i < n; i++) {
      const q = this.emitir("humo", p, 26 + Math.floor(this.rnd() * 16), tam * (0.7 + this.rnd() * 0.6));
      this.rumbo(dir, 0.9, q.v).multiplyScalar(0.03 + this.rnd() * 0.05);
      q.v.y += 0.01;
      q.m.scale.setScalar(0.001);
    }
  }

  /** Fogonazo: una estrella que mira siempre a la cámara. */
  destello(p: THREE.Vector3, color: number, tam: number) {
    const q = this.emitir("destello", p, 7, tam);
    q.giro = this.rnd() * Math.PI;
    this.color(q, color);
  }

  /** Anillo que se abre en el suelo. */
  onda(x: number, z: number, color: number, tam: number) {
    const q = this.emitir("onda", new THREE.Vector3(x, 0.05, z), 16, tam);
    this.color(q, color);
  }

  /** Quemadura en el suelo donde pegó algo. Dura: la arena guarda memoria de
   *  la pelea un par de segundos. */
  mancha(x: number, z: number, tam: number) {
    const q = this.emitir("mancha", new THREE.Vector3(x, 0.022, z), 150, tam);
    q.m.scale.setScalar(tam);
  }

  /** La seda del jugador donde pegó: se abre de golpe y se queda un rato. */
  tela(x: number, z: number, tam: number) {
    const q = this.emitir("tela", new THREE.Vector3(x, 0.03, z), 150, tam);
    q.m.rotation.y = this.rnd() * Math.PI * 2;
  }

  /** Un frame. Se llama una vez por frame dibujado. */
  avanzar() {
    const camQ = this.camara.quaternion;
    const mira = new THREE.Vector3();
    for (const [tipo, pool] of this.pools) {
      for (const q of pool) {
        if (q.vida <= 0) continue;
        q.vida--;
        if (q.vida <= 0) {
          q.m.visible = false;
          continue;
        }
        const t = 1 - q.vida / q.total; // 0 al nacer, 1 al morir
        const m = q.m;
        const mat = m.material as THREE.MeshBasicMaterial;
        switch (tipo) {
          case "chispa":
            q.v.y -= q.gravedad;
            q.v.multiplyScalar(0.93);
            m.position.add(q.v);
            if (m.position.y < 0.03) {
              m.position.y = 0.03;
              q.v.y = Math.abs(q.v.y) * 0.4;
            }
            m.lookAt(mira.copy(m.position).add(q.v));
            m.scale.set(q.tam * (1 - t), q.tam * (1 - t), q.tam * (0.4 + q.v.length() * 6));
            break;
          case "humo": {
            q.v.multiplyScalar(0.9);
            q.v.y += 0.0015;
            m.position.add(q.v);
            // Aparece en un quinto de su vida y se achica en el resto.
            const s = t < 0.2 ? Math.sin((t / 0.2) * Math.PI * 0.5) : 1 - ((t - 0.2) / 0.8) ** 1.5;
            m.scale.setScalar(Math.max(q.tam * s, 0.001));
            break;
          }
          case "destello":
            m.quaternion.copy(camQ);
            m.rotateZ(q.giro);
            m.scale.setScalar(q.tam * (0.6 + 0.5 * t));
            mat.opacity = (1 - t) ** 1.5;
            break;
          case "onda":
            m.scale.setScalar(q.tam * (0.25 + 1.75 * (1 - (1 - t) ** 3)));
            mat.opacity = 0.85 * (1 - t);
            break;
          case "mancha":
            mat.opacity = 0.5 * (1 - t ** 4);
            break;
          case "tela":
            m.scale.setScalar(q.tam * (1 - (1 - Math.min(1, t * 10)) ** 3));
            mat.opacity = 1 - t ** 4;
            break;
        }
      }
    }
  }
}
