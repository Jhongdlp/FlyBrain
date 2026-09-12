<div align="center">

# 🪰 FlyBrain

**Un boss de videojuego controlado en tiempo real por el conectoma biológico de una mosca.**

[![Rust](https://img.shields.io/badge/engine-Rust_1.80+-orange.svg?style=flat-square&logo=rust)](engine/)
[![WebAssembly](https://img.shields.io/badge/runtime-WASM_bit--identical-654FF0.svg?style=flat-square&logo=webassembly)](web/)
[![Three.js](https://img.shields.io/badge/render-Three.js_r128-black.svg?style=flat-square&logo=three.js)](web/)
[![MaleCNS v1.0](https://img.shields.io/badge/connectome-MaleCNS_v1.0_(164k_neurons)-blue.svg?style=flat-square)](https://neuprint.janelia.org/)
[![Determinism](https://img.shields.io/badge/tests-114_pure_tests_passing-brightgreen.svg?style=flat-square)](engine/tests/)
[![Python Env](https://img.shields.io/badge/throughput->1M_steps%2Fs-yellow.svg?style=flat-square&logo=python)](training/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

<br/>

*No por un árbol de comportamiento. No por una red entrenada con RL.*  
Por una simulación biofísica de neuronas **leaky integrate-and-fire (LIF)** ejecutada directamente sobre el grafo de conectividad real del cerebro de *Drosophila melanogaster* — el dataset **MaleCNS v1.0** de Janelia/FlyEM (~164.506 neuronas, público bajo CC-BY 4.0).

[Demostración y Modos](#-modos-interactivos-en-el-navegador) •
[Arquitectura](#-cómo-está-armado) •
[Circuito Biológico](#-neurobiología-conectada-y-validada) •
[Determinismo](#-determinismo-bit-a-bit) •
[Inicio Rápido](#-arrancar-en-3-minutos) •
[English Summary](#-english-overview)

---

![FlyBrain Arena y Retina](assets/pelea.png)
*El simulador en acción: arena física ortográfica Three.js, visualización de los 1.442 omatidios de la retina de Drosophila, actividad neural en vivo y boss guiado por reflejos y motoneuronas.*

</div>

---

## ⚡ Estado Actual del Proyecto

| Acción / Subsistema | Circuito Biológico Conectado | Estado | Comprobación |
|---|---|---|---|
| **Esquiva (Dodge)** | Visual looming (`LC4` + `LPLC2`) → Fibra Gigante (`DNp01`) | **Validado** | Disparo selectivo 30x–70x sobre controles aleatorios |
| **Locomoción (Caminar)** | 381 motoneuronas del Cordón Nervioso Ventral (VNC) | **Validado** | Empuje bilateral asimétrico + reflejo táctil de patas |
| **Embestida (Ataque)** | Feromona rival cVA (`DA1_lPN`) → Kenyon Cells → `MBON` valencia | **En pruebas** | La balanza de valencia de las MBON decide embestir |
| **Recompensa / Castigo** | Dopaminérgicas `PAM` (acierto) y `PPL1` (daño recibido) | **Medido** | Deprime sinapsis `KC→MBON` selectivamente |
| **Visión de Omatidios** | 1.442 omatidios hexagonales con mapeo egocéntrico azimutal | **Implementado** | Proyección retiniana directa sobre el canvas WebGL |

> **Logro:** La mosca ya maneja tres acciones del boss. Cuando un proyectil o ataque se le viene encima, la señal de looming dispara la fibra gigante innata (**DNp01**) y el boss esquiva en el instante preciso. Al caminar, el empuje resulta de la integración de las motoneuronas de pata del VNC, y el tacto en las cutículas la aparta de los muros. Cuando percibe el olor de combate del rival, la balanza de las *Mushroom Body Output Neurons* (MBON) desata la embestida.

---

## 📸 Galería y Capacidades

### 1. Reflejo de Escape en el Conectoma Completo (164.506 Neuronas)
Cuando una amenaza se aproxima rápidamente, el circuito visual de detección de looming activa de manera sincronizada las neuronas de proyección lobular `LC4` y `LPLC2`. La señal converge con latencia mínima sobre la interneurona gigante `DNp01` en el cuello, ordenando la esquiva inmediata.

<div align="center">
  <img src="assets/conectoma-escape.png" alt="Conectoma MaleCNS mostrando activación de LC4, LPLC2 y DNp01" width="100%">
  <p><em>Nube de puntos 3D con 164.506 neuronas del conectoma MaleCNS: activación en cian del lóbulo óptico y disparo blanco en la fibra gigante descendente DNp01.</em></p>
</div>

### 2. Neuro-Lab: Optogenética Virtual y Secuenciador Neural de 16 Pasos
Consola de estimulación interactiva que permite excitar directamente grupos neuronales específicos (motoneuronas protorácicas `T1-L` y `T1-R`, flexores `T2-T3`, motor de vuelo alar `WINGS`, neurona de marcha atrás `MDN Moonwalker` y neuronas `P1` de cortejo/agresión) y observar la respuesta biomecánica articular del modelo 3D de la mosca.

<div align="center">
  <img src="assets/neurolab.png" alt="Neuro-Lab con secuenciador de 16 pasos y modelo anatómico" width="100%">
  <p><em>Consola Neuro-Lab: secuenciador de patrones motores de 16 pasos sincronizado a BPM configurable con retroalimentación articular en tiempo real.</em></p>
</div>

### 3. Telegrafía de Ataques y Advertencia Visual
Fiel al diseño de combate exigente, cualquier técnica del boss telegrafía su área de efecto en el suelo antes de ejecutarse mediante un decal dinámico, permitiendo al jugador esquivar o buscar cobertura si reacciona dentro de los fotogramas de aviso.

<div align="center">
  <img src="assets/telegrafia.png" alt="Telegrafía de ataque del Boss" width="90%">
  <p><em>Telegrafía de la embestida proyectada sobre el mantel de madera.</em></p>
</div>

### 4. Locomoción Biomecánica y Cortejo Acústico
Simulación de patrones motores rítmicos (*courtship song* y marcha) modulados por osciladores de frecuencia y análisis espectral de audio en tiempo real.

<div align="center">
  <img src="assets/baile-cortejo.png" alt="Cortejo y locomoción bio-mecánica" width="90%">
  <p><em>Visualización articular en primer plano: vibración alar unilateral, flexión de patas y activación de motoneuronas torácicas.</em></p>
</div>

---

## 🔬 ¿Por qué este enfoque?

Los experimentos previos que intentaron conectar cerebros simulados a videojuegos (como *Doom* o *Super Mario 64*) se enfrentaron a tres problemas estructurales:
1. **Espacios de control arbitrarios y discretos**, totalmente ajenos a la morfología de un insecto.
2. **Recompensas dispersas y diferidas en el tiempo**, que requieren millones de episodios para cualquier plasticidad.
3. **Imposibilidad de correr a escala masiva**: motores pesados que apenas alcanzan unos cientos de cuadros por segundo.

**FlyBrain resuelve esto invirtiendo el diseño:**
El motor de combate fue concebido desde cero como una **función matemática pura en Rust**, determinista a nivel de bit, capaz de ejecutarse a más de **1.000.000 de pasos por segundo en Python** y de reproducirse a 60 FPS exactos en el navegador vía **WebAssembly**.

---

## 🏗️ Cómo está armado

```
FlyBrain/
├── engine/        Rust. El motor de simulación física y combate.
│   │              Función pura: sin I/O, sin hilos sueltos, sin estado global.
│   ├── wasm32     → Compilado a WebAssembly para el navegador.
│   └── pyo3       → Enlazado con Python como VecEnv paralelizado con Rayon.
├── fly/           Python. La mosca biofísica:
│   │              Conectoma MaleCNS en matrices dispersas CSR/CSC,
│   │              simulador LIF vectorizado y bancos de validación empírica.
├── web/           TypeScript + Three.js.
│   │              Visualización WebGL pura: arena isométrica, render 3D
│   │              del conectoma, retina biológica y consola Neuro-Lab.
├── assets/        Capturas reales de alta fidelidad para documentación.
├── arenas/        Geometría declarativa de mapas en formato JSON.
└── training/      Benchmarks de rendimiento y arnés para Python.
```

### El Punto de Integración Unificado

El motor no decide qué hace el boss: es un receptor pasivo de acciones:

```rust
pub fn step(w: &mut World, input: PlayerInput, action: BossAction) -> StepEvents
```

Toda la comunicación de entrada y salida se realiza mediante estructuras compactas de ancho fijo:

#### 1. Lo que el cerebro percibe (Observación egocéntrica de 43 dimensiones):
* **16** raycasts por azimut: distancia euclidiana al obstáculo más cercano.
* **2** línea de visión directa (*line of sight*): despejada o bloqueada y distancia al rival.
* **10** cinemática del rival: posición y velocidad relativas, salud, fase y estados de invulnerabilidad.
* **9** estado del boss: salud, enfriamiento de las 5 herramientas, fase y proximidad al borde.
* **5** contexto global: tiempo transcurrido, inercia de daño y últimas 3 acciones del rival.
* **1** señal de **looming**: tasa de expansión óptica en el campo visual ($\frac{2rv}{d^2}$), la entrada directa de `LC4` y `LPLC2`.

#### 2. Lo que el cerebro comanda (Cuantizado a 2 bytes):
`Idle`, `Move(ángulo)`, `Use(herramienta, parámetro)` y `Deploy(apoyo, dirección)`. Cinco herramientas de combate: martillo, cañón, onda de choque, embestida y esquiva.

#### 3. Señal de Refuerzo Densa (para Plasticidad y Dopamina):
$$r = +0.01 \cdot \text{daño\_infligido} - 0.001 \cdot \text{daño\_recibido} - 0.05 \cdot \text{whiff} - 0.0005 \cdot \text{pasividad}$$

El término *whiff* (atacar al aire sin conectar) provee un gradiente inmediato para distinguir apuntar de disparar a ciegas, conectado biológicamente a las neuronas dopaminérgicas `PPL1` y `PAM`.

---

## 🔒 Determinismo Bit a Bit

Una sesión de combate simulada en una GPU remota debe reproducirse en el navegador **idéntica bit por bit**, o cualquier análisis neurológico pierde validez. Esto se garantiza mediante tres pilares:

1. **`libm` estricto:** `sin`, `cos`, `atan2` y `exp` se evalúan mediante la implementación pura de software de `libm`, evitando las diferencias de precisión entre las FPU de x86 y los entornos WebAssembly.
2. **Generador Pseudoaleatorio PCG32 propio:** Algoritmo determinista autocontenido en [`engine/src/rng.rs`](engine/src/rng.rs), independiente de dependencias externas que puedan alterar sus secuencias entre versiones.
3. **Paso temporal fijo:** Integración a $dt = \frac{1}{60}\text{ s}$ constante sin saltos de tiempo flotante.

La suite de verificación comprueba esta invariante de forma automática:
```bash
cargo test                        # 114 pruebas unitarias y de integración
./scripts/wasm-determinism.sh     # Compara hashes criptográficos nativo vs wasm
node scripts/wasm-smoke.mjs       # Valida la capa de interoperabilidad JS/WASM
cd web && npm run check           # Compilación y prueba gráfica con headless browser
```

---

## 🎮 Modos Interactivos en el Navegador

Iniciando el servidor de desarrollo (`./scripts/dev.sh`), se puede acceder a las distintas facetas del proyecto:

* **`/?modo=replay&pelea=fight_0` (Modo Combate / Repetición):**  
  Reproduce batallas grabadas con sincronización cuadro a cuadro entre la física del motor, la cámara WebGL, el mapa de omatidios y las descargas neuronales del conectoma.
* **`/?modo=neuro` (Neuro-Lab):**  
  Laboratorio optogenético interactivo con interfaz de secuenciador por pasos (16 steps). Permite componer secuencias de pulsos neuronales y estudiar la motricidad resultante en el cuerpo de la mosca.
* **`/?modo=mantis` (Minijuego de Sigilo Mantis):**  
  Toma el control del sujeto e intenta acechar al espécimen por la espalda. Si te mueves demasiado rápido o de frente, la expansión óptica superará el umbral de `LC4/LPLC2` y la mosca escapará volando en milisegundos.
* **`/?modo=baile` (Cortejo y Locomoción):**  
  Demostración visual con acompañamiento musical rítmico a 156.5 BPM que ilustra la coordinación de extremidades bilaterales y patrones de aleteo.

---

## 🧠 Neurobiología Conectada y Validada

El proyecto extrae subredes funcionales de **MaleCNS v1.0** e integra el simulador LIF con los siguientes parámetros biofísicos:

```
Ruido basal:       1.5 - 2.0 (mantiene la red silente en reposo sin convulsión)
Escala sináptica:  0.01 - 0.07 (franja meseta que evita la inhibición recurrente global)
Integración LIF:   dt = 0.1 ms (~167 pasos de simulación celular por cada tick de juego)
```

### Circuitos y Literatura Científica
- **Detección de Looming y Escape:** Neuronas `LC4` y `LPLC2` que proyectan monosinápticamente a la neurona gigante `DNp01` (*Giant Fiber*), descritas en *von Reyn et al. (2014)* y *Ache et al. (2019)*.
- **Coordinación de Marcha y Motoneuronas:** 381 motoneuronas del VNC conectadas a las seis patas (coxa, fémur, tibia) inspiradas en el modelo de *Pugliese et al. (2025)*.
- **Olfato, Feromonas y Agresión:** Vía sensorial de la feromona cVA (11-cis-vaccenyl acetate) a través del glomérulo `DA1` hacia las *Kenyon Cells* del cuerpo pedunculado (*Wang & Anderson, 2010*).
- **Plasticidad Sináptica Dopaminérgica:** Depresión heterosináptica $KC \to MBON$ mediada por compartimentos dopaminérgicos `PAM` y `PPL1` (*Aso et al., 2014*).

---

## 🚀 Arrancar en 3 Minutos

### Prerrequisitos
- **Rust** 1.80 o superior (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- **Node.js** 20+ y `npm`
- **Python** 3.10+ (opcional, para experimentos con el conectoma)

### 1. Probar el Motor en Rust
```bash
cargo test
```

### 2. Levantar la Aplicación Web (Combate, Neuro-Lab y Conectoma)
```bash
./scripts/dev.sh
# Abre http://localhost:5173 en tu navegador
```

### 3. Descargar el Conectoma y Correr Experimentos Biofísicos (Python)
```bash
# Descarga los pesos del conectoma MaleCNS (540 MB, bucket público de Janelia)
python fly/paso0.py --descargar

# Experimento del reflejo de escape (looming -> fibra gigante)
python fly/sobresalto.py

# Benchmark del entorno vectorizado en Python
pip install maturin && maturin develop --release
python training/env_smoke.py
```

---

## 🌐 English Overview

**FlyBrain** is an open-source experimental platform connecting a biologically intact connectome simulation of *Drosophila melanogaster* (MaleCNS v1.0, ~165,000 neurons) to a high-speed video game boss combat engine.

- **No Artificial Policies:** Movement, dodging, and attack drives emerge from biological circuits (visual looming detection via `LC4`/`LPLC2` $\to$ Giant Fiber `DNp01`, ventral nerve cord leg motor neurons, and mushroom body valence balancing).
- **Pure Functional Engine:** Written in Rust, fully deterministic down to the bit between native x86 and WebAssembly targets using pure-software `libm` and custom PCG32 pseudo-random number generators.
- **Ultra-High Throughput:** Vectorized headless Python environment benchmarking at **>1,000,000 steps per second**.
- **Interactive Three.js Client:** Live 3D point cloud visualization of 164,506 neurons, ommatidia retinal projection, and an interactive 16-step optogenetic neuro-sequencer.

---

## 📜 Créditos y Licencia

- **Motor y Simulación:** Desarrollado por [Jhongdlp](https://github.com/Jhongdlp). Basado en la arquitectura central de [EPOCH](https://github.com/Jhongdlp/EPOCH).
- **Dataset del Conectoma:** MaleCNS v1.0 provisto por **Janelia Research Campus / FlyEM Project Team** bajo licencia **CC-BY 4.0**.
- **Licencia de Código:** Publicado bajo la licencia de código abierto **MIT** (ver [`LICENSE`](LICENSE)).
