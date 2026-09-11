// Presentación y nada más. El render **nunca** le devuelve nada al motor.
//
// Dibujo animado entintado sobre una bandeja de madera con mantel, a escala de
// mosca (`mesa.ts`): personajes con cel-shading y contorno, una arena
// minimalista, y encima una capa fina de instrumentos de laboratorio —HUD,
// cerebro, ojo— que no se mezcla con el dibujo.

import * as THREE from "three";
import {
  Accion, Estatico, Estado, Evento, EventKind, Fase, Forma, FormaKind, Lado,
} from "./engine";
import { Balas } from "./balas";
import { Efectos } from "./efectos";
import { ALTURA_DISPARO, Jugador } from "./jugador";
import { ALTURA_MURO, Mesa } from "./mesa";
import { Mosca } from "./mosca";
import { contorno } from "./tinta";

// **Un solo color reservado para el peligro.** No se usa para nada más: ni
// suelo, ni boss, ni UI, ni un objeto de la mesa. Cuando aparece significa una
// sola cosa.
const FONDO = 0x05080c;   // el vacío fuera de la arena
const JUGADOR = 0xff002e; // Viuda negra: carmesí escarlata intenso
const PELIGRO = 0xff4a24;
/** Radio del campo de lentitud, en unidades de mundo. Espeja
 *  `minions::CONTROLLER_ZONE`: si mintiera, el anillo dejaría de ser el
 *  contrato con el jugador y el efecto volvería a sentirse arbitrario. */
const ZONA_CONTROLADOR = 3.2;
/// Telemetría del cerebro. Ni el rojo del peligro ni el blanco del boss: es
/// instrumental, tiene que leerse como una capa aparte del juego.

/** Geometría de una forma del motor, tumbada al suelo por quien la use. */
function geometriaDeForma(f: Forma): THREE.BufferGeometry {
  switch (f.kind) {
    case FormaKind.Circulo:
      return new THREE.CircleGeometry(f.r, 48);
    case FormaKind.Arco:
      return new THREE.CircleGeometry(f.r, 32, -f.b, f.b * 2);
    default:
      return new THREE.PlaneGeometry(f.r * 2, f.b * 2);
  }
}

/** Frames que el barrido sigue visible después del golpe. */
const ESTELA = 10;

export class Render {
  private escena = new THREE.Scene();
  private camara: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;

  private jugador: Jugador;
  private boss: Mosca;
  private efectos: Efectos;
  private balas: Balas;
  private mesa: Mesa;
  private cajas: THREE.Mesh[] = [];
  private minions: THREE.Mesh[] = [];
  /** Anillos en el suelo del campo del controlador. Ver `dibujarCampos`. */
  private campos: THREE.Mesh[] = [];

  /** La lectura del cerebro dibujada: adónde apunta y qué anticipa. Se
   *  enciende con `H`. Es la capa de laboratorio del blueprint, así que no
   *  estorba a la pelea: líneas finas, sin sombras y sin profundidad. */

  private decal: THREE.Mesh | null = null;
  /** Frames de destello que le quedan al decal después del windup. */
  private destello = 0;
  private golpe: THREE.Mesh | null = null;
  /** Frames de estela que le quedan al barrido tras la fase activa. */
  private estela = 0;

  constructor(
    private contenedor: HTMLElement,
    private ancho: number,
    private alto: number,
    estaticos: Estatico[],
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // Sombras duras: son mecánica, no decoración. Es cómo se lee la altura y
    // dónde va a caer el martillo. PCF y no `BasicShadowMap` porque con éste
    // último la sombra salía negra pura y se leía como un agujero recortado en
    // el suelo, no como una sombra.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    contenedor.appendChild(this.renderer.domElement);

    this.escena.background = new THREE.Color(FONDO);

    // Ortográfica y fija, encuadrando la arena entera como un diorama sobre una
    // mesa. Sin distorsión de perspectiva: el cerebro lo lee como un plano.
    this.camara = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.encuadrar();

    // La arena, sus luces y su ambiente. El mundo es 2D; la altura Y es
    // puramente cosmética.
    this.mesa = new Mesa(this.escena, ancho, alto, estaticos);

    // Las armas del boss ya no flotan a su alrededor: sus golpes se leen en
    // la pose de la mosca y en la telegrafía. El arma que se ve es la del
    // jugador (`jugador.ts`).
    this.efectos = new Efectos(this.escena, this.camara);
    this.jugador = new Jugador(this.escena, this.efectos, JUGADOR);
    this.boss = new Mosca(this.escena, this.camara);
    this.balas = new Balas(this.escena, this.efectos,
      { boss: PELIGRO, jugador: JUGADOR }, { boss: 0.7, jugador: ALTURA_DISPARO }, this.jugador.hilera);

    // El contenedor y no la ventana: el panel del cerebro le quita ancho al
    // juego al aparecer, y eso no dispara ningún `resize` de la ventana.
    new ResizeObserver(() => this.encuadrar()).observe(contenedor);
  }

