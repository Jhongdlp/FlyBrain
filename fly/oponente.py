"""El oponente guionado: rodea la cobertura, recupera la visión y dispara.

Existe porque el anterior mentía a favor de la mosca. Caminaba en línea recta
hacia el boss, y cuando una esquiva lo dejaba detrás de una caja se clavaba
contra ella sin visión y no volvía a disparar en toda la pelea. Cualquier
esquiva parecía salvadora, y "0 de daño" era un mérito del oponente tonto.

**No re-apunta: no hace falta.** El motor ya fija el cañón sobre el boss al
empezar cada disparo (`lib.rs`, el `param` de `Ability`). Lo que le faltaba era
**re-posicionarse**: encontrar un lugar con línea de visión y llegar hasta ahí
rodeando los muros. Eso es navegación, y es lo único que hace esta clase.

La navegación es BFS sobre una grilla de la arena, no el motor: esto es
utilería del experimento, no una regla de juego, y la verdad de si hay visión
para disparar la sigue diciendo la observación del motor (`IDX_LOS`).

    python fly/oponente.py      # la comprobación: sigue pegando tras una esquiva
"""

import json
from collections import deque
from pathlib import Path

import numpy as np

import engine

ARENA = Path(__file__).resolve().parent.parent / "arenas" / "launch.json"
TAU = 2 * np.pi
RES = 0.5  # lado de la celda, en unidades de mundo

# Radio del jugador más un margen: con 8 direcciones de teclado el camino no es
# perfecto, y sin holgura se roza cada esquina.
HOLGURA = 0.4 + 0.2
# Radio del proyectil del jugador: lo que tapa el tiro no es lo mismo que lo que
# tapa el paso.
RADIO_TIRO = 0.3
# **La línea de visión del motor es un rayo fino y el proyectil no.** Con el rayo
# como única condición, el oponente se paraba en (20.9, 9.0) —visión libre según
# el motor— y le disparaba 700 ticks seguidos a la esquina de una caja: el tiro
# pasaba a 0,23 de ella con radio 0,3. Por eso se pide el tubo entero despejado,
# con más margen al planear que al disparar: así la celda a la que llega el plan
# siempre pasa la condición de tiro, y no se queda quieto dudando.
MARGEN_PLAN = 0.35
MARGEN_TIRO = 0.15


def _dentro(px, py, muros, extra):
    """`(n,)` bool: qué puntos caen dentro de algún muro inflado en `extra`."""
    cx, cy, hx, hy = (muros[:, i][None, :] for i in range(4))
    return ((np.abs(px[:, None] - cx) <= hx + extra) &
            (np.abs(py[:, None] - cy) <= hy + extra)).any(axis=1)


