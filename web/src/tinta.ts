// El estilo entintado: cel-shading de tres tonos y contorno negro. Lo usan la
// mosca, su cañón y los efectos, para que todo lo que es "personaje" se lea
// como un mismo dibujo animado sobre el blueprint del laboratorio.

import * as THREE from "three";

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

/** Tres tonos —sombra, medio, luz— con `Nearest`, para que el paso entre
 *  bandas sea un corte de tinta y no un degradé. Es todo el cel-shading. */
const TONOS = new THREE.DataTexture(new Uint8Array([95, 175, 255]), 3, 1, THREE.RedFormat);
TONOS.minFilter = TONOS.magFilter = THREE.NearestFilter;
TONOS.needsUpdate = true;

/** Material entintado: cel-shading más un filo de luz en la silueta. El filo
 *  es lo que despega al personaje del suelo oscuro; sin él, el lado en sombra
 *  se funde con el fondo y pierde la mitad del contorno. */
export function tinta(color: number, extra: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color, gradientMap: TONOS, ...extra });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      "#include <opaque_fragment>",
      `float filo = 1.0 - abs(dot(normal, isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition)));
      outgoingLight += vec3(1.0, 0.92, 0.72) * 0.3 * step(0.7, filo);
      #include <opaque_fragment>`,
    );
  };
  return m;
}

/** Generador determinista para lo cosmético. No `Math.random`: la misma pelea
 *  vista dos veces tiene que dar las mismas chispas. */
export function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

let halo: THREE.Texture | null = null;
/** Un degradé radial blanco, de opaco a nada: el resplandor de las cosas que
 *  brillan. Se tiñe con el color del material. Se hace una vez. */
export function resplandor(): THREE.Texture {
  if (halo) return halo;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const d = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  d.addColorStop(0, "rgba(255,255,255,1)");
  d.addColorStop(0.25, "rgba(255,255,255,0.55)");
  d.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = d;
  g.fillRect(0, 0, 64, 64);
  halo = new THREE.CanvasTexture(c);
  halo.colorSpace = THREE.SRGBColorSpace;
  return halo;
}

let orbe: THREE.Texture | null = null;
/** Una tela orbicular, blanca sobre transparente: radios desparejos y la
 *  espiral de captura combada entre ellos. Es la seda del jugador, en vuelo
 *  (`balas.ts`) y pegada donde pegó (`efectos.ts`). Se hace una vez. */
export function telarana(): THREE.Texture {
  if (orbe) return orbe;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = azar(7);
  const RADIOS = 11, R = 60, VUELTAS = 6;
  const a = Array.from({ length: RADIOS }, (_, i) => ((i + (r() - 0.5) * 0.4) / RADIOS) * Math.PI * 2);
  const punto = (ang: number, rad: number): [number, number] => [64 + Math.cos(ang) * rad, 64 + Math.sin(ang) * rad];
  const radios = new Path2D();
  for (const t of a) {
    radios.moveTo(64, 64);
    radios.lineTo(...punto(t, R));
  }
  const espiral = new Path2D();
  const n = RADIOS * VUELTAS;
  const rad = (k: number) => 9 + (k / n) * (R - 12);
  espiral.moveTo(...punto(a[0], rad(0)));
  for (let k = 1; k <= n; k++) {
    const t0 = a[(k - 1) % RADIOS], t1 = a[k % RADIOS] + (k % RADIOS === 0 ? Math.PI * 2 : 0);
    // Cada tramo cuelga hacia el centro, como la seda que se comba.
    const [cx, cy] = punto((t0 + t1) / 2, rad(k - 0.5) * 0.86);
    espiral.quadraticCurveTo(cx, cy, ...punto(t1, rad(k)));
  }
  // Tinta debajo y seda encima: sin el borde, la tela blanca se pierde en el
  // mantel.
  for (const [color, extra] of [["rgba(0,0,0,0.75)", 2.2], ["#fff", 0]] as const) {
    g.strokeStyle = color;
    g.lineWidth = 2.6 + extra;
    g.stroke(radios);
    g.lineWidth = 1.7 + extra;
    g.stroke(espiral);
  }
  orbe = new THREE.CanvasTexture(c);
  orbe.colorSpace = THREE.SRGBColorSpace;
  return orbe;
}
