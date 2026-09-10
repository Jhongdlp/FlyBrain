# FlyBrain

**Un boss de videojuego controlado por el conectoma de una mosca.**

No por un árbol de comportamiento, no por una red entrenada con RL: por una
simulación de neuronas *leaky integrate-and-fire* construida sobre el grafo de
conectividad real del cerebro de *Drosophila melanogaster* — el MaleCNS v1.0 de
Janelia/FlyEM, ~166.700 neuronas, dataset público bajo CC-BY.

El estado del combate (dónde estás, qué tan cerca, qué viene volando) se
inyecta como estimulación en neuronas sensoriales. La actividad de las neuronas
descendentes se lee como acciones: moverse, esquivar, atacar. Entre esas dos
cosas no hay política escrita a mano — hay una mosca.

> **Estado: la mosca ya maneja una acción del boss.** La simulación del
> conectoma reproduce el reflejo de escape —estimular LC4 y LPLC2 hace disparar a
> la fibra gigante (DNp01) unas 30 veces más que estimular neuronas visuales al
> azar— y ese reflejo ya está conectado a la esquiva del boss: cuando algo se le
> viene encima, la fibra gigante dispara y el boss esquiva, a tiempo, contra un
> control de esquivas al azar. Todo lo demás del boss sigue sin cerebro.
> Detalles en [`fly/README.md`](fly/README.md).

## Por qué existe

Salieron proyectos recientes que conectaron conectomas de mosca a Doom y a Super
Mario 64. Son fascinantes y comparten un problema: el juego no fue diseñado para
eso. Los controles son discretos y ricos, la recompensa es escasa y difusa, y no
hay forma de correr un millón de partidas para ver si algo emergió.

Este motor sí fue diseñado para eso, por accidente: venía de un proyecto de RL,
así que ya es determinista, corre headless a ~1M de pasos por segundo, expone
una observación de 43 dimensiones y calcula recompensa densa por tick. Todo lo
que un cerebro necesita para pelear, y para medir si peleó bien.

## Cómo está armado

```
engine/   Rust. Toda la simulación: física, colisiones, raycasts, daño,
          cooldowns, RNG sembrado. Función pura: sin I/O, sin estado global.
          Un crate, dos consumidores.
            ├── wasm32   → el navegador reproduce una pelea grabada
            └── pyo3     → Python la corre a volumen como entorno vectorizado
web/      Three.js. Capa de presentación y nada más. Nunca le devuelve nada
          al motor.
fly/      Python. La mosca: el conectoma como matriz dispersa, el simulador
          LIF y el experimento que lo valida contra biología conocida.
training/ Python. Prueba de humo y benchmark del entorno vectorizado.
```

**El motor no decide la acción del boss: la recibe.** Ése es el único punto de
integración, y es a propósito:

```rust
pub fn step(w: &mut World, input: PlayerInput, action: BossAction) -> StepEvents
```

Quien produzca un `BossAction` por tick controla al boss. Hoy no lo produce
nadie; mañana lo produce una mosca.

### Lo que el cerebro ve — 43 dimensiones

Egocéntrica: todo rotado al marco del boss, para que "el jugador viene por mi
derecha" sea siempre la misma entrada. **Nunca píxeles** — multiplican por mil
el costo de muestras.

| dims | qué |
|---:|---|
| 16 | raycasts por azimut: distancia al obstáculo más cercano |
| 2 | línea de visión al jugador: libre o bloqueada, y a qué distancia |
| 10 | jugador: posición y velocidad relativas, vida, fase de acción, i-frames |
| 9 | boss: vida, cinco cooldowns, fase, distancia al borde |
| 5 | global: tiempo, momentum de daño, últimas tres acciones del jugador |
| 1 | **looming**: cuánto crece en el campo visual lo que se le viene encima (`2rv/d²`) — lo que responden LC4 y LPLC2 |

### Lo que el cerebro controla

`Idle`, `Move(dirección)`, `Use(herramienta, parámetro)` y `Deploy(apoyo, dirección)`.
Cinco herramientas: martillo, cañón, onda de área, embestida y esquiva. Todo se
cuantiza a dos bytes, el mismo empaquetado en el navegador, en Python y en el log.

### La señal de refuerzo, ya calculada

```
r = +0.01·daño_infligido − 0.001·daño_recibido − 0.05·whiff − 0.0005·pasividad
```

