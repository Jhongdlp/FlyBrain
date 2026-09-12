// Controlador y secuenciador de neuroestimulación optogenética.
// Inyecta potenciales bioeléctricos directamente en circuitos específicos del conectoma
// y comanda la biomecánica motora de Drosophila en tiempo real.

import type { CanalesEstimulacion } from "./cerebro";

export type CanalId = "t1_izq" | "t1_der" | "t2_t3" | "alas" | "moonwalker" | "courtship";

export interface CanalMeta {
  id: CanalId;
  nombreCorto: string;
  nombreLargo: string;
  color: string;
  tecla: string;
  descripcion: string;
}

export const CANALES_INFO: CanalMeta[] = [
  {
    id: "t1_izq",
    nombreCorto: "T1-L",
    nombreLargo: "T1-L PROTHORACIC (LEFT FRONT LEG)",
    color: "#00f0ff",
    tecla: "1",
    descripcion: "Unilateral front leg extension & reach gesture",
  },
  {
    id: "t1_der",
    nombreCorto: "T1-R",
    nombreLargo: "T1-R PROTHORACIC (RIGHT FRONT LEG)",
    color: "#00f0ff",
    tecla: "2",
    descripcion: "Unilateral front leg extension & swipe gesture",
  },
  {
    id: "t2_t3",
    nombreCorto: "T2-T3",
    nombreLargo: "T2-T3 MESO/METATHORACIC SQUAT",
    color: "#ff007f",
    tecla: "3",
    descripcion: "Thoracic leg flexors & deep crouching bounce",
  },
  {
    id: "alas",
    nombreCorto: "WINGS",
    nombreLargo: "DLM/DVM FLIGHT POWER MOTOR",
    color: "#00ff88",
    tecla: "4",
    descripcion: "Direct & indirect flight power muscles vibration",
  },
  {
    id: "moonwalker",
    nombreCorto: "MDN",
    nombreLargo: "MDN MOONWALKER DESCENDING",
    color: "#b026ff",
    tecla: "5",
    descripcion: "Optogenetic backward walking descending command",
  },
  {
    id: "courtship",
    nombreCorto: "P1",
    nombreLargo: "P1 COURTSHIP DISPLAY",
    color: "#ffb700",
    tecla: "6",
    descripcion: "Dopamine-driven unilateral wing courtship song",
  },
];

export interface PresetSecuencia {
  nombre: string;
  bpm: number;
  rejilla: Record<CanalId, boolean[]>;
}

