// Controlador de audio y análisis de ritmo para el Modo Baile de FlyBrain.
// Sincroniza la pista de audio con el reloj de animación a 156.5 BPM.

export const BPM = 156.5;
export const DURACION_TOTAL = 30.22;

export interface EstadoAudio {
  tiempo: number;
  duracion: number;
  beat: number;
  bajo: number;
  agudo: number;
  reproduciendo: boolean;
}

export class AudioBaile {
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private fuente: MediaElementAudioSourceNode | null = null;
  private dataFrecuencia: Uint8Array | null = null;
  private iniciado = false;

  constructor(url = "/baile.mp3") {
    this.audio = new Audio(url);
    this.audio.preload = "auto";
    this.audio.loop = true;
  }

  private asegurarContexto() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataFrecuencia = new Uint8Array(this.analyser.frequencyBinCount);

    try {
      this.fuente = this.ctx.createMediaElementSource(this.audio);
      this.fuente.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      // Si la fuente ya fue conectada o hay restricción CORS, la reproducción sigue directa
    }
  }

  async reproducir(): Promise<boolean> {
    try {
      this.asegurarContexto();
      if (this.ctx && this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      await this.audio.play();
      this.iniciado = true;
      return true;
    } catch (e) {
      console.warn("Audio play blocked by browser policy:", e);
      return false;
    }
  }

  pausar() {
    this.audio.pause();
  }

  reiniciar() {
    this.audio.currentTime = 0;
  }

  estaReproduciendo(): boolean {
    return !this.audio.paused && !this.audio.ended && this.iniciado;
  }

  obtenerEstado(): EstadoAudio {
    const tiempo = this.audio.currentTime;
    const duracion = this.audio.duration || DURACION_TOTAL;
    const beat = (tiempo * BPM) / 60;

    let bajo = 0;
    let agudo = 0;

    if (this.analyser && this.dataFrecuencia && !this.audio.paused) {
      this.analyser.getByteFrequencyData(this.dataFrecuencia as Uint8Array<ArrayBuffer>);
      // Bajos: primeros 6 bins (~0 - 500 Hz)
      let sumBajo = 0;
      for (let i = 0; i < 6; i++) sumBajo += this.dataFrecuencia[i];
      bajo = sumBajo / (6 * 255);

      // Agudos: bins 20 a 50 (~1.7 kHz - 4.3 kHz)
      let sumAgudo = 0;
      for (let i = 20; i < 50; i++) sumAgudo += this.dataFrecuencia[i];
      agudo = sumAgudo / (30 * 255);
    } else {
      // Simulación sintética si no hay permiso de audio aún
      const faseBeat = (beat % 1);
      bajo = Math.max(0, 1 - faseBeat * 2);
      agudo = Math.max(0, Math.sin(beat * Math.PI * 2));
    }

    return {
      tiempo,
      duracion,
      beat,
      bajo,
      agudo,
      reproduciendo: this.estaReproduciendo(),
    };
  }
}
