# FlyBrain — contexto para trabajar en este repo

`README.md` cuenta qué es el proyecto y por qué. Acá está lo que hace falta para
**tocar el código sin romperlo**: los invariantes, qué vive dónde, y qué se
intentó ya.

## Estado

El motor está terminado y en verde. La mosca corre en `fly/` (LIF sobre las
164.506 neuronas del conectoma) y maneja **dos** acciones del boss: la esquiva,
por la fibra gigante, y el movimiento, leyendo las motoneuronas de las seis patas
(`fly/patas.py`). El tacto de las patas la aparta de las paredes (pasa su
experimento y su control cruzado); DNa02 no sobrevive al LIF, así que lejos de
las paredes el rumbo es ruido de la red. Las armas siguen sin cerebro.

## El invariante del que cuelga todo

**El motor de combate es una función pura.** Sin I/O, sin estado global, sin
aleatoriedad fuera del `Rng` del `World`, paso fijo de 1/60. Sin excepciones.

Esto no es purismo: es lo que hace que una pelea grabada contra la mosca en una
GPU alquilada se reproduzca **bit a bit** en el navegador. Si diverge, el video
no muestra lo que pasó y el proyecto entero pierde el sentido.

Tres reglas concretas que salen de ahí, y que ya costaron caro cuando se
ignoraron:

1. **`libm`, nunca los métodos de `f32`.** `sin`, `cos`, `atan2` y `exp` salen de
   la libm de cada plataforma y **no coinciden entre wasm y x86**. Suma, resta,
   multiplicación, división y `sqrt` sí son exactas por IEEE 754 y no dan
   problema. `Vec2::angle` y `Vec2::from_angle` ya lo respetan: usalas.
2. **Ninguna regla de juego fuera de Rust.** Si una decisión de gameplay vive en
   TypeScript o en Python, hay dos implementaciones que pueden divergir. El
   navegador lee el buffer plano del wasm y dibuja; nada más.
3. **El RNG es propio (PCG32 en `rng.rs`), no el crate `rand`.** Su algoritmo
   puede cambiar entre versiones y eso rompería toda grabación vieja.

Si `el_hash_del_mundo_final_no_cambio` falla, **no actualices el hash sin
entender el diff**. Ese test es lo único que separa un cambio de balance de una
divergencia de plataforma.

## Los chequeos

Ninguno puede quedar en rojo. Son cuatro y corren en segundos:

```bash
cargo test                        # 112 tests
./scripts/wasm-determinism.sh     # nativo y wasm dan el mismo hash
node scripts/wasm-smoke.mjs       # el binding del navegador
cd web && npm run check           # la escena se dibuja y la pelea corre
```

## Qué vive dónde

| | hace | **no** hace |
|---|---|---|
| **Rust** (`engine/`) | Toda la simulación: física, colisiones, raycasts, daño, cooldowns, RNG. La única fuente de verdad. | Dibujar. Red. Archivos. Nada de I/O. |
| **TypeScript** (`web/`) | Pegamento fino: carga una pelea grabada, la avanza en el wasm, le da el estado a Three.js. | Cualquier regla de juego. |
| **Python** (`training/`) | Correr el conectoma contra el motor como entorno vectorizado. | Existir en producción. |

La prueba de que la frontera está bien: **borrar `training/` no debe afectar al
juego en absoluto**, y el motor debe correr una pelea entera sin que exista
TypeScript.

## El punto de integración

Hay exactamente uno, y es el contrato de `lib.rs`:

```rust
pub fn step(w: &mut World, input: PlayerInput, action: BossAction) -> StepEvents
```

**El motor no elige la acción del boss: la recibe.** Quien produzca un
`BossAction` por tick controla al boss.

Hoy no la produce nadie. Las dos vías construidas:

- **Python** (`engine/src/python.rs`): `VecEnv` toma `(n, 3)` uint8 y devuelve
  `(n, 43)` float32 + recompensa + done. Es donde entra el conectoma.
- **Navegador** (`engine/src/wasm.rs`): `load_log` + `step_log` reproducen una
  pelea grabada tick a tick. El log lo expande el motor, **no JavaScript**: el
  formato lo define `log.rs` y una segunda implementación en TS rompería la
  reproducibilidad.

`wasm.rs` también expone `step_tick`, que acepta la acción del boss desde fuera.
Es la puerta para el modo en vivo (opción C del README) cuando llegue.

### La API a Python es batcheada, y tiene que seguir siéndolo

