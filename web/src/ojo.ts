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
  /** Carga la vista real de la retina de la mosca. Si la pelea no tiene .ojo propio, usa el de referencia. */
  static async cargar(canvas: HTMLCanvasElement, pelea: string): Promise<Ojo | null> {
    const html = (res: Response) => res.headers.get("content-type")?.startsWith("text/html");
    let r = await fetch(`/${pelea}.ojo`, { cache: "no-store" });
    if (!r.ok || html(r)) {
      r = await fetch("/ojo.ojo", { cache: "no-store" });
      if (!r.ok || html(r)) return null;
    }
    const b = await r.arrayBuffer();
    const u32 = new Uint32Array(b);
    const ticks = u32[0];
    const n = u32[1];

    // Encabezado de 8 bytes (ticks, n): 1 ojo grabado (654.676 bytes)
    if (b.byteLength === 8 + 8 * n + ticks * n) {
      return new Ojo(
        canvas, n, 1, ticks,
        new Float32Array(b, 8, n),
        new Float32Array(b, 8 + 4 * n, n),
        new Uint8Array(b, 8 + 8 * n, ticks * n),
      );
    }
    // Encabezado de 12 bytes (ticks, n, ojos): 2 ojos grabados
    const ojos = u32[2];
    if (b.byteLength === 12 + 8 * n + ticks * ojos * n) {
      return new Ojo(
        canvas, n, ojos, ticks,
        new Float32Array(b, 12, n),
        new Float32Array(b, 12 + 4 * n, n),
        new Uint8Array(b, 12 + 8 * n, ticks * ojos * n),
      );
    }
    return null;
  }

  avanzar(tick: number) {
    tick = Math.max(0, Math.min(tick, this.ticks - 1));
    if (tick === this.tickVisto) return;
    this.tickVisto = tick;

    const { canvas, ctx, n, x, y, ojos } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio, 2);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);

    // Dibujar ambos ojos en escala de grises pura
    const ojosDibujar = ojos === 1 ? 2 : ojos;
    const lado = Math.min(w / ojosDibujar, h);
    const s = (lado - 8) / 31;
    for (let k = 0; k < ojosDibujar; k++) {
      const derecho = k === 0;
      const cx = derecho ? w * 0.72 : w * 0.28;
      const sx = derecho ? -1 : 1;
      const cuadroIdx = ojos === 1 ? tick : tick * ojos + k;
      const cuadro = this.lum.subarray(cuadroIdx * n, (cuadroIdx + 1) * n);
      for (let i = 0; i < n; i++) {
        const v = Math.round(cuadro[i] * 0.6);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.beginPath();
        ctx.arc(cx + sx * x[i] * s, h / 2 - y[i] * s, s * 0.46, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
