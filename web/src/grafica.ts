// Osciloscopio y gráfica de telemetría minimalista.
// Muestra la señal sensorial y actividad del circuito de escape a lo largo del tiempo.

export class Grafica {
  private ctx: CanvasRenderingContext2D;
  private historial: number[] = [];
  private historial2: number[] = [];
  private maxPuntos = 120;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  agregar(val1: number, val2 = 0) {
    this.historial.push(val1);
    if (this.historial.length > this.maxPuntos) this.historial.shift();
    this.historial2.push(val2);
    if (this.historial2.length > this.maxPuntos) this.historial2.shift();
    this.dibujar();
  }

  dibujar() {
    const { canvas, ctx } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio, 2);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fondo oscuro técnico
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);

    // Líneas de grilla sutiles
    ctx.strokeStyle = "#161616";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.25); ctx.lineTo(w, h * 0.25);
    ctx.moveTo(0, h * 0.5);  ctx.lineTo(w, h * 0.5);
    ctx.moveTo(0, h * 0.75); ctx.lineTo(w, h * 0.75);
    ctx.stroke();

    // Línea de umbral de escape (70% de la altura)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h * 0.3); ctx.lineTo(w, h * 0.3);
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.historial.length < 2) return;

    const dx = w / (this.maxPuntos - 1);

    // Trazado 1: Señal principal en blanco puro
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < this.historial.length; i++) {
      const x = i * dx;
      const y = h - Math.min(h, Math.max(0, this.historial[i] * h));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Trazado 2: Potencial secundario / DNp01 en gris plata
    if (this.historial2.some((v) => v > 0.01)) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      for (let i = 0; i < this.historial2.length; i++) {
        const x = i * dx;
        const y = h - Math.min(h, Math.max(0, this.historial2[i] * h));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  reiniciar() {
    this.historial = [];
    this.historial2 = [];
    this.dibujar();
  }
}