  /** Inclinación de 60°: más bajo y las columnas tapan al jugador; más alto y
   *  la cobertura deja de leerse como algo que bloquea. */
  private encuadrar() {
    const { clientWidth: w, clientHeight: h } = this.contenedor;
    if (!w || !h) return;
    this.renderer.setSize(w, h);

    const margen = 1.15;
    const aspecto = w / h;
    // La arena se ve escorzada por la inclinación: el alto proyectado encoge.
    const inclinacion = (60 * Math.PI) / 180;
    const altoVisto = this.alto * Math.cos(inclinacion) + ALTURA_MURO * Math.sin(inclinacion);
    let mitadX = (this.ancho / 2) * margen;
    let mitadY = (altoVisto / 2) * margen;
    if (mitadX / mitadY > aspecto) mitadY = mitadX / aspecto;
    else mitadX = mitadY * aspecto;

    Object.assign(this.camara, { left: -mitadX, right: mitadX, top: mitadY, bottom: -mitadY });
    this.camara.updateProjectionMatrix();

    const centro = new THREE.Vector3(this.ancho / 2, 0, this.alto / 2);
    const d = 60;
    this.camara.position.set(
      centro.x,
      centro.y + d * Math.sin(inclinacion),
      centro.z + d * Math.cos(inclinacion),
    );
    this.camara.lookAt(centro);
  }

  /** Coloca una forma del motor tumbada en el suelo. */
  private tumbar(m: THREE.Mesh, f: Forma, altura: number) {
    m.rotation.x = -Math.PI / 2;
    // El plano ya está tumbado; el giro del ataque va en Z local.
    m.rotation.z = f.kind === FormaKind.Circulo ? 0 : -f.a;
    m.position.set(f.x, altura, f.y);
  }