class Oponente:
    def __init__(self, semilla=0):
        a = json.loads(ARENA.read_text())
        self.w, self.h = a["size"]
        self.muros = np.array(a["statics"], float)
        self.nx, self.ny = int(self.w / RES), int(self.h / RES)

        ix, iy = np.meshgrid(np.arange(self.nx), np.arange(self.ny), indexing="ij")
        self.cx = (ix.ravel() + 0.5) * RES
        self.cy = (iy.ravel() + 0.5) * RES
        borde = ((self.cx > HOLGURA) & (self.cx < self.w - HOLGURA) &
                 (self.cy > HOLGURA) & (self.cy < self.h - HOLGURA))
        self.libre = borde & ~_dentro(self.cx, self.cy, self.muros, HOLGURA)

        # El carácter de esta pelea: a qué distancia le gusta disparar. Sorteado
        # con la semilla para que semillas distintas sean peleas distintas, y no
        # la misma pelea con otro ruido — que era lo que medían las 4 semillas
        # del experimento anterior.
        rng = np.random.default_rng(semilla)
        self.rango = float(rng.uniform(6.0, 11.0))

        self._vision_para = None
        self._vision = None
        self._camino = []
        self._replanear = 0

    def _celda(self, x, y):
        i = min(max(int(x / RES), 0), self.nx - 1)
        j = min(max(int(y / RES), 0), self.ny - 1)
        return i * self.ny + j

    def _despejado(self, px, py, bx, by, margen):
        """¿Pasa un proyectil de `p` a `b` sin tocar muros? `px, py` pueden ser arrays."""
        px, py = np.atleast_1d(px), np.atleast_1d(py)
        t = np.linspace(0.0, 1.0, 40)[None, :]
        x = px[:, None] + (bx - px[:, None]) * t
        y = py[:, None] + (by - py[:, None]) * t
        tapado = _dentro(x.ravel(), y.ravel(), self.muros, RADIO_TIRO + margen)
        return ~tapado.reshape(x.shape).any(axis=1)

    def _con_vision(self, bx, by):
        """Qué celdas tienen tiro al boss en `(bx, by)`. Se cachea por celda del boss."""
        clave = self._celda(bx, by)
        if clave != self._vision_para:
            self._vision = self._despejado(self.cx, self.cy, bx, by, MARGEN_PLAN)
            self._vision_para = clave
        return self._vision

    def _vecinos(self, c):
        i, j = divmod(c, self.ny)
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            a, b = i + di, j + dj
            if not (0 <= a < self.nx and 0 <= b < self.ny):
                continue
            n = a * self.ny + b
            if not self.libre[n]:
                continue
            # Nada de cortar esquinas en diagonal: el cuerpo no pasa por ahí.
            if di and dj and not (self.libre[a * self.ny + j] and self.libre[i * self.ny + b]):
                continue
            yield n

    def _planear(self, px, py, bx, by):
        """BFS hasta la celda más cercana que ve al boss a la distancia preferida."""
        vision = self._con_vision(bx, by)
        d = np.hypot(self.cx - bx, self.cy - by)
        buena = self.libre & vision & (np.abs(d - self.rango) <= 2.0)
        if not buena.any():
            buena = self.libre & vision & (d >= 3.0)

        origen = self._celda(px, py)
        if not self.libre[origen]:
            # Pegado a un muro: se arranca desde la celda libre más cercana.
            libres = np.flatnonzero(self.libre)
            origen = libres[np.argmin(np.hypot(self.cx[libres] - px, self.cy[libres] - py))]

        previo = {origen: None}
        cola = deque([origen])
        while cola:
            c = cola.popleft()
            if buena[c]:
                camino = []
                while c is not None:
                    camino.append(c)
                    c = previo[c]
                return camino[::-1]
            for n in self._vecinos(c):
                if n not in previo:
                    previo[n] = c
                    cola.append(n)
        return []

    def __call__(self, w, obs) -> int:
        """El byte del jugador para este tick, empaquetado como en `log.rs`."""
        px, py, bx, by = float(w[0]), float(w[1]), float(w[4]), float(w[5])
        d = np.hypot(bx - px, by - py)
        # Las dos condiciones: el motor dice que hay visión, y el tubo del
        # proyectil está despejado. Ninguna alcanza sola.
        tiro = obs[engine.IDX_LOS] > 0.5 and self._despejado(px, py, bx, by, MARGEN_TIRO)[0]
        if tiro and d <= self.rango + 2.0:
            self._camino = []
            return 4 << 4  # cañón, sin moverse: el motor apunta solo

        self._replanear -= 1
        if not self._camino or self._replanear <= 0:
            self._camino = self._planear(px, py, bx, by)
            self._replanear = 20  # el boss se mueve: el plan caduca

        # Se sueltan las celdas ya alcanzadas y se apunta dos más adelante, que
        # es lo que evita el zigzag de las 8 direcciones.
        while len(self._camino) > 1 and np.hypot(
                self.cx[self._camino[0]] - px, self.cy[self._camino[0]] - py) < RES:
            self._camino.pop(0)
        if not self._camino:
            objetivo = (bx, by)
        else:
            c = self._camino[min(2, len(self._camino) - 1)]
            objetivo = (self.cx[c], self.cy[c])

        ang = np.arctan2(objetivo[1] - py, objetivo[0] - px)
        return 0x08 | (int(round(ang / TAU * 8)) % 8)


def _pelea(oponente, esquiva_en=(), ticks=900):
    """Daño al boss por tramo de 300 ticks. El boss solo esquiva donde se le dice."""
    DASH = (2 << 6) | (4 << 3)
    env = engine.VecEnv(1, seed=1)
    obs = env.reset()
    hp = [1000.0]
    for t in range(ticks):
        w = env.world_state()[0]
        if t in esquiva_en:
            ang = np.arctan2(w[5] - w[1], w[4] - w[0]) + np.pi / 2
            boss = (DASH, int(round(ang / TAU * 256)) % 256)
        else:
            boss = (0, 0)
        obs, _, done = env.step(np.array([[oponente(w, obs[0]), *boss]], np.uint8))
        if t % 300 == 299:
            hp.append(float(env.world_state()[0][7]))
        if done[0]:
            break
    return np.diff(hp) * -1


if __name__ == "__main__":
    quieto = _pelea(Oponente())
    tras = _pelea(Oponente(), esquiva_en=range(130, 138))
    print("daño al boss por tramo de 300 ticks")
    print(f"  boss quieto            {quieto}")
    print(f"  esquiva en el tick 130 {tras}")
    # La regresión exacta que motivó este archivo: la esquiva de la mosca en el
    # tick 130 dejaba al boss detrás de una caja, y el oponente viejo no volvía
    # a pegar nunca más.
    assert tras[1:].sum() > 0, "tras la esquiva el oponente dejó de pegar"
    assert quieto.sum() > 0, "el oponente no le pega ni a un boss quieto"
    print("\nOK: rodea la cobertura y sigue pegando después de una esquiva")
