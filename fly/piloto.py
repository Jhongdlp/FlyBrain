"""La mosca maneja la esquiva del boss.

Primera acción del juego atada a biología en vez de asignada a dedo. El circuito
es el que valida `sobresalto.py`:

    algo se acerca → LC4 + LPLC2 → DNp01 (fibra gigante) → escape

En la mosca DNp01 dispara un salto de escape estereotipado; acá dispara
`ToolId::Dash`. **La mosca decide *si* esquivar; hacia dónde es geometría** — la
fibra gigante no es direccional, y fingir que lo es sería inventar biología.

El escenario: boss quieto, y el oponente de `oponente.py` rodeando la
cobertura para dispararle el cañón. El cañón vuela 18 ticks y el boss necesita
16 para salir del corredor (ver `weapons`), así que el margen está pensado para
que esquivar sea una decisión.

El oponente importa tanto como la mosca. El anterior caminaba en línea recta y
se clavaba contra la primera caja que lo dejara sin visión, así que cualquier
esquiva que pusiera al boss detrás de una parecía salvadora.

El control es lo que le da sentido: **el mismo número de esquivas, en ticks al
azar.** Si la mosca no le gana a eso, no está aportando timing, solo esquivas.

    python fly/piloto.py              # el experimento, con su control
    python fly/piloto.py --andar      # la mosca camina con sus patas (ver `patas.py`)
    python fly/piloto.py --grabar     # una pelea de la mosca, esquivando y caminando
    python fly/piloto.py --andar --espinal    # las patas del cordón de tasas (`cordon.py`)
    python fly/piloto.py --grabar --espinal   # ?pelea=espinal
    python fly/piloto.py --grabar --ticks 3600   # una pelea de 60 s en vez de 15
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402
import patas as P  # noqa: E402
import red as R  # noqa: E402
from oponente import Oponente  # noqa: E402

TAU = 2 * np.pi

# Un tick de juego son 16,67 ms de mosca: 33 pasos del LIF, ~23 ms de CPU. Más
# lento que tiempo real, pero una pelea de 60 s se genera en minuto y medio.
TICK_MS = 1000.0 / 60.0
# `looming` normalizado [0,1] → corriente en LC4/LPLC2.
#
# Medido en lazo abierto sobre una traza real: con 2.5 la fibra gigante dispara
# 16 veces en 900 ticks y se pierde el 80% de los tiros; con 20 dispara a todo y
# empieza a perder especificidad. En 10 acierta 60 de las 65 amenazas
# conservando el 78% de precisión, que es la mejor combinación del barrido.
GANANCIA = 10.0

TICKS = 900
SEMILLAS = 4
# La arena abierta: sin muros ni cajas. Con cobertura, una esquiva que deja al
# boss detrás de una caja parece salvadora y un tiro que roza una esquina parece
# un fallo — y ninguna de las dos cosas es de la mosca.
ARENA = 1
# Un proyectil encima. Sobre `de_proyectiles`, no sobre lo que ve la mosca: el
# jugador acercándose también le expande el campo visual —y está bien que así
# sea, es el mismo circuito— pero no es algo que se pueda esquivar.
PELIGRO = 0.05

# Empaquetado de acciones, igual que en `engine/src/log.rs`.
IDLE = 0
MOVE = 1 << 6  # | dirección en 64 pasos
DASH = (2 << 6) | (4 << 3)  # Use(ToolId::Dash, param)

# Las patas → el cuerpo. Tracción diferencial: cada lado empuja en proporción a
# lo que disparan sus motoneuronas, y la diferencia gira hacia el lado que empuja
# menos. El lado **derecho** de la mosca es `fwd.perp()` en el motor: el render
# dibuja la y del mundo hacia abajo (`render.ts`) y `mosca.ts` pone las patas
# derechas justo ahí. Así que un ángulo que crece es girar a la derecha, y
# empujar más con las derechas lo baja. (Estuvo al revés: la mosca que se veía
# era el espejo de la simulada, y un ojo derecho de verdad la contradecía.)
#
# ponytail: sin marcha ni fases de apoyo y vuelo; cada pata es solo "cuánto
# empuja". El paso siguiente es un cuerpo con músculos (NeuroMechFly).
#
# Radianes por tick con todas las patas de un lado y ninguna del otro. DNa02 en
# `patas.py` mueve la asimetría ~0.04; con 0.5 eso gira ~75°/s, el orden de un
# giro de mosca caminando. Con 0.1 giraba 16°/s y no se despegaba de las paredes.
GIRO = 0.5
# La asimetría tiene un sesgo que es de nuestro LIF sin calibrar y no de la
# mosca: en una pelea las patas derechas empujaban +0.046 todo el tiempo, en
# otra semilla el sesgo iba al revés. Sin quitarlo, el boss daba vueltas en un
# solo sentido. Se resta su promedio móvil de estos ticks (2 s): se va el sesgo,
# quedan las variaciones.
#
# ponytail: también se come una orden de giro sostenida más de ~2 s. Se quita
# cuando los parámetros por tipo celular den una red sin sesgo de lado.
#
# Con el tacto eso ayuda, no molesta. Congelar el cero mientras toca la pegó más
# (53-56% del tiempo contra la pared, contra 32-36%): al soltar la pared el cero
# todavía guarda el toque, y la resta la sigue girando hacia afuera un rato.
CERO = 120
# Disparos de motoneuronas de pata por tick que valen un paso completo. Por
# debajo, el boss camina solo esa fracción de los ticks: más patas, más rápido.
# En una pelea las patas dan 32-64 por tick (mediana 46).
PASO = 50.0
# Lo mismo para la mosca espinal (`cordon.Espinal`), que da tasas y no disparos.
# El giro anclado igual que GIRO, en DNa02: una DNa02 sola mueve la asimetría
# del cordón ~0,4, y eso tiene que dar ~75°/s (0,022 rad por tick). El paso: sin
# tacto las motoneuronas suman ~1 Hz, que vale un paso por tick como la mediana
# de arriba.
GIRO_ESPINAL = 0.022 / 0.4
PASO_ESPINAL = 1.0

# El tacto: los 16 rayos del motor (egocéntricos: 0 adelante y el ángulo
# creciendo, así que 1-7 van por la derecha, ver arriba) → los sensores táctiles
# de las patas de ese lado.
# Adelante y atrás tocan los dos lados. (Sacarlos baja los toques simétricos del
# 13% al 2% y no cambia el tiempo contra la pared: 30/36% contra 36/32%.)
# Toca con todo cuando la pared está a un radio del centro y deja de tocar a
# ALCANCE, medio cuerpo más allá: el largo de una pata. La corriente es la de
# `patas.py`, donde el tacto pasa el experimento.
# Anticipar más no la aparta más (`--andar`, semillas 1 y 2, tacto / cruzado):
#   1.4 → 36/32% contra 79/72% · 2.0 → 44/24% contra 79/79% · 3.0 → 35/38% contra 79/72%
# El tacto satura en un tercio del tiempo contra la pared, lo toque cuando lo toque.
ALCANCE = 1.4
RADIO = 0.9  # BOSS_RADIUS
RAY_RANGE = 20.0  # raycast.rs: los rayos llegan normalizados a esto
DER, IZQ = np.arange(0, 9), np.r_[8:16, 0]

# ponytail: MECÁNICO, NO ES LA MOSCA. Esquivar paredes para que el juego se vea
# bien mientras el cerebro no dirige el rumbo (DNa02 no sobrevive al LIF, y el
# tacto satura en un tercio del tiempo contra la pared). Si hay pared a menos de
# AVISO por delante, el rumbo gira hacia donde los rayos ven más sitio libre.
# Solo en las peleas que se graban (`Piloto(grabar=True)`); los experimentos
# miden a la mosca sin esto. Se quita cuando algo del conectoma la aparte solo:
# el tacto con parámetros por tipo celular, los ojos, o `cerebro.py`.
AVISO = 3.0  # desde qué distancia del centro empieza a virar: dos cuerpos
VIRAJE = 0.15  # rad por tick como máximo: media vuelta en ~21 ticks, lo que tarda en cruzar AVISO


def virar(rayos) -> float:
    """Cuánto sumarle al rumbo este tick para no chocar con lo que tiene delante.

    ponytail: los rayos salen del `facing` del motor, que solo se actualiza al
    moverse; en los ticks quieta el giro se acumula sobre un rayo viejo. Con la
    mosca moviéndose el 86-95% de los ticks no se nota."""
    d = np.asarray(rayos) * RAY_RANGE
    ang = np.arange(d.size) * TAU / d.size
    cerca = np.clip((AVISO - d[np.cos(ang) > 0.1]) / (AVISO - RADIO), 0.0, 1.0).max()
    libre = np.arctan2((d * np.sin(ang)).sum(), (d * np.cos(ang)).sum())
    return float(np.clip(libre, -VIRAJE, VIRAJE) * cerca)



def de_costado(w) -> int:
    """Ángulo del dash, perpendicular a la línea jugador→boss, como byte.

    Es geometría pura: salirse del corredor del proyectil es una resta, no algo
    que haya nada que aprender. Lo que decide la mosca es *cuándo*.
    """
    ang = np.arctan2(w[5] - w[1], w[4] - w[0]) + np.pi / 2
    return int(round(ang / TAU * 256)) % 256


class Piloto:
    """La mosca, con su potencial de membrana persistiendo entre ticks.

    Que persista es el punto: si cada tick arrancara con una red recién nacida
    no habría dinámica, y la fibra gigante no podría integrar nada.
    """

    def __init__(self, red, semilla=0, grabar=False, tacto=1, fijas=None, espinal=False, **kw):
        """`tacto`: 1 como está cableado, -1 cruzado (la pared de la izquierda
        entra por los sensores de la derecha: el control), 0 sin tacto.
        `fijas`: neuronas que manda otro (los ojos, en `ojo_juego.Mosca`).
        `espinal`: las patas las mueve el cordón de tasas (`cordon.Espinal`) y
        no las motoneuronas del LIF."""
        self.sim = R.Simulador(red, R.Parametros(**kw), semilla, fijas=fijas)
        self.loom = red.indices("LC4", "LPLC2")
        self.gf = red.indices("DNp01")
        self.patas = P.Patas(red)
        izq, der = P.tacto(red)
        self.tacto = {1: (izq, der), -1: (der, izq), 0: None}[tacto]
        if espinal:
            import cordon as C
            self.espinal = C.Espinal(red, self.tacto, semilla)
        else:
            self.espinal = None
        self.ext = np.zeros(red.n, np.float32)
        # El cuerpo: hacia dónde mira y cuánto paso lleva acumulado. Arranca
        # mirando al centro de la arena (aparece pegado al borde derecho).
        self.rumbo, self.paso, self.cero = np.pi, 0.0, 0.0
        self.lados, self.rumbos = [], []  # por tick: (izq, der) y el rumbo
        # Por tick, qué neuronas dispararon al menos una vez. Es lo que dibuja el
        # panel del cerebro en el navegador.
        self.actividad = [] if grabar else None
        self.mecanico = grabar  # ver `virar`: el juego sí, los experimentos no

    def tick(self, looming: float, rayos=None) -> bool:
        self.ext[:] = 0.0
        self.ext[self.loom] = GANANCIA * looming
        self.tocar(rayos)
        return self.avanzar()

    def tocar(self, rayos):
        if rayos is not None and self.mecanico:
            self.rumbo += virar(rayos)
        if rayos is not None and self.tacto:
            toque = np.clip((ALCANCE - rayos * RAY_RANGE) / (ALCANCE - RADIO), 0.0, 1.0)
            self.ext[self.tacto[0]] = P.TACTO * toque[IZQ].max()
            self.ext[self.tacto[1]] = P.TACTO * toque[DER].max()
            if self.espinal:
                self.espinal.tocar(toque[IZQ].max(), toque[DER].max())

    def avanzar(self) -> bool:
        """Un tick de red con la entrada que ya está en `ext`: las patas mueven el
        cuerpo, y devuelve si disparó la fibra gigante. `self.d` queda con los
        disparos del tick, para quien lea otras neuronas."""
        d = self.d = self.sim.avanzar(TICK_MS, self.ext)
        if self.actividad is not None:
            act = np.flatnonzero(d.any(axis=0)).astype(np.uint32)
            self.actividad.append(self.espinal.activas(act) if self.espinal else act)
        if self.espinal:
            izq, der = self.espinal.tick(TICK_MS)
            # Ancla DNa02 (`cordon.py`): más actividad de un lado es girar hacia
            # ese lado, al revés que la tracción diferencial del LIF.
            asim, giro, paso = (izq - der) / max(izq + der, 1e-6), GIRO_ESPINAL, PASO_ESPINAL
        else:
            izq, der = self.patas.leer(d)
            asim, giro, paso = (der - izq) / max(izq + der, 1), GIRO, PASO
        self.lados.append((izq, der))
        self.cero += (asim - self.cero) / CERO
        self.rumbo -= giro * (asim - self.cero)
        self.rumbos.append(self.rumbo)
        self.paso += (izq + der) / paso
        return bool(d[:, self.gf].any())

    def caminar(self) -> tuple[int, int]:
        """La acción que sale de las patas en este tick: un paso hacia el rumbo,
        o quieta si las patas no juntaron para un paso."""
        if self.paso < 1.0:
            return IDLE, 0
        self.paso = min(self.paso - 1.0, 1.0)
        return MOVE | int(round(self.rumbo / TAU * 64)) % 64, 0

    def politica(self, t, looming, w, rayos) -> tuple[int, int]:
        """La mosca entera: la fibra gigante esquiva, y si no, caminan las patas."""
        if self.tick(looming, rayos):
            return self.esquivar(w)
        return self.caminar()

    def esquivar(self, w) -> tuple[int, int]:
        # El motor gira el cuerpo hacia donde salta (`boss.facing = param`). El
        # rumbo de acá lo sigue: un solo rumbo, el que se ve y el que usan los ojos.
        param = de_costado(w)
        self.rumbo = param / 256 * TAU
        return DASH, param


def corrida(politica, semilla=1, ticks=TICKS):
    """Una pelea. `politica(t, looming, w, rayos) -> (byte, param)` decide al boss."""
    env = engine.VecEnv(1, seed=semilla, arena=ARENA)
    # Una semilla distinta es un oponente con otro carácter —otra distancia de
    # tiro preferida— y por lo tanto otra pelea, no la misma con otro ruido.
    oponente = Oponente(semilla, arena=ARENA)
    obs = env.reset()
    looms, proyectil, esquivas, pos = [], [], [], []
    log, hp = env.fight_log(0), float(env.world_state()[0][7])

    for t in range(ticks):
        w = env.world_state()[0]
        looming = float(obs[0, engine.IDX_LOOMING])
        byte, param = politica(t, looming, w, obs[0, :16])
        looms.append(looming)
        proyectil.append(float(w[8]))
        esquivas.append(byte == DASH)
        pos.append((float(w[4]), float(w[5])))

        a = np.array([[oponente(w, obs[0]), byte, param]], np.uint8)

        obs, _, done = env.step(a)
        if done[0]:
            # El reinicio automático ya borró el episodio: queda el log de antes
            # de este último paso. Pedirlo después del bucle, como antes, dio un
            # log vacío en la primera pelea de 3600 ticks (`EPISODE_TICKS`).
            break
        log, hp = env.fight_log(0), float(env.world_state()[0][7])

    return {
        "log": log,
        "hp": hp,
        "looming": np.array(looms),
        "proyectil": np.array(proyectil),
        "esquivas": np.array(esquivas),
        "pos": np.array(pos),
    }


def abierto(red, traza):
    """¿DNp01 dispara *cuando* hay un tiro encima? Sin lazo, sin confusión.

    En lazo cerrado la esquiva cambia la trayectoria y con ella el escenario
    entero, así que precisión y cobertura se miden acá: una traza fija de
    looming, la mosca respondiendo, y nada que se realimente.
    """
    pil = Piloto(red)
    disparo = np.array([pil.tick(float(x)) for x in traza["looming"]])
    peligro = traza["proyectil"] > PELIGRO
    aciertos = int((disparo & peligro).sum())
    return {
        "gf": int(disparo.sum()),
        "peligro": int(peligro.sum()),
        "aciertos": aciertos,
        "precision": aciertos / max(int(disparo.sum()), 1),
        "cobertura": aciertos / max(int(peligro.sum()), 1),
        "base": float(peligro.mean()),
    }


def main():
    red = R.construir()
    print(f"red: {red.n:,} neuronas · LC4+LPLC2 {red.indices('LC4','LPLC2').size} · "
          f"DNp01 {red.indices('DNp01').size} · ganancia {GANANCIA:g}\n")

    print("=== lazo abierto: ¿dispara cuando hay un tiro? ===")
    quieto = corrida(lambda t, l, w, _: (IDLE, 0))
    a = abierto(red, quieto)
    print(f"  {TICKS} ticks, {a['peligro']} con proyectil encima ({a['base']:.1%})")
    print(f"  la fibra gigante disparó en {a['gf']} ticks")
    print(f"  precisión {a['precision']:.0%}  ·  cobertura {a['cobertura']:.0%}  ·  "
          f"lift {a['precision']/max(a['base'],1e-9):.1f}x sobre el azar\n")

    print("=== lazo cerrado: ¿esquivar así sirve? ===")
    print("                        esquivas   daño recibido")
    quietos, moscas, azares = [], [], []
    for s in range(SEMILLAS):
        quietos.append(corrida(lambda t, l, w, _: (IDLE, 0), semilla=s + 1))
        pil = Piloto(red, semilla=s)
        m = corrida(lambda t, l, w, _: (DASH, de_costado(w)) if pil.tick(l) else (IDLE, 0),
                    semilla=s + 1)
        moscas.append(m)
        # Mismas esquivas, ticks al azar. Es lo único que separa "la mosca sabe
        # cuándo" de "esquivar mucho ayuda".
        n = int(m["esquivas"].sum())
        cuando = set(np.random.default_rng(100 + s).choice(TICKS, n, replace=False).tolist())
        azares.append(corrida(lambda t, l, w, _: (DASH, de_costado(w)) if t in cuando else (IDLE, 0),
                              semilla=s + 1))

    dano = lambda rs: np.array([1000.0 - r["hp"] for r in rs])
    n_esq = np.mean([r["esquivas"].sum() for r in moscas])
    print(f"  boss quieto              {0:6}   {dano(quietos).mean():7.0f} ± {dano(quietos).std():.0f}")
    print(f"  esquiva la mosca         {n_esq:6.0f}   {dano(moscas).mean():7.0f} ± {dano(moscas).std():.0f}")
    print(f"  esquiva al azar          {n_esq:6.0f}   {dano(azares).mean():7.0f} ± {dano(azares).std():.0f}")

    print("\n--- veredicto ---")
    lift = a["precision"] / max(a["base"], 1e-9)
    dm, da = dano(moscas).mean(), dano(azares).mean()
    print(f"  timing: {lift:.1f}x más probable que dispare sobre una amenaza que al azar")
    print(f"  efecto: {dm:.0f} de daño contra {da:.0f} del control ({dm - da:+.0f})")
    if lift >= 3 and dm < da:
        print("\n  PASA: la fibra gigante se dispara con los tiros, y esquivar ahí"
              " cuesta menos daño que esquivar al azar.")
    elif lift >= 3:
        print("\n  A MEDIAS: el timing es real, pero no se traduce en menos daño."
              " El problema está en la esquiva, no en la mosca.")
    else:
        print("\n  NO: los disparos de la fibra gigante no siguen a la amenaza.")


ARENA_XY = np.array([32.0, 20.0])  # arenas/abierta.json


def marcha(red, tacto=1, semilla=1, espinal=False) -> dict:
    """Una pelea caminando, resumida en lo que dice si la marcha es degenerada."""
    pil = Piloto(red, tacto=tacto, espinal=espinal)
    r = corrida(pil.politica, semilla=semilla)
    pos = r["pos"]
    paso = np.linalg.norm(np.diff(pos, axis=0), axis=1)
    giro = np.diff(np.convolve(pil.rumbos, np.ones(30) / 30, "valid")) * 60  # rad/s
    return {
        "patas": float(np.median(np.sum(pil.lados, axis=1))),
        "mueve": float((paso > 0.01).mean()),
        "recorre": float(paso.sum()),
        "arena": len({tuple(c) for c in (pos // 2).astype(int)}) / (ARENA_XY.prod() / 4),
        # A menos de un radio y pico de una pared: tocándola.
        "pared": float((np.minimum(pos, ARENA_XY - pos).min(axis=1) < 1.1).mean()),
        "giro": float(np.degrees(np.median(abs(giro)))),
        "esquivas": int(r["esquivas"].sum()),
    }


def andar(red, espinal=False):
    """¿Camina, o se queda quieta contra una pared? Es la pregunta del README
    antes que cualquier otra.

    **Nadie le ordena caminar.** La primera versión encendía la marcha con
    corriente en DNg100, como `patas.py`, y el control sin ella dio lo mismo: 46
    disparos de pata por tick con y sin. Lo que despierta a las patas es la red
    entera cuando el jugador se acerca y el looming entra; la corriente solo las
    adelantaba 14 ticks. Así que se quitó.

    **Lo único que la dirige es el tacto**, el que pasa `patas.py`. El control es
    el tacto cruzado: la pared de la izquierda entrando por los sensores de la
    derecha. Si apartarse de la pared es del cableado, cruzado tiene que pegarla
    más, no menos.
    """
    print("=== patas: ¿camina? ===")
    print("                pelea  se mueve  recorrió  arena  contra pared  giro °/s  esquivas")
    for nombre, tacto in (("tacto", 1), ("cruzado", -1), ("sin tacto", 0)):
        for s in (1, 2):
            m = marcha(red, tacto, s, espinal)
            print(f"  {nombre:12} {s:5}  {m['mueve']:8.0%}  {m['recorre']:8.0f}  "
                  f"{m['arena']:5.0%}  {m['pared']:12.0%}  {m['giro']:8.0f}  {m['esquivas']:8}",
                  flush=True)


PUBLICO = Path(__file__).resolve().parent.parent / "web" / "public"


def exportar_cerebro(red):
    """`web/public/cerebro.bin`: dónde dibujar cada neurona, y de qué grupo es.

    `uint32 n`, `float32[n*3]` posiciones, `uint8[n]` grupo. Posiciones ya
    centradas, escaladas a ~1 y orientadas con el cerebro arriba y el cordón
    ventral abajo, para que el navegador no tenga que saber nada del volumen de
    EM. NaN donde no hay soma. Grupos: 0 el resto, 1 LC4/LPLC2 (los detectores de
    looming), 2 DNp01 (la fibra gigante).
    """
    p = R.somas(red)
    ok = ~np.isnan(p[:, 0])
    # El eje largo del volumen es z: cerebro en z≈27.000, cordón ventral en
    # z≈101.000. Va vertical, con el cerebro arriba.
    xyz = np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1)
    centro = np.nanmean(xyz[ok], axis=0)
    xyz = (xyz - centro) / np.nanmax(np.abs(xyz[ok] - centro))
    grupo = np.zeros(red.n, np.uint8)
    grupo[red.indices("LC4", "LPLC2")] = 1
    grupo[red.indices("DNp01")] = 2
    with open(PUBLICO / "cerebro.bin", "wb") as f:
        f.write(np.uint32(red.n).tobytes())
        f.write(xyz.astype(np.float32).tobytes())
        f.write(grupo.tobytes())
    return int(ok.sum())


def exportar_actividad(actividad, destino):
    """`uint32 ticks`, `uint32[ticks+1]` offsets, `uint32[]` índices de neurona."""
    offsets = np.zeros(len(actividad) + 1, np.uint32)
    offsets[1:] = np.cumsum([len(a) for a in actividad])
    with open(destino, "wb") as f:
        f.write(np.uint32(len(actividad)).tobytes())
        f.write(offsets.tobytes())
        f.write(np.concatenate(actividad).tobytes())
    return int(offsets[-1])


def grabar(nombre="mosca", espinal=False, ticks=TICKS):
    """Juega una pelea con la mosca y la deja en `web/public/<nombre>.bin`, más
    su actividad neuronal en `<nombre>.act` para el panel del cerebro."""
    red = R.construir()
    PUBLICO.mkdir(exist_ok=True)
    dibujadas = exportar_cerebro(red)
    pil = Piloto(red, grabar=True, espinal=espinal)
    r = corrida(pil.politica, ticks=ticks)

    # La comprobación que hace honesta a la grabación: el mismo motor re-simula
    # el log desde cero y tiene que llegar al mismo final. Si no, lo que se ve en
    # el navegador sería otra pelea.
    _, boss_hp, ticks = engine.reproducir(r["log"])
    assert boss_hp == r["hp"], f"la reproducción diverge: {boss_hp} contra {r['hp']}"
    # Y que el log sea la pelea entera (a lo sumo sin el paso que la cerró).
    assert ticks >= len(pil.actividad) - 1, f"el log tiene {ticks} ticks de {len(pil.actividad)}"

    destino = PUBLICO / f"{nombre}.bin"
    destino.write_bytes(r["log"])
    spikes = exportar_actividad(pil.actividad, PUBLICO / f"{nombre}.act")
    print(f"cerebro: {dibujadas:,} de {red.n:,} neuronas con posición · "
          f"{spikes:,} disparos grabados ({spikes / len(pil.actividad):.0f} por tick)")
    print(f"{ticks} ticks · {int(r['esquivas'].sum())} esquivas · "
          f"daño al boss {1000 - r['hp']:.0f} · {len(r['log'])} bytes")
    print(f"reproducción verificada → {destino.relative_to(destino.parents[2])}")
    print(f"\n  ./scripts/dev.sh   y abrí   http://localhost:5173/?pelea={nombre}")


if __name__ == "__main__":
    if "--grabar" in sys.argv:
        # `--ticks N`: una pelea más larga para mirar (900 son 15 s).
        ticks = int(sys.argv[sys.argv.index("--ticks") + 1]) if "--ticks" in sys.argv else TICKS
        espinal = "--espinal" in sys.argv
        grabar("espinal" if espinal else "mosca", espinal, ticks)
    elif "--andar" in sys.argv:
        andar(R.construir(), espinal="--espinal" in sys.argv)
    else:
        main()
