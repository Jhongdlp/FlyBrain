// Presentación y nada más. El render **nunca** le devuelve nada al motor.
//
// Estética de simulación / blueprint: fondo oscuro, malla en el suelo,
// geometría como wireframe con caras semitransparentes. El juego se ve como el
// laboratorio donde entrenan al boss, no como una fantasía.

import * as THREE from "three";
import {
  Estatico, Estado, Evento, EventKind, Fase, Forma, FormaKind, Lado, N_TOOLS,
} from "./engine";

// Monocromo frío + **un solo color reservado para el peligro**. No se usa para
// nada más: ni suelo, ni boss, ni UI. Cuando aparece significa una sola cosa.
const FONDO = 0x05080c;   // el vacío fuera de la arena
const SUELO = 0x141d28;
const MALLA = 0x24344a;
const BORDE = 0x3d566f;
const GEOMETRIA = 0x40586e;
const JUGADOR = 0xa8c4dc;
const BOSS = 0xdfe9f4;
const PELIGRO = 0xff4a24;
/** Radio del campo de lentitud, en unidades de mundo. Espeja
 *  `minions::CONTROLLER_ZONE`: si mintiera, el anillo dejaría de ser el
 *  contrato con el jugador y el efecto volvería a sentirse arbitrario. */
const ZONA_CONTROLADOR = 3.2;
/// Telemetría del cerebro. Ni el rojo del peligro ni el blanco del boss: es
/// instrumental, tiene que leerse como una capa aparte del juego.

/** El mundo es 2D; la altura Y es puramente cosmética. */
const ALTURA_ACTOR = 1.2;
const ALTURA_MURO = 2.4;

/** Contornos por inverted hull: malla duplicada, escalada, negra, BackSide. */
function contorno(malla: THREE.Mesh, grosor = 1.06): THREE.Mesh {
  const m = new THREE.Mesh(
    malla.geometry,
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
  );
  m.scale.multiplyScalar(grosor);
  malla.add(m);
  return m;
}

/** Silueta distinta por herramienta: si dos proyectan la misma sombra, el
 *  jugador no puede anticipar y la telegrafía llega tarde. */
function siluetaHerramienta(i: number): THREE.BufferGeometry {
  switch (i) {
    case 0: return new THREE.BoxGeometry(0.34, 0.34, 0.34);        // martillo
    case 1: return new THREE.ConeGeometry(0.2, 0.46, 4);           // cañón
    case 2: return new THREE.TorusGeometry(0.19, 0.06, 4, 10);     // onda
    case 3: return new THREE.TetrahedronGeometry(0.26);            // embestida
    // El dash: un anillo plano y abierto. La silueta lo separa de la onda
    // —que también es un toro— porque son lo único parecido del arsenal, y con
    // primitivas la silueta es toda la información que hay.
    default: return new THREE.TorusGeometry(0.22, 0.03, 3, 6, Math.PI);
  }
}

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

/**
 * Un actor. La rotación de rumbo vive en el grupo y la de animación en la
 * malla, para que no se pisen: si fueran el mismo objeto, inclinarse hacia
 * adelante cambiaría hacia dónde mira.
 */
interface Cuerpo {
  grupo: THREE.Group;
  malla: THREE.Mesh;
  /** Inclinación actual, que persigue a la de la fase con un lerp. */
  peso: number;
}

/** A cuánto se inclina en cada fase. Es toda la animación que hace falta: el
 *  diseño es primitivas animadas por rotación, sin pipeline de assets.
 *
 *  Anticipación (echarse atrás), golpe (romper hacia adelante) y recuperación
 *  (volver despacio) son lo que hace legible el compromiso de un ataque. */
const PESO_FASE: Record<Fase, number> = {
  [Fase.Idle]: 0,
  [Fase.Windup]: -0.32,
  [Fase.Active]: 0.55,
  [Fase.Recovery]: 0.18,
  [Fase.Dodging]: 0.42,
};

/** Frames que el barrido sigue visible después del golpe. */
const ESTELA = 10;

/** Cuánto se acerca la inclinación a su objetivo por frame. El golpe entra casi
 *  seco y la recuperación se siente lenta porque el objetivo cambia, no la
 *  velocidad. */
const LERP = 0.28;

export class Render {
  private escena = new THREE.Scene();
  private camara: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;

