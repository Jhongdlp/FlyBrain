// El panel de los ojos: lo que vio cada retina de la mosca en cada tick.
//
// Igual que el cerebro, **solo dibuja lo que se grabó**: la escena la proyectó
// `fly/ojo_juego.py --grabar` sobre las 721 columnas de cada ojo y eso es lo que
// le entró a `flyvis`. Acá no se calcula nada.
//
// Los dos ojos lado a lado como una panorámica vista desde la mosca: el
// izquierdo a la izquierda, el derecho a la derecha, y el frente de los dos
// hacia el medio.

export class Ojo {
  private ctx: CanvasRenderingContext2D;
  private tickVisto = -1;

  private constructor(
    private canvas: HTMLCanvasElement,
    private n: number,
    private ojos: number,
    private ticks: number,
    private x: Float32Array,
    private y: Float32Array,
    private lum: Uint8Array,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => { const t = this.tickVisto; this.tickVisto = -1; this.avanzar(Math.max(t, 0)); })
      .observe(canvas);
  }

  /** `null` si la pelea no trae lo que vieron los ojos: el panel no aparece. */
  static async cargar(canvas: HTMLCanvasElement, pelea: string): Promise<Ojo | null> {
    const r = await fetch(`/${pelea}.ojo`, { cache: "no-store" });
    // Vite contesta un archivo que no existe con `index.html` y un 200.
    if (!r.ok || r.headers.get("content-type")?.startsWith("text/html")) return null;
    const b = await r.arrayBuffer();
    // `uint32 ticks, n, ojos`, `float32[n]` x, `float32[n]` y (en columnas, +x
    // adelante), `uint8[ticks*ojos*n]` luminancia, 255 = el fondo. Derecho primero.
    const [ticks, n, ojos] = new Uint32Array(b, 0, 3);
    // Un archivo de otro formato no rompe la página: el panel no aparece.
    if (b.byteLength !== 12 + 8 * n + ticks * ojos * n) return null;
    return new Ojo(
      canvas, n, ojos, ticks,
      new Float32Array(b, 12, n),
      new Float32Array(b, 12 + 4 * n, n),
      new Uint8Array(b, 12 + 8 * n, ticks * ojos * n),
    );
  }

  avanzar(tick: number) {
    tick = Math.max(0, Math.min(tick, this.ticks - 1));
    if (tick === this.tickVisto) return;
    this.tickVisto = tick;

    const { canvas, ctx, n, x, y, ojos } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#070a0f";
    ctx.fillRect(0, 0, w, h);

    // Cada grilla mide ~31 columnas de punta a punta.
    const lado = Math.min(w / ojos, h);
    const s = (lado - 8) / 31;
    for (let k = 0; k < ojos; k++) {
      // Derecho (k = 0) a la derecha con el frente (+x) a su izquierda; el
      // izquierdo en espejo, a la izquierda.
      const derecho = k === 0;
      const cx = ojos === 1 ? w / 2 : derecho ? w * 0.75 : w * 0.25;
      const sx = derecho ? -1 : 1;
      const cuadro = this.lum.subarray((tick * ojos + k) * n, (tick * ojos + k + 1) * n);
      for (let i = 0; i < n; i++) {
        // Fondo gris medio, objetos negros: lo mismo que ve `flyvis`, no una
        // versión realzada.
        const v = Math.round(cuadro[i] * 0.5);
        ctx.fillStyle = `rgb(${v},${v + 6},${v + 12})`;
        ctx.beginPath();
        ctx.arc(cx + sx * x[i] * s, h / 2 - y[i] * s, s * 0.46, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