Un `step()` por llamada hace que el overhead de FFI se coma la ventaja de Rust
entera y termine más lento que Node. Una llamada avanza N arenas en paralelo con
rayon y devuelve arrays contiguos que numpy lee sin copiar. Es la diferencia
entre ~50k y ~1M pasos por segundo. `training/env_smoke.py` mide esto y falla por
debajo de 200k.

## De dónde viene esto, y qué se quitó

Fork de EPOCH, un boss colectivo entrenado por RL contra jugadores reales. **Se
quitó todo lo que era de aquel proyecto:**

- `brain.rs` (2293 líneas): el bandit contextual. Aprendía qué herramienta usar
  en qué contexto, por contadores. Reemplazado por el conectoma.
- `replay.rs` (1123): el verificador anti-trampas. Re-simulaba el log del cliente
  para no confiar en lo que reportaba. No hay clientes que mientan acá.
- `server.rs` (351): la API del blob de pesos.
- `worker/` entero: Cloudflare Workers, Durable Object, R2, cron.
- `tests/arco.rs` y `tests/evaluacion.rs`: bancos de calibración del bandit.

Está todo en la historia de EPOCH si alguna vez hace falta.

**Lo que se conservó y por qué:**

- `types.rs`, `collision.rs`, `actor.rs`, `weapons.rs`, `minions.rs` — el mundo y
  lo que se puede hacer en él.
- `arena.rs` + `arenas/launch.json` — **el mapa es dato, no código.** Semilla +
  rectángulos estáticos + cuerpos dinámicos. Se lanza con una arena, el formato
  ya soporta N.
- `raycast.rs` — 16 rayos por azimut y línea de visión. Es la percepción
  espacial, y mapea natural al sistema visual de la mosca.
- `vision.rs` (nuevo) — la señal de looming, `2rv/d²`. Es la entrada de LC4 y
  LPLC2. Geometría pura: vive en Rust por la misma razón que los raycasts, y no
  toca `step`, así que no mueve el golden hash.
- `python.rs` — el arnés. **El archivo más valioso del repo para este proyecto.**
- `log.rs` — el empaquetado de acciones a dos bytes, el mismo en los tres lados.
- `golden.rs` — la pelea guionada que sirve de fixture al test de determinismo.
- `web/` — Three.js. Cámara ortográfica, wireframe, sombras duras.

## Deuda conocida

- **Qué mueve el material de las armas.** En EPOCH un solo número por arma —la
  maestría del bandit— controlaba opacidad, saturación y emisivo, y el arma se
  solidificaba a medida que el boss aprendía a usarla. Ese número ya no existe y
  hoy las armas se dibujan sólidas fijas (`render.ts`, marcado con `ponytail:`).
  Candidato honesto para el conectoma: la tasa de disparo del cluster motor
  asociado a cada herramienta.
- **`minions.rs` probablemente sobre.** Son unidades de apoyo del boss, contenido
  de aquel juego. Quitarlas toca `types.rs`, que es el contrato: cuesta más de lo
  que ahorra hasta que haya un motivo.
- **Esquivar paredes es mecánico en las peleas grabadas, no la mosca.**
  `piloto.virar` gira el rumbo hacia donde los rayos ven sitio libre, solo con
  `Piloto(grabar=True)`: los experimentos miden a la mosca sin esto. Es para que
  el juego se vea bien (0-2% del tiempo contra la pared, contra 32-36% con el
  tacto solo). Se quita cuando una vía del conectoma la aparte sola.
- **`BOSS_HP` de producción es 1000 y no está calibrado.** Con `--features dev`
  baja a 66, y ése es el valor que usa `scripts/dev.sh`.

## Reglas para trabajar acá

- El motor se escribe como función pura. Sin excepciones. Todo lo demás depende
  de eso.
- Antes de agregar una dimensión a la observación: **un eje se gana el sitio si
  el tiempo se reparte de verdad entre sus bins.** Si uno se lleva el 99%, ese
  eje no está distinguiendo nada. (Lección medida en EPOCH: un eje entero se podó
  porque su tercer bin no se visitaba nunca.)
- Un cambio de comportamiento del motor mueve el golden hash. Regenerá el fixture
  con `cargo test --test dump_golden -- --ignored` **después** de entender el
  diff, nunca antes.
- El costo de un mecanismo nuevo se estima por la **longitud de la cadena de
  crédito**: "estoy detrás de una pared, no recibo daño" son milisegundos y
  emerge solo; "empujo una caja para cortar la ruta de escape" son segundos y una
  decisión del rival, y no emerge de nada sin reward shaping dedicado.
