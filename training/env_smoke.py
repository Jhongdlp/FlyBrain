"""T10 — Prueba de humo y benchmark del entorno vectorizado.

El criterio de aceptación es throughput: más de 1M steps/s en una máquina de
escritorio. Menos de 200k significa que el binding está mal y hay que
arreglarlo antes de seguir — un `step()` por llamada hace que el overhead de
FFI se coma la ventaja de Rust entera.

    python training/env_smoke.py [n_envs]
"""

import sys
import time

import numpy as np

import engine

OBJETIVO = 1_000_000
PISO = 200_000


def acciones_aleatorias(rng, n):
    """Acciones con el mismo empaquetado que el log.

    Jugador: bit 3 movimiento, bits 0-2 dirección, bits 4-6 acción.
    Boss: bits 6-7 kind (0 idle, 1 move, 2 use), y el payload según el kind.
    """
    a = np.zeros((n, 3), dtype=np.uint8)
    a[:, 0] = (rng.integers(0, 5, n) << 4) | 0x08 | rng.integers(0, 8, n)

    kind = rng.integers(0, 3, n)
    mover = kind == 1
    usar = kind == 2
    a[mover, 1] = (1 << 6) | rng.integers(0, 64, mover.sum())
    a[usar, 1] = (2 << 6) | (rng.integers(0, engine.N_TOOLS, usar.sum()) << 4)
    a[:, 2] = rng.integers(0, 256, n)
    return a


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4096
    rng = np.random.default_rng(0)

    env = engine.VecEnv(n, seed=1)
    obs = env.reset()

    assert obs.shape == (n, engine.OBS_DIM), obs.shape
    assert obs.dtype == np.float32
    assert np.isfinite(obs).all(), "la observación trae NaN o inf"
    print(f"{n} entornos · obs {engine.OBS_DIM} dims")

    # Correcto antes que rápido.
    for _ in range(20):
        obs, rew, done = env.step(acciones_aleatorias(rng, n))
        assert obs.shape == (n, engine.OBS_DIM)
        assert rew.shape == (n,) and rew.dtype == np.float32
        assert done.shape == (n,) and done.dtype == np.bool_
        assert np.isfinite(obs).all() and np.isfinite(rew).all()

    # Un episodio entero: tienen que terminar y reiniciarse solos.
    terminados = 0
    for _ in range(engine.EPISODE_TICKS + 10):
        _, _, done = env.step(acciones_aleatorias(rng, n))
        terminados += int(done.sum())
    assert terminados >= n, f"solo terminaron {terminados} de {n} episodios"
    print(f"episodios terminados y reiniciados: {terminados}")

    # El paralelismo de rayon no puede cambiar el resultado: cada entorno tiene
    # su propio Rng y no comparte nada. Si esto falla, hay estado compartido.
    acciones = [acciones_aleatorias(rng, n) for _ in range(30)]

    def corrida():
        e = engine.VecEnv(n, seed=7)
        e.reset()
        for a in acciones:
            obs, rew, done = e.step(a)
        return obs, rew, done

    a1, a2 = corrida(), corrida()
    for x, y, nombre in zip(a1, a2, ("obs", "reward", "done")):
        assert np.array_equal(x, y), f"{nombre} no es determinista"
    print("determinista bajo paralelismo de rayon")

    # Benchmark: las acciones se generan una vez para medir el motor, no numpy.
    acciones = acciones_aleatorias(rng, n)
    env.step(acciones)

    iters = 200
    t0 = time.perf_counter()
    for _ in range(iters):
        env.step(acciones)
    dt = time.perf_counter() - t0

    steps = iters * n
    sps = steps / dt
    print(f"\n{steps:,} steps en {dt:.2f}s  =  {sps:,.0f} steps/s")

    if sps < PISO:
        raise SystemExit(f"FALLA: por debajo del piso de {PISO:,} steps/s")
    if sps < OBJETIVO:
        print(f"por debajo del objetivo de {OBJETIVO:,}, por encima del piso")
    else:
        print("OK: por encima del objetivo")


if __name__ == "__main__":
    main()
