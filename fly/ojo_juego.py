"""La mosca mira el juego: una pelea de verdad dibujada en la retina de `flyvis`.

Hasta acá los estímulos eran discos sintéticos. Acá es el oponente de
`oponente.py` rodeando al boss y disparándole, dibujado tick a tick en el ojo
derecho (`ojo_flyvis.retina_de`); `flyvis` ve, y LPLC2 de MaleCNS responde a
través del acople (`acople.py`).

**Lazo abierto**, como `piloto.abierto`: el boss se queda quieto y la mosca solo
mira. La pregunta es la de allá —¿LPLC2 se prende *cuando* hay un tiro
encima?— sin que la esquiva cambie el escenario.

**El rumbo es un supuesto:** la mosca gira el cuerpo para tener al oponente en
el centro del ojo derecho, el único acoplado. Es el mejor caso para ver; en lazo
cerrado el rumbo lo decide quien mueva el cuerpo.

La vara de comparación es la regla `looming > umbral` sobre el número que calcula
el motor, a igual cantidad de alarmas. Si LPLC2 no se le acerca, el ojo y el
cerebro no están aportando nada que no dé una fórmula.

Y la **mosca entera** (`Mosca`), en lazo cerrado: los dos ojos, el conectoma,
las patas, el tacto y la esquiva por LPLC2, sin el número de looming del motor.
`paredes` pregunta si la vista la aparta de los muros; `grabar` deja una pelea
para el navegador con lo que vieron los dos ojos.

    .venv-ojo/bin/python fly/ojo_juego.py [ganancias...]   # lazo abierto, por defecto 3 y 6
    .venv-ojo/bin/python fly/ojo_juego.py --paredes        # ~20 min: ojos, ciega, cruzados
    .venv-ojo/bin/python fly/ojo_juego.py --grabar         # ~6 min: ?pelea=ojo
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402
import acople as A  # noqa: E402
import dopamina as D  # noqa: E402
import ojo as O  # noqa: E402
import ojo_flyvis as F  # noqa: E402
import piloto as P  # noqa: E402  (la marcha, el tacto y la esquiva de la mosca)
import red as R  # noqa: E402
from oponente import Oponente  # noqa: E402

TICKS = 900
ARENA = 1   # la abierta, como en piloto.py
IDLE = 0    # empaquetado de log.rs: el boss no hace nada
PELIGRO = 0.05  # un proyectil encima, sobre `de_proyectiles` (igual que piloto.py)
# `flyvis` a 1/120 s: sus constantes de tiempo bajan a 5 ms, y un tick entero
# (16,7 ms) es demasiado paso para su integración de Euler.
SUBPASOS = 2
GANANCIAS = tuple(float(g) for g in sys.argv[1:] if not g.startswith("--")) or (3.0, 6.0)# LPLC2 se lee sobre los últimos 50 ms: el tiro se ve recién en sus últimos ~100
# ms de vuelo, así que una ventana de 250 ms como la de `acople.py` llegaría tarde.
VENTANA = 3


def pelea(semilla=1):
    env = engine.VecEnv(1, seed=semilla, arena=ARENA)
    oponente = Oponente(semilla, arena=ARENA)
    obs = env.reset()
    cuadros, peligro, looming = [], [], []
    for _ in range(TICKS):
        w = env.world_state()[0]
        (bx, by, _, radio), objetos = env.escena(0)
        rumbo = np.arctan2(w[1] - by, w[0] - bx) - np.radians(F.CENTRO_AZ)
        # El ojo está en la superficie del cuerpo, del lado hacia donde mira, no
        # en el centro. Con el ojo en el centro el tiro chocaba a 1,2 de distancia
        # y nunca pasaba de 29°; en la superficie llena el ojo al llegar, que es
        # lo que le pasa a una mosca cuando algo le viene a la cabeza.
        mira = rumbo + np.radians(F.CENTRO_AZ)
        ojo_xy = (bx + radio * np.cos(mira), by + radio * np.sin(mira))
        cuadros.append(F.retina_de(ojo_xy, rumbo, objetos))
        peligro.append(w[8])
        looming.append(obs[0, engine.IDX_LOOMING])
        obs, _, done = env.step(np.array([[oponente(w, obs[0]), IDLE, 0]], np.uint8))
        if done[0]:
            break
    return np.array(cuadros), np.array(peligro), np.array(looming), env.fight_log(0)


def chequear_retina():
    """Lo que está al centro del ojo lo oscurece; lo que está detrás no se ve."""
    centro = np.argmin(np.hypot(F.X, F.Y))
    rumbo = -np.radians(F.CENTRO_AZ)  # así el +x del mundo cae en el centro del ojo
    delante = F.retina_de((0.0, 0.0), rumbo, [(3.0, 0.0, 0.5)])
    detras = F.retina_de((0.0, 0.0), rumbo, [(-3.0, 0.0, 0.5)])
    assert delante[centro] < 0.1 * F.FONDO, delante[centro]
    assert np.allclose(detras, F.FONDO)
    # Un ángulo positivo es a la derecha: más a la derecha que el centro del ojo
    # es más atrás, y atrás es -x en la grilla.
    atras = F.retina_de((0.0, 0.0), rumbo, [(3.0 * np.cos(0.3), 3.0 * np.sin(0.3), 0.5)])
    assert F.X[np.argmin(atras)] < 0


def alarmas(senal, peligro, n):
    """Precisión y cobertura de marcar los `n` ticks con la señal más alta."""
    marca = np.zeros(len(senal), bool)
    if n:
        marca[np.argsort(senal, kind="stable")[-n:]] = True
    aciertos = int((marca & peligro).sum())
    return aciertos / max(n, 1), aciertos / max(int(peligro.sum()), 1)


def ver(cuadros):
    """`flyvis` mira la pelea. Respuesta sobre el reposo por tipo, `(ticks, 721)`,
    y la posición de cada célula para emparejarla con MaleCNS."""
    ojo = F.Ojo()
    tipos = [t for t in O.TIPOS_FLYVIS if (ojo.tipo == t).any()]
    xy = {t: np.stack(ojo.posicion(t), axis=1) for t in tipos}
    dt = 1 / (60 * SUBPASOS)
    a = ojo.mirar(np.repeat(cuadros, SUBPASOS, axis=0), dt=dt)
    reposo = ojo.mirar(np.full((100, len(F.X)), F.FONDO), dt=dt)
    resp = {}
    for t in tipos:
        r = a[t][0].numpy() - reposo[t][0, -1].numpy()
        resp[t] = r.reshape(-1, SUBPASOS, r.shape[1]).mean(1)
    return resp, xy


def acoplar(xy):
    red = R.construir()
    ac = A.Acople(red)
    ac.emparejar(xy)
    lplc2 = np.flatnonzero((red.tipo == "LPLC2") & (ac.lado == "R"))
    return red, ac, lplc2


def main():
    chequear_retina()
    cuadros, proyectil, looming, _ = pelea()
    peligro = proyectil > PELIGRO
    print(f"pelea: {len(cuadros)} ticks, {peligro.sum()} con un tiro encima ({peligro.mean():.1%})")
    print(f"  lo más oscuro que llegó a ver una columna: {cuadros.min() / F.FONDO:.2f} del fondo")

    resp, xy = ver(cuadros)
    red, ac, lplc2 = acoplar(xy)
    print(f"acople: {ac.fijas.size:,} neuronas fijadas al ojo · {lplc2.size} LPLC2 del ojo derecho\n")

    n_alarmas = (peligro.sum() // 2, peligro.sum(), 2 * peligro.sum())
    print(f"{'':22}" + "".join(f"{f'{n} alarmas':>22}" for n in n_alarmas))
    print(f"{'':22}" + "   precisión cobertura" * len(n_alarmas))
    fila = lambda nombre, s: print(f"{nombre:22}" + "".join(
        f"{p:12.0%}{c:10.0%}" for p, c in (alarmas(s, peligro, n) for n in n_alarmas)))
    fila("azar", np.random.default_rng(0).random(len(peligro)))
    fila("regla looming>umbral", looming)
    for g in GANANCIAS:
        d, p = ac.correr(resp, g, dt_ojo=1 / 60, leer=lambda d: d[:, lplc2].sum(1, keepdims=True))
        por_tick = d.reshape(len(cuadros), -1).sum(1) / lplc2.size * 60.0  # Hz
        # Causal: en cada tick, lo que LPLC2 hizo en los últimos VENTANA ticks.
        hz = np.convolve(por_tick, np.ones(VENTANA) / VENTANA)[:len(por_tick)]
        fila(f"LPLC2, ganancia {g:g}", hz)
        print(f"{'':22}(pico {hz.max():.1f} Hz · con tiro encima {hz[peligro].mean():.1f} · "
              f"sin {hz[~peligro].mean():.1f})", flush=True)


# --- La mosca entera, en lazo cerrado ---------------------------------------

# LPLC2 de los dos ojos, en Hz sobre los últimos VENTANA ticks, por encima de
# esto esquiva. Medido con el ojo derecho en una pelea: fuera de los impactos no
# pasa de 0,22 Hz (p99 = 0), y con un tiro llega a 3-7 Hz.
UMBRAL = 1.0
GANANCIA = 6.0


class Mosca(P.Piloto):
    """La mosca entera, sin atajos de entrada:

        escena del motor → dos retinas → `flyvis` → lóbulos ópticos de MaleCNS
        → el resto del conectoma → motoneuronas de las patas (marcha y giro)
                                 → LPLC2 → esquiva
        rayos del motor → sensores táctiles de las patas (`Piloto.tocar`)

    El número de looming del motor **no entra**: lo que la mosca sabe del mundo
    es lo que ven sus ojos y lo que tocan sus patas. La marcha, el giro, el tacto
    y la esquiva son los de `Piloto`; acá solo cambia de dónde viene la vista.

    La esquiva se lee de LPLC2 y no de la fibra gigante: con ojos de verdad a
    DNp01 la apaga la inhibición del cerebro central (ver `acople.py`).

    `ganancia=0` es la mosca ciega: mismo cerebro, ojos cerrados. `cruzados`
    manda lo que ve cada ojo al lóbulo del otro lado: el control de que la
    dirección venga del cableado y no de "ver algo".
    """

    def __init__(self, red, semilla=0, grabar=False, tacto=1, ganancia=GANANCIA,
                 cruzados=False, umbral=UMBRAL, sesgo_kc=D.SESGO_KC, aprender=False):
        """`aprender`: la dopamina cambia KC→MBON (`dopamina.Plasticidad`). La
        red tiene que ser propia (`dopamina.aprendiz`): se modifica."""
        ojo = F.Ojo()
        tipos = [t for t in O.TIPOS_FLYVIS if (ojo.tipo == t).any()]
        xy = {t: np.stack(ojo.posicion(t), axis=1) for t in tipos}
        self.acoples = [A.Acople(red, lado) for lado in "RL"]
        for ac in self.acoples:
            ac.emparejar(xy)
        super().__init__(red, semilla, grabar, tacto,
                         fijas=np.concatenate([ac.fijas for ac in self.acoples]))
        self.vista = F.EnVivo(ojo, tipos, 1 / (60 * SUBPASOS), SUBPASOS)
        self.ganancia, self.umbral = ganancia, umbral  # umbral=inf: no esquiva
        self.cual = (1, 0) if cruzados else (0, 1)  # qué retina va a cada lóbulo
        self.lplc2 = red.indices("LPLC2")
        # Las KC con su umbral de mosca (ver `dopamina.py`): sin esto disparan
        # la mitad sin estímulo y el cuerpo pedunculado no distingue nada.
        self.kc, self.sesgo_kc = D.kc(red), sesgo_kc
        self.ppl1 = D.de_tipo(red, "PPL1")
        self.plasticidad = D.Plasticidad(red) if aprender else None
        self.dolores = []
        self.alerta = []
        self.retinas = [] if grabar else None

    def politica(self, env, w, rayos, dolor=None) -> tuple[int, int]:
        """`dolor` en [0, 1]; si no se da, es cuánto toca una pared (los rayos
        del motor, como el tacto). Entra en las PPL1 aprenda o no la mosca: en
        la que no aprende no hace nada, porque la dopamina no es corriente."""
        (bx, by, facing, radio), objetos = env.escena(0)
        # Los ojos miran con el cuerpo del motor —el que se ve y el de los
        # rayos del tacto—, parados en su superficie hacia cada costado.
        cuadros = np.stack([
            F.retina_de((bx + radio * np.cos(facing + lado * np.radians(F.CENTRO_AZ)),
                         by + radio * np.sin(facing + lado * np.radians(F.CENTRO_AZ))),
                        facing, objetos, lado, P.ARENA_XY)
            for lado in (1, -1)])
        if self.retinas is not None:
            self.retinas.append(cuadros)
        resp = self.vista.ver(cuadros)
        self.ext[:] = 0.0
        for ac, k in zip(self.acoples, self.cual):
            for t, (i, j) in ac.pares.items():
                self.ext[i] = self.ganancia * np.maximum(resp[t][k, j], 0.0)
        self.ext[self.kc] = self.sesgo_kc
        self.tocar(rayos)
        if dolor is None:
            dolor = 0.0 if rayos is None else float(np.clip(
                (P.ALCANCE - rayos * P.RAY_RANGE) / (P.ALCANCE - P.RADIO), 0.0, 1.0).max())
        self.dolores.append(dolor)
        self.ext[self.ppl1] = D.DOLOR * dolor
        self.avanzar()
        if self.plasticidad is not None:
            self.plasticidad.tick(self.d)
        self.alerta.append(int(self.d[:, self.lplc2].sum()))
        hz = sum(self.alerta[-VENTANA:]) / self.lplc2.size / (VENTANA / 60)
        return self.esquivar(w) if hz > self.umbral else self.caminar()


def jugar(mosca, semilla=1):
    """Una pelea de la mosca entera contra el oponente de `oponente.py`."""
    env = engine.VecEnv(1, seed=semilla, arena=ARENA)
    oponente = Oponente(semilla, arena=ARENA)
    obs = env.reset()
    pos, esquivas, proyectil = [], [], []
    for _ in range(TICKS):
        w = env.world_state()[0]
        byte, param = mosca.politica(env, w, obs[0, :16])
        pos.append((float(w[4]), float(w[5])))
        esquivas.append(byte == P.DASH)
        proyectil.append(float(w[8]))
        obs, _, done = env.step(np.array([[oponente(w, obs[0]), byte, param]], np.uint8))
        if done[0]:
            break
    return {"log": env.fight_log(0), "hp": float(env.world_state()[0][7]),
            "pos": np.array(pos), "esquivas": np.array(esquivas),
            "proyectil": np.array(proyectil)}


def paredes(semilla=1, esquiva=False):
    """¿La vista la aparta de las paredes? Sin tacto, para que sea solo la vista.

    Tres moscas con el mismo cerebro: con ojos, ciega, y con los ojos cruzados.
    Si apartarse viene del cableado, con ojos tiene que pasar menos tiempo contra
    la pared que ciega, y cruzada más que con ojos. "Contra la pared" es lo mismo
    que en `piloto.marcha`: a menos de 1,1 del borde.

    **Sin esquiva** (`esquiva=False`): la primera corrida con ojos esquivó 118
    veces —LPLC2 también se prende con lo que ve al moverse— y cada esquiva la
    saca de donde esté. Así lo único que puede apartarla es el giro de las patas.
    """
    red = R.construir()
    umbral = UMBRAL if esquiva else np.inf
    print(f"{'':12} contra pared  cerca (<3)  recorrió  giro °/s  esquivas", flush=True)
    for nombre, kw in (("con ojos", {}), ("ciega", {"ganancia": 0.0}),
                       ("cruzados", {"cruzados": True})):
        m = Mosca(red, tacto=0, umbral=umbral, **kw)
        r = jugar(m, semilla)
        pos = r["pos"]
        borde = np.minimum(pos, P.ARENA_XY - pos).min(axis=1)
        giro = np.diff(np.convolve(m.rumbos, np.ones(30) / 30, "valid")) * 60
        print(f"{nombre:12} {(borde < 1.1).mean():12.0%} {(borde < 3).mean():11.0%} "
              f"{np.linalg.norm(np.diff(pos, axis=0), axis=1).sum():9.0f} "
              f"{np.degrees(np.median(abs(giro))):9.0f} {int(r['esquivas'].sum()):9}", flush=True)
        del m


def grabar(nombre="ojo"):
    """Una pelea de la mosca entera para el navegador (`?pelea=ojo`): el log, lo
    que vieron los dos ojos en `<nombre>.ojo` y la actividad en `<nombre>.act`.

    `.ojo`: `uint32 ticks`, `uint32 n`, `uint32 ojos`, `float32[n]` x,
    `float32[n]` y (columnas de `flyvis`, +x adelante, +y arriba) y
    `uint8[ticks*ojos*n]` luminancia (255 = el fondo), derecho primero. Lo lee
    `web/src/ojo.ts`.
    """
    red = R.construir()
    m = Mosca(red, grabar=True)
    r = jugar(m)

    # Lo que se ve tiene que ser la pelea que se jugó: el motor la re-simula.
    _, boss_hp, ticks = engine.reproducir(r["log"])
    assert boss_hp == r["hp"] and ticks == len(m.actividad), (boss_hp, r["hp"], ticks)

    P.PUBLICO.mkdir(exist_ok=True)
    (P.PUBLICO / f"{nombre}.bin").write_bytes(r["log"])
    P.exportar_cerebro(red)
    P.exportar_actividad(m.actividad, P.PUBLICO / f"{nombre}.act")
    retinas = np.array(m.retinas)
    lum = np.clip(retinas / F.FONDO * 255, 0, 255).astype(np.uint8)
    with open(P.PUBLICO / f"{nombre}.ojo", "wb") as f:
        f.write(np.array([ticks, len(F.X), 2], np.uint32).tobytes())
        f.write(F.X.astype(np.float32).tobytes())
        f.write(F.Y.astype(np.float32).tobytes())
        f.write(lum.tobytes())
    print(f"{ticks} ticks · {int(r['esquivas'].sum())} esquivas · daño {1000 - r['hp']:.0f} "
          f"→ web/public/{nombre}.bin · .ojo · .act")
    print(f"\n  ./scripts/dev.sh   y abrí   http://localhost:5173/?pelea={nombre}")


if __name__ == "__main__":
    if "--grabar" in sys.argv:
        grabar()
    elif "--paredes" in sys.argv:
        paredes()
    else:
        main()
