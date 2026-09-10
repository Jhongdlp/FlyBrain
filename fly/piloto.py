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
    python fly/piloto.py --grabar     # una pelea de la mosca para verla en el navegador
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402
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
# Un proyectil encima. Sobre `de_proyectiles`, no sobre lo que ve la mosca: el
# jugador acercándose también le expande el campo visual —y está bien que así
# sea, es el mismo circuito— pero no es algo que se pueda esquivar.
PELIGRO = 0.05

# Empaquetado de acciones, igual que en `engine/src/log.rs`.
IDLE = 0
DASH = (2 << 6) | (4 << 3)  # Use(ToolId::Dash, param)



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

    def __init__(self, red, semilla=0, **kw):
        self.sim = R.Simulador(red, R.Parametros(**kw), semilla)
        self.loom = red.indices("LC4", "LPLC2")
        self.gf = red.indices("DNp01")
        self.ext = np.zeros(red.n, np.float32)

    def tick(self, looming: float) -> bool:
        self.ext[:] = 0.0
        self.ext[self.loom] = GANANCIA * looming
        return bool(self.sim.avanzar(TICK_MS, self.ext)[:, self.gf].any())


def corrida(politica, semilla=1):
    """Una pelea. `politica(t, looming, w) -> (byte, param)` decide al boss."""
    env = engine.VecEnv(1, seed=semilla)
    # Una semilla distinta es un oponente con otro carácter —otra distancia de
    # tiro preferida— y por lo tanto otra pelea, no la misma con otro ruido.
    oponente = Oponente(semilla)
    obs = env.reset()
    looms, proyectil, esquivas = [], [], []

    for t in range(TICKS):
        w = env.world_state()[0]
        looming = float(obs[0, engine.IDX_LOOMING])
        byte, param = politica(t, looming, w)
        looms.append(looming)
        proyectil.append(float(w[8]))
        esquivas.append(byte == DASH)

        a = np.array([[oponente(w, obs[0]), byte, param]], np.uint8)

        obs, _, done = env.step(a)
        if done[0]:
            break

    return {
        # El log sale antes de que el entorno se reinicie: `fight_log` es el
        # episodio en curso, y el reinicio automático lo borraría.
        "log": env.fight_log(0),
        "hp": float(env.world_state()[0][7]),
        "looming": np.array(looms),
        "proyectil": np.array(proyectil),
        "esquivas": np.array(esquivas),
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
    quieto = corrida(lambda t, l, w: (IDLE, 0))
    a = abierto(red, quieto)
    print(f"  {TICKS} ticks, {a['peligro']} con proyectil encima ({a['base']:.1%})")
    print(f"  la fibra gigante disparó en {a['gf']} ticks")
    print(f"  precisión {a['precision']:.0%}  ·  cobertura {a['cobertura']:.0%}  ·  "
          f"lift {a['precision']/max(a['base'],1e-9):.1f}x sobre el azar\n")

    print("=== lazo cerrado: ¿esquivar así sirve? ===")
    print("                        esquivas   daño recibido")
    quietos, moscas, azares = [], [], []
    for s in range(SEMILLAS):
        quietos.append(corrida(lambda t, l, w: (IDLE, 0), semilla=s + 1))
        pil = Piloto(red, semilla=s)
        m = corrida(lambda t, l, w: (DASH, de_costado(w)) if pil.tick(l) else (IDLE, 0),
                    semilla=s + 1)
        moscas.append(m)
        # Mismas esquivas, ticks al azar. Es lo único que separa "la mosca sabe
        # cuándo" de "esquivar mucho ayuda".
        n = int(m["esquivas"].sum())
        cuando = set(np.random.default_rng(100 + s).choice(TICKS, n, replace=False).tolist())
        azares.append(corrida(lambda t, l, w: (DASH, de_costado(w)) if t in cuando else (IDLE, 0),
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


def grabar(nombre="mosca"):
    """Juega una pelea con la mosca y la deja en `web/public/<nombre>.bin`."""
    red = R.construir()
    pil = Piloto(red)
    r = corrida(lambda t, l, w: (DASH, de_costado(w)) if pil.tick(l) else (IDLE, 0))

    # La comprobación que hace honesta a la grabación: el mismo motor re-simula
    # el log desde cero y tiene que llegar al mismo final. Si no, lo que se ve en
    # el navegador sería otra pelea.
    _, boss_hp, ticks = engine.reproducir(r["log"])
    assert boss_hp == r["hp"], f"la reproducción diverge: {boss_hp} contra {r['hp']}"

    destino = Path(__file__).resolve().parent.parent / "web" / "public" / f"{nombre}.bin"
    destino.parent.mkdir(exist_ok=True)
    destino.write_bytes(r["log"])
    print(f"{ticks} ticks · {int(r['esquivas'].sum())} esquivas · "
          f"daño al boss {1000 - r['hp']:.0f} · {len(r['log'])} bytes")
    print(f"reproducción verificada → {destino.relative_to(destino.parents[2])}")
    print(f"\n  ./scripts/dev.sh   y abrí   http://localhost:5173/?pelea={nombre}")


if __name__ == "__main__":
    grabar() if "--grabar" in sys.argv else main()