El término de *whiff* — atacar y no tocar a nadie — es el que distingue apuntar
de no apuntar. Sale del motor por tick y por entorno, listo para inyectarse como
activación dopaminérgica (PPL101) si se intenta moldear el comportamiento.

## Determinismo

Es el invariante del que cuelga todo lo demás. Una pelea corrida en la GPU tiene
que reproducirse en el navegador **bit a bit**, o el video no muestra lo que
pasó. Se consigue con paso fijo, RNG sembrado (PCG32 propio, no el crate `rand`,
cuyo algoritmo puede cambiar entre versiones) y `sin`/`cos`/`atan2` desde el
crate `libm` en vez de los métodos de `f32` — la libm de cada plataforma difiere
entre wasm y x86 y eso solo bastaría para romperlo.

Lo comprueban cuatro chequeos, y ninguno puede quedar en rojo:

```bash
cargo test                        # 112 tests: el motor entero
./scripts/wasm-determinism.sh     # nativo y wasm dan el mismo hash
node scripts/wasm-smoke.mjs       # el binding del navegador
cd web && npm run check           # la escena se dibuja y la pelea corre
```

## Arrancar

```bash
# El motor
cargo test

# El reproductor en el navegador
./scripts/dev.sh                  # http://localhost:5173

# El entorno de entrenamiento
pip install maturin && maturin develop --release
python training/env_smoke.py      # esperá >1M steps/s
```

## Dónde enchufar el conectoma

Cuatro caminos, de más barato a menos. El orden propuesto es **A primero**:
responde la única pregunta que importa —¿el conectoma produce comportamiento no
degenerado, o se queda quieto en un rincón?— antes de construir transporte
alguno.

- **A. Offline.** El conectoma corre contra `VecEnv` en la GPU y produce un
  stream de acciones legales, que *es* un log de pelea. El navegador lo
  reproduce a 60fps sin infraestructura. **Esto ya funciona hoy** — es lo que
  hace `scripts/dev.sh`, con una pelea guionada en lugar de una mosca.
- **B. Headless con GPU.** Todo en la máquina con GPU, input del jugador por
  websocket. Tira la latencia cero explícitamente.
- **C. En vivo, decidiendo lento.** Tras cualquier ataque el arsenal queda frío
  90 ticks, así que *qué herramienta y cuándo* se decide como mucho a 0,67 Hz —
  solo el rumbo va a 60 Hz. Con 10-20 Hz alcanza, y ahí un 4090 remoto entra sin
  problema.
- **D. Destilar.** Clonar el comportamiento de la mosca a un MLP de ~100 KB que
  corre en el navegador. Pierde la afirmación fuerte de que la mosca está
  decidiendo ahora mismo.

## Preguntas abiertas

Ninguna está resuelta, y cada una cambia el proyecto:

- **Mapeo sensorial.** Los raycasts mapean por azimut. Pero "vida del jugador" y
  "cooldown del arma 3" no tienen análogo en una mosca. ¿Se alimentan solo los
  canales espaciales y el resto se descarta?
- **Lectura motora.** Las descendentes están bien caracterizadas para caminar,
  girar y escapar (DNp09, la fibra gigante): mapean casi perfecto a `Move` y a la
  esquiva. "Disparar el cañón" no tiene correlato.
- **¿El LIF corre más rápido que tiempo real?** Con dt de 0,1 ms son ~167 pasos
  de LIF por tick de juego. Esta cuenta decide entre A, C y D, y va antes de
  escribir una línea.
- **Plasticidad.** La modulación por dopamina es mucho más abierta que la
  inferencia. Sospecha honesta: la v1 demuestra *"el conectoma se comporta"*, no
  *"el conectoma aprende"*.

## Créditos y licencia

El motor viene de [EPOCH](https://github.com/Jhongdlp/EPOCH), un experimento de
boss colectivo entrenado por RL. Se conservaron la física, los mapas, el binding
de Python y el render; se quitaron el bandit, el verificador de replays y toda la
capa de servidor.

El código va bajo **MIT** (ver `LICENSE`). El conectoma MaleCNS es de
Janelia/FlyEM bajo **CC-BY 4.0** y **no** se distribuye acá: se descarga de
[neuPrint](https://neuprint.janelia.org/).

El código y los comentarios están en español. Si el proyecto atrae gente de
fuera, la traducción del README es lo primero que hay que hacer.