  private jugador: Cuerpo;
  private boss: Cuerpo;
  private armas: THREE.Mesh[] = [];
  private proyectiles: THREE.Mesh[] = [];
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

  constructor(private ancho: number, private alto: number, estaticos: Estatico[]) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // Sombras duras: son mecánica, no decoración. Es cómo se lee la altura y
    // dónde va a caer el martillo. PCF y no `BasicShadowMap` porque con éste
    // último la sombra salía negra pura y se leía como un agujero recortado en
    // el suelo, no como una sombra.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.escena.background = new THREE.Color(FONDO);

    // Ortográfica y fija, encuadrando la arena entera como un diorama sobre una
    // mesa. Sin distorsión de perspectiva: el cerebro lo lee como un plano.
    this.camara = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.encuadrar();

    const centro = new THREE.Vector3(ancho / 2, 0, alto / 2);

    const luz = new THREE.DirectionalLight(0xdce8f2, 2.4);
    luz.position.set(centro.x - 18, 30, centro.z + 14);
    // El target por defecto es el origen, no el centro de la arena: sin esto la
    // cámara de sombras quedaba descentrada y malgastaba su resolución.
    luz.target.position.copy(centro);
    luz.castShadow = true;
    luz.shadow.mapSize.set(1024, 1024);
    luz.shadow.normalBias = 0.05;
    // Una sombra al 100% se lee como un agujero recortado en el suelo, no como
    // una sombra. Al 55% sigue diciendo dónde va a caer el martillo, que es
    // para lo que están.
    luz.shadow.intensity = 0.55;
    const s = Math.max(ancho, alto) * 0.75;
    Object.assign(luz.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 120 });
    luz.shadow.camera.updateProjectionMatrix();

    // Relleno sin sombra desde el lado opuesto. Las sombras siguen siendo duras
    // —son mecánica, dicen dónde va a caer el martillo— pero dejan de leerse
    // como agujeros negros que se comen la geometría.
    const relleno = new THREE.DirectionalLight(0x5878a0, 1.1);
    relleno.position.set(centro.x + 20, 12, centro.z - 16);
    this.escena.add(luz, luz.target, relleno, new THREE.AmbientLight(0x54698a, 1.6));

    const suelo = new THREE.Mesh(
      new THREE.PlaneGeometry(ancho, alto),
      new THREE.MeshStandardMaterial({ color: SUELO, roughness: 1 }),
    );
    suelo.rotation.x = -Math.PI / 2;
    suelo.position.set(ancho / 2, 0, alto / 2);
    suelo.receiveShadow = true;
    this.escena.add(suelo);

    // Malla del tamaño exacto de la arena. `GridHelper` es cuadrado y se
    // desbordaba por los lados largos, que hacía que el suelo no tuviera límite
    // visible — justo lo que un juego de coberturas necesita que se vea.
    this.escena.add(this.mallaDeArena(ancho, alto));

    for (const e of estaticos) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(e.hx * 2, ALTURA_MURO, e.hy * 2),
        new THREE.MeshStandardMaterial({
          color: GEOMETRIA, transparent: true, opacity: 0.78,
          flatShading: true, roughness: 0.9,
        }),
      );
      m.position.set(e.x, ALTURA_MURO / 2, e.y);
      m.castShadow = true;
      contorno(m, 1.02);
      this.escena.add(m);
    }

    this.jugador = this.actor(0.4, JUGADOR);
    this.boss = this.actor(0.9, BOSS, true);

    for (let i = 0; i < N_TOOLS; i++) {
      const a = new THREE.Mesh(
        siluetaHerramienta(i),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, transparent: true, flatShading: true, wireframe: true,
        }),
      );
      this.armas.push(a);
      this.boss.grupo.add(a);
    }

    addEventListener("resize", () => this.encuadrar());
  }

  /** Líneas cada unidad más un borde marcado: el límite de la arena es
   *  información táctica, no decoración. */
  private mallaDeArena(ancho: number, alto: number): THREE.Group {
    const g = new THREE.Group();
    const puntos: number[] = [];
    for (let x = 0; x <= ancho; x++) puntos.push(x, 0, 0, x, 0, alto);
    for (let z = 0; z <= alto; z++) puntos.push(0, 0, z, ancho, 0, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(puntos, 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: MALLA })));

    const borde = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(ancho, 0, 0),
      new THREE.Vector3(ancho, 0, alto), new THREE.Vector3(0, 0, alto),
      new THREE.Vector3(0, 0, 0),
    ]);
    g.add(new THREE.Line(borde, new THREE.LineBasicMaterial({ color: BORDE })));
    g.position.y = 0.015;
    return g;
  }

  private actor(radio: number, color: number, facetado = false): Cuerpo {
    const geo = facetado
      ? new THREE.IcosahedronGeometry(radio, 0)
      : new THREE.CylinderGeometry(radio, radio, ALTURA_ACTOR, 12);
    const malla = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7 }),
    );
    malla.castShadow = true;
    contorno(malla);

    const grupo = new THREE.Group();
    grupo.add(malla);
    this.escena.add(grupo);
    return { grupo, malla, peso: 0 };
  }

  /** Inclinación de 60°: más bajo y las columnas tapan al jugador; más alto y
   *  la cobertura deja de leerse como algo que bloquea. */
  private encuadrar() {
    const { innerWidth: w, innerHeight: h } = window;
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

  /** Coloca un actor y le aplica la animación de su fase. */
  private animar(c: Cuerpo, x: number, y: number, altura: number, facing: number, fase: Fase) {
    c.grupo.position.set(x, altura, y);
    c.grupo.rotation.y = -facing;
    c.peso += (PESO_FASE[fase] - c.peso) * LERP;
    c.malla.rotation.z = -c.peso;
    // Estirarse al golpear y encogerse al cargar: el mismo valor mueve las dos
    // cosas, así que la animación no puede desincronizarse de la fase.
    c.malla.scale.set(1, 1 + c.peso * 0.22, 1);
  }

  /** `eventos` trae los de todos los ticks simulados en este frame, no solo
   *  los del último: por debajo de 60fps un frame avanza varios ticks. */
  dibujar(e: Estado, eventos: Evento[]) {
    this.animar(this.jugador, e.jugador.x, e.jugador.y, ALTURA_ACTOR / 2,
      e.jugador.facing, e.jugador.fase);
    this.animar(this.boss, e.boss.x, e.boss.y, 0.9, e.boss.facing, e.boss.fase);

    // La maestría era la dirección de arte: un solo valor por arma controlando
    // opacidad, saturación y emisivo, y el arma se solidificaba a medida que el
    // boss aprendía a usarla. Ese número salía del bandit, que ya no está.
    //
    // ponytail: armas sólidas fijas. Qué número las mueve ahora es pregunta
    // abierta — ver CLAUDE.md. Un candidato honesto para el conectoma: la tasa
    // de disparo del cluster de neuronas motoras asociado a cada herramienta.
    this.armas.forEach((a, i) => {
      const m = 1;
      const mat = a.material as THREE.MeshStandardMaterial;
      mat.wireframe = m < 0.15;
      // Un arma sin dominar es un borrador, pero un borrador tiene que verse:
      // el arco va de "alambre translúcido" a "sólido y emisivo", no de "nada".
      mat.opacity = 0.5 + 0.5 * m;
      mat.color.setHSL(0.55, 0.1 + 0.5 * m, 0.45 + 0.25 * m);
      mat.emissive.setHSL(0.55, 1, 0.5 * m * m);
      const ang = (i / N_TOOLS) * Math.PI * 2 + e.tick * 0.008;
      a.position.set(Math.cos(ang) * 1.5, 0.1, Math.sin(ang) * 1.5);
      a.rotation.set(ang, ang * 1.3, 0);
    });

    this.pool(this.proyectiles, e.proyectiles.length, () => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 10, 8),
        new THREE.MeshBasicMaterial({ color: PELIGRO }),
      );
      m.castShadow = true;
      return m;
    });
    e.proyectiles.forEach((p, i) => this.proyectiles[i].position.set(p.x, 0.7, p.y));

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

    this.pool(this.cajas, e.cajas.length, () => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color: GEOMETRIA, flatShading: true, transparent: true, opacity: 0.8,
        }),
      );
      m.castShadow = true;
      m.receiveShadow = true;
      contorno(m, 1.04);
      return m;
    });
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

    this.renderer.render(this.escena, this.camara);
  }
}