export const PRESETS: PresetSecuencia[] = [
  {
    nombre: "AFRO-FUSION GROOVE",
    bpm: 128,
    rejilla: {
      t1_izq:     [false, false, false, false,  true,  false, false, false,  false, false, false, false,  false, false, true,  false],
      t1_der:     [false, false, false, false,  false, false, false, false,  true,  false, false, false,  false, false, false, false],
      t2_t3:      [true,  false, false, false,  false, false, true,  false,  false, false, true,  false,  false, false, false, false],
      alas:       [false, false, true,  false,  false, false, true,  false,  false, false, true,  false,  false, true,  true,  true ],
      moonwalker: [false, false, false, false,  false, false, false, false,  false, false, false, false,  true,  true,  true,  false],
      courtship:  [true,  false, false, false,  false, false, false, false,  false, false, false, true,   false, false, false, false],
    },
  },
  {
    nombre: "CYBER BREAKBEAT",
    bpm: 138,
    rejilla: {
      t1_izq:     [false, false, false, false,  true,  false, false, false,  false, false, false, false,  false, false, false, false],
      t1_der:     [false, false, false, false,  false, false, false, false,  false, false, false, false,  true,  false, true,  false],
      t2_t3:      [true,  false, false, false,  false, false, false, false,  false, false, true,  false,  true,  false, false, false],
      alas:       [true,  false, true,  true,   false, true,  false, true,   true,  false, true,  true,   false, true,  true,  true ],
      moonwalker: [false, false, false, false,  false, false, true,  true,   false, false, false, false,  false, false, false, false],
      courtship:  [false, false, false, false,  false, false, false, false,  true,  false, false, false,  false, false, false, true ],
    },
  },
  {
    nombre: "MOONWALKER POP",
    bpm: 120,
    rejilla: {
      t1_izq:     [true,  false, false, false,  false, false, true,  false,  false, false, false, false,  false, false, false, false],
      t1_der:     [false, false, true,  false,  false, false, false, false,  false, false, true,  false,  false, false, false, false],
      t2_t3:      [false, false, false, false,  true,  false, false, false,  false, false, false, false,  true,  false, false, false],
      alas:       [false, true,  false, false,  false, true,  false, false,  false, true,  false, false,  false, true,  false, true ],
      moonwalker: [false, false, false, false,  false, false, false, false,  true,  true,  true,  true,   true,  true,  true,  true ],
      courtship:  [false, false, false, true,   false, false, false, true,   false, false, false, false,  false, false, false, false],
    },
  },
  {
    nombre: "COURTSHIP SOLAR SONG",
    bpm: 130,
    rejilla: {
      t1_izq:     [true,  false, false, false,  false, false, true,  false,  false, false, false, false,  true,  false, false, false],
      t1_der:     [false, false, false, false,  true,  false, false, false,  false, false, true,  false,  false, false, false, false],
      t2_t3:      [false, false, false, false,  false, false, false, false,  true,  false, false, false,  false, false, false, false],
      alas:       [false, true,  true,  true,   false, false, true,  false,  false, true,  true,  true,   false, false, true,  true ],
      moonwalker: [false, false, false, false,  true,  true,  false, false,  false, false, false, false,  false, true,  true,  false],
      courtship:  [true,  true,  true,  false,  false, false, false, false,  true,  true,  true,  false,  false, false, true,  false],
    },
  },
  {
    nombre: "NEURO-DISCO BOUNCE",
    bpm: 134,
    rejilla: {
      t1_izq:     [false, false, false, false,  true,  false, false, false,  false, false, false, false,  false, false, true,  false],
      t1_der:     [false, false, false, false,  false, false, false, false,  true,  false, false, false,  false, false, false, false],
      t2_t3:      [true,  false, false, false,  true,  false, false, false,  true,  false, false, false,  true,  false, false, false],
      alas:       [false, false, true,  false,  false, false, true,  false,  false, false, true,  false,  false, false, true,  false],
      moonwalker: [false, false, false, false,  false, false, false, false,  false, false, false, false,  true,  true,  false, false],
      courtship:  [true,  false, false, true,   false, false, false, false,  true,  false, false, true,   false, false, false, false],
    },
  },
];

export class Neuroestimulador {
  // Continuous activation levels in [0, 1] with exponential decay
  private niveles: Record<CanalId, number> = {
    t1_izq: 0,
    t1_der: 0,
    t2_t3: 0,
    alas: 0,
    moonwalker: 0,
    courtship: 0,
  };

  // 16-step sequencer matrix (6 rows x 16 steps)
  private rejilla: Record<CanalId, boolean[]> = {
    t1_izq: new Array(16).fill(false),
    t1_der: new Array(16).fill(false),
    t2_t3: new Array(16).fill(false),
    alas: new Array(16).fill(false),
    moonwalker: new Array(16).fill(false),
    courtship: new Array(16).fill(false),
  };

  private reproduciendo = false;
  private bpm = 128;
  private pasoActual = 0;
  private tiempoPasoAcumulado = 0;
  private intensidad = 1.0;
  private decaimientoLambda = 4.8; // Smooth exponential decay rate

  // Web Audio Bio-Synth Drum Engine
  private audioCtx: AudioContext | null = null;
  private ruidoBuffer: AudioBuffer | null = null;
  private sonidoHabilitado = true;

  constructor() {
    this.cargarPresetPorIndice(0);
  }

  private inicializarAudio() {
    if (!this.audioCtx && typeof window !== "undefined") {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
        // Generar buffer de ruido blanco de 1 segundo
        const dur = 1.0;
        const sr = this.audioCtx.sampleRate;
        this.ruidoBuffer = this.audioCtx.createBuffer(1, Math.floor(sr * dur), sr);
        const data = this.ruidoBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.random() * 2 - 1;
        }
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
  }