  /** Decal de telegrafía del boss. La forma es la que el motor va a golpear: si
   *  el decal mintiera, el boss se sentiría injusto por más que telegrafíe. */
  private dibujarDecal(f: Forma) {
    this.borrar("decal");
    const m = new THREE.Mesh(
      geometriaDeForma(f),
      new THREE.MeshBasicMaterial({
        color: PELIGRO, transparent: true, opacity: 0.28,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.tumbar(m, f, 0.03);
    this.decal = m;
    this.escena.add(m);
  }

  /** El barrido del jugador. Sale del motor igual que el del boss, así que es
   *  exactamente el arco que golpea — pero **nunca** en el color de peligro:
   *  ese está reservado para lo que te puede matar. */
  private dibujarGolpe(f: Forma) {
    this.borrar("golpe");
    const m = new THREE.Mesh(
      geometriaDeForma(f),
      new THREE.MeshBasicMaterial({
        color: JUGADOR, transparent: true, opacity: 0.45,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.tumbar(m, f, 0.04);
    this.golpe = m;
    this.escena.add(m);
  }

  private borrar(cual: "decal" | "golpe") {
    const m = cual === "decal" ? this.decal : this.golpe;
    if (!m) return;
    this.escena.remove(m);
    m.geometry.dispose();
    if (cual === "decal") this.decal = null;
    else this.golpe = null;
  }

  /** Un pool: crear y tirar mallas por frame haría trabajar al GC en el peor
   *  momento posible, que es el que se ve como un tirón. */
  private pool(lista: THREE.Mesh[], n: number, hacer: () => THREE.Mesh) {
    while (lista.length < n) {
      const m = hacer();
      lista.push(m);
      this.escena.add(m);
    }
    lista.forEach((m, i) => (m.visible = i < n));
  }

  /** `eventos` trae los de todos los ticks simulados en este frame, no solo
   *  los del último: por debajo de 60fps un frame avanza varios ticks. */
  dibujar(e: Estado, eventos: Evento[]) {
    // Antes de posarlos, para que entren en el mismo frame: los golpes
    // recibidos, el parry y hacia dónde apunta la araña que empieza a cargar.
    for (const ev of eventos) {
      if (ev.kind === EventKind.Hit) {
        if (ev.lado === Lado.Jugador) this.boss.golpeada();
        else this.jugador.golpeado();
      }
      if (ev.kind === EventKind.Parried) {
        const p = new THREE.Vector3(e.jugador.x, 0.9, e.jugador.y);
        this.efectos.destello(p, 0xffffff, 1.2);
        this.efectos.onda(p.x, p.z, JUGADOR, 1.6);
      }
      if (ev.kind === EventKind.Telegraph && ev.lado === Lado.Jugador
        && ev.slot === Accion.Habilidad && ev.forma) {
        this.jugador.apuntar(ev.forma.a);
      }
    }
    this.jugador.actualizar(e.jugador, e.tick);
    // Camina sobre el suelo: la altura del cuerpo la ponen sus patas, y solo
    // despega en la esquiva.
    this.boss.actualizar(e.boss, 0, e.tick);

    // Las balas: núcleo, estela e impacto. Ver `balas.ts`.
    this.balas.actualizar(e.proyectiles);

    this.pool(this.minions, e.minions.length, () => {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.55, 0),
        new THREE.MeshStandardMaterial({
          color: 0x71849a, transparent: true, opacity: 0.85, flatShading: true,
        }),
      );
      m.castShadow = true;
      contorno(m, 1.06);
      return m;
    });
    e.minions.forEach((minion, i) => {
      const m = this.minions[i];
      m.position.set(minion.x, 0.55, minion.y);
      m.scale.setScalar(minion.radius / 0.55);
      m.rotation.y += minion.vx * 0.02;
      (m.material as THREE.MeshStandardMaterial).color.set(
        minion.kind === 0 ? 0x93a8bf : 0x5e91a8,
      );
    });

    // **El campo del controlador tiene que verse.** Es un 45% de velocidad
    // menos y sin el anillo el jugador solo siente que el juego se le puso
    // pesado sin causa: un efecto invisible no es una mecánica, es un bug con
    // buena intención. No va en el color de peligro —no te mata— sino como
    // geometría del suelo, que es lo que es: terreno que el boss te negó.
    const campos = e.minions.filter((m) => m.kind === 1);
    this.pool(this.campos, campos.length, () => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(ZONA_CONTROLADOR - 0.12, ZONA_CONTROLADOR, 64),
        new THREE.MeshBasicMaterial({
          color: 0x5e91a8, transparent: true, opacity: 0.5,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      return m;
    });
    campos.forEach((c, i) => this.campos[i].position.set(c.x, 0.02, c.y));

    // Las cajas que se empujan: cubos de pino, ver `Mesa.caja`.
    this.pool(this.cajas, e.cajas.length, () => this.mesa.caja());
    e.cajas.forEach((c, i) => {
      const m = this.cajas[i];
      m.scale.set(c.hx * 2, c.hx * 2, c.hy * 2);
      m.position.set(c.x, c.hx, c.y);
    });

    for (const ev of eventos) {
      if (ev.kind !== EventKind.Telegraph || !ev.forma) continue;
      if (ev.lado === Lado.Boss) this.dibujarDecal(ev.forma);
      else this.dibujarGolpe(ev.forma);
    }

    // La telegrafía vive mientras el boss carga. Se lee del estado, no se
    // cronometra en TS: los ticks de una animación son del motor.
    const mat = this.decal?.material as THREE.MeshBasicMaterial | undefined;
    if (e.boss.fase === Fase.Windup) {
      // Late más rápido cuanto menos falta: el pulso es el reloj del ataque.
      if (mat) mat.opacity = 0.2 + 0.28 * (0.5 + 0.5 * Math.sin(e.tick * 0.55));
      this.destello = 12;
    } else if (this.destello > 0 && mat) {
      // El golpe cae: destello y se apaga. Un decal que desaparece en seco deja
      // al jugador sin saber si lo alcanzó.
      this.destello--;
      mat.opacity = 0.75 * (this.destello / 12);
      if (this.destello === 0) this.borrar("decal");
    } else {
      this.borrar("decal");
    }

    // El barrido del jugador. La fase activa dura cuatro ticks —66ms— así que
    // sin estela el golpe es un parpadeo que no se llega a ver: se marca flojo
    // mientras carga, entra fuerte al golpear y se apaga en unos frames.
    const golpeMat = this.golpe?.material as THREE.MeshBasicMaterial | undefined;
    if (golpeMat && e.jugador.fase === Fase.Windup) {
      golpeMat.opacity = 0.22;
      this.estela = ESTELA;
    } else if (golpeMat && e.jugador.fase === Fase.Active) {
      golpeMat.opacity = 0.9;
      this.estela = ESTELA;
    } else if (this.estela > 0 && golpeMat) {
      this.estela--;
      golpeMat.opacity = 0.9 * (this.estela / ESTELA);
      if (this.estela === 0) this.borrar("golpe");
    } else {
      this.borrar("golpe");
    }

    this.efectos.avanzar();
    this.renderer.render(this.escena, this.camara);
  }
}