  /** Bombo 808 electrónico para el sentadillón T2-T3 */
  private sonarKick(vol = 1.0) {
    if (!this.sonidoHabilitado) return;
    try {
      this.inicializarAudio();
      if (!this.audioCtx || this.audioCtx.state !== "running") return;
      const t = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(155, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.10);

      gain.gain.setValueAtTime(0.35 * vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    } catch {}
  }

  /** Caja / Snare percusivo con chasquido para patas delanteras T1-L y T1-R */
  private sonarSnare(canal: "t1_izq" | "t1_der", vol = 1.0) {
    if (!this.sonidoHabilitado) return;
    try {
      this.inicializarAudio();
      if (!this.audioCtx || this.audioCtx.state !== "running") return;
      const t = this.audioCtx.currentTime;
      const freqTono = canal === "t1_izq" ? 270 : 330;
      const freqFiltro = canal === "t1_izq" ? 2100 : 2800;

      // Componente tonal
      const osc = this.audioCtx.createOscillator();
      const oscGain = this.audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freqTono, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.05);
      oscGain.gain.setValueAtTime(0.20 * vol, t);
      oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.connect(oscGain);
      oscGain.connect(this.audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.08);

      // Componente de ruido blanco (snap / chasquido)
      if (this.ruidoBuffer) {
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = this.ruidoBuffer;
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(freqFiltro, t);
        filter.Q.setValueAtTime(1.6, t);
        const noiseGain = this.audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.24 * vol, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.08);
      }
    } catch {}
  }

  /** Charles / Hi-Hat metálico para el batido de alas */
  private sonarHiHat(vol = 1.0) {
    if (!this.sonidoHabilitado) return;
    try {
      this.inicializarAudio();
      if (!this.audioCtx || this.audioCtx.state !== "running") return;
      const t = this.audioCtx.currentTime;

      if (this.ruidoBuffer) {
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = this.ruidoBuffer;
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.setValueAtTime(7200, t);
        const gain = this.audioCtx.createGain();
        gain.gain.setValueAtTime(0.16 * vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.04);
      }
    } catch {}
  }

  /** Sintetizador Sub-Bass para el deslizamiento Moonwalker MDN */
  private sonarBass(vol = 1.0) {
    if (!this.sonidoHabilitado) return;
    try {
      this.inicializarAudio();
      if (!this.audioCtx || this.audioCtx.state !== "running") return;
      const t = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const filter = this.audioCtx.createBiquadFilter();
      const gain = this.audioCtx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(82.4, t);
      osc.frequency.exponentialRampToValueAtTime(55.0, t + 0.16);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(450, t);
      filter.frequency.exponentialRampToValueAtTime(130, t + 0.16);

      gain.gain.setValueAtTime(0.22 * vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.20);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.20);
    } catch {}
  }

  /** Percusión cálida y orgánica tipo Conga / Bongo para el canal P1 (Cortejo) */
  private sonarConga(vol = 1.0) {
    if (!this.sonidoHabilitado) return;
    try {
      this.inicializarAudio();
      if (!this.audioCtx || this.audioCtx.state !== "running") return;
      const t = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const filter = this.audioCtx.createBiquadFilter();
      const gain = this.audioCtx.createGain();

      // Tono cálido y redondo (triangular), barriendo de 230 Hz a 130 Hz
      osc.type = "triangle";
      osc.frequency.setValueAtTime(230, t);
      osc.frequency.exponentialRampToValueAtTime(130, t + 0.08);

      // Filtro paso-bajo suave para eliminar cualquier agudo estridente
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(600, t);
      filter.frequency.exponentialRampToValueAtTime(180, t + 0.08);

      gain.gain.setValueAtTime(0.24 * vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.09);
    } catch {}
  }

  /** Dispara el instrumento bioacústico asociado al canal */
  sonarCanal(canal: CanalId, vol = 1.0) {
    switch (canal) {
      case "t2_t3":
        this.sonarKick(vol);
        break;
      case "t1_izq":
      case "t1_der":
        this.sonarSnare(canal, vol);
        break;
      case "alas":
        this.sonarHiHat(vol);
        break;
      case "moonwalker":
        this.sonarBass(vol);
        break;
      case "courtship":
        this.sonarConga(vol);
        break;
    }
  }

  /** Activa un canal manualmente (por teclado o click en pad) */
  dispararCanal(canal: CanalId, intensidad = this.intensidad) {
    this.niveles[canal] = Math.min(1.0, this.niveles[canal] + intensidad);
    this.sonarCanal(canal, Math.min(1.0, intensidad));
  }

  /** Alterna el estado de un paso de la rejilla */
  alternarPaso(canal: CanalId, paso: number): boolean {
    if (paso < 0 || paso >= 16) return false;
    this.rejilla[canal][paso] = !this.rejilla[canal][paso];
    if (this.rejilla[canal][paso]) {
      this.sonarCanal(canal, 0.7);
    }
    return this.rejilla[canal][paso];
  }

  obtenerEstadoPaso(canal: CanalId, paso: number): boolean {
    return !!this.rejilla[canal][paso];
  }

  limpiarRejilla() {
    for (const c of CANALES_INFO) {
      this.rejilla[c.id].fill(false);
    }
  }

  cargarPresetPorIndice(indice: number) {
    const preset = PRESETS[indice] ?? PRESETS[0];
    this.bpm = preset.bpm;
    for (const c of CANALES_INFO) {
      this.rejilla[c.id] = [...preset.rejilla[c.id]];
    }
  }

  cargarPresetPorNombre(nombre: string) {
    const idx = PRESETS.findIndex((p) => p.nombre.toLowerCase() === nombre.toLowerCase());
    if (idx >= 0) this.cargarPresetPorIndice(idx);
  }

  reproducir() {
    this.inicializarAudio();
    this.reproduciendo = true;
  }

  pausar() {
    this.reproduciendo = false;
  }

  alternarReproduccion(): boolean {
    if (this.reproduciendo) {
      this.pausar();
    } else {
      this.reproducir();
    }
    return this.reproduciendo;
  }

  reiniciar() {
    this.pasoActual = 0;
    this.tiempoPasoAcumulado = 0;
    for (const c of CANALES_INFO) {
      this.niveles[c.id] = 0;
    }
  }

  estaReproduciendo(): boolean {
    return this.reproduciendo;
  }

  setBpm(bpm: number) {
    this.bpm = Math.max(60, Math.min(240, bpm));
  }

  getBpm(): number {
    return this.bpm;
  }

  setIntensidad(val: number) {
    this.intensidad = Math.max(0.1, Math.min(1.0, val));
  }

  getIntensidad(): number {
    return this.intensidad;
  }

  getPasoActual(): number {
    return this.pasoActual;
  }

  setSonidoHabilitado(habilitado: boolean) {
    this.sonidoHabilitado = habilitado;
  }

  /**
   * Actualiza el reloj del secuenciador y la caída exponencial de cada canal.
   * `dt` en segundos.
   */
  actualizar(dt: number): { pasoCambiado: boolean; pasoActual: number; disparados: CanalId[] } {
    let pasoCambiado = false;
    const disparados: CanalId[] = [];

    // Decaimiento exponencial suave en cada canal: A = A * exp(-lambda * dt)
    const factorDecaimiento = Math.exp(-this.decaimientoLambda * dt);
    for (const c of CANALES_INFO) {
      this.niveles[c.id] *= factorDecaimiento;
      if (this.niveles[c.id] < 0.005) this.niveles[c.id] = 0;
    }

    if (this.reproduciendo) {
      // 16 pasos por compás de 4 tiempos = semicorcheas (1/4 de tiempo).
      // Duración de un paso = (60 / bpm) / 4 segundos.
      const duracionPaso = (60 / this.bpm) / 4;
      this.tiempoPasoAcumulado += dt;

      if (this.tiempoPasoAcumulado >= duracionPaso) {
        this.tiempoPasoAcumulado %= duracionPaso;
        this.pasoActual = (this.pasoActual + 1) % 16;
        pasoCambiado = true;

        // Disparar canales activos en este paso
        for (const c of CANALES_INFO) {
          if (this.rejilla[c.id][this.pasoActual]) {
            this.niveles[c.id] = this.intensidad;
            disparados.push(c.id);
          }
        }

        // Síntesis polifónica completa para todos los instrumentos que disparan
        if (disparados.length > 0) {
          for (const canal of disparados) {
            this.sonarCanal(canal, this.intensidad);
          }
        }
      }
    }

    return { pasoCambiado, pasoActual: this.pasoActual, disparados };
  }

  obtenerCanales(): CanalesEstimulacion {
    return {
      t1_izq: this.niveles.t1_izq,
      t1_der: this.niveles.t1_der,
      t2_t3: this.niveles.t2_t3,
      alas: this.niveles.alas,
      moonwalker: this.niveles.moonwalker,
      courtship: this.niveles.courtship,
    };
  }

  obtenerNiveles(): Record<CanalId, number> {
    return { ...this.niveles };
  }
}
