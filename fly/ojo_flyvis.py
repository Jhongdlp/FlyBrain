"""El ojo: `flyvis` mira un estímulo y deja lo que respondió cada neurona.

Corre en su propio entorno (`.venv-ojo`, Python 3.11: `flyvis` no soporta 3.14).
El LIF también corre ahí si hace falta tenerlos juntos (`ojo_juego.py`): los dos
cargados ocupan 1,3 GB.

`flyvis` es el modelo de Lappalainen et al. (Nature, 2024): la conectividad del
sistema visual sale del conectoma y solo 734 parámetros —unos pocos por tipo
celular— están entrenados. Llega hasta los detectores de movimiento T4/T5; de ahí
en adelante (LC4, LPLC2, la fibra gigante) sigue nuestro conectoma.

    .venv-ojo/bin/python fly/ojo_flyvis.py          # → data/flyvis_<estímulo>.npz

Cada archivo guarda, por tipo celular, la respuesta **sobre el reposo** de sus
721 células en cada cuadro de 10 ms, y su posición en la grilla de `flyvis` en
unidades de columna. La calibración de dirección de T5 va aparte, para que el
acople pueda comprobar que la orientación que asumió sigue siendo cierta.
"""

import sys
from pathlib import Path

import numpy as np
import torch
import flyvis
from scipy.special import ndtr
from flyvis.utils import hex_utils
from flyvis.utils.activity_utils import LayerActivity

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ojo import TIPOS_FLYVIS  # noqa: E402  (solo importa constantes: nada de red.py)

DATOS = Path(__file__).resolve().parent.parent / "data"
MODELO = "flow/0000/000"
DT = 1 / 100
CUADROS = 110
FONDO = 0.5  # luminancia del fondo gris; los objetos son oscuros (0)

U, V = hex_utils.get_hex_coords(15)
_x, _y = map(lambda a: np.asarray(a, float), hex_utils.hex_to_pixel(U, V))
PASO = np.sort(np.hypot(_x - _x[0], _y - _y[0]))[1]
X, Y = _x / PASO, _y / PASO  # posición de cada columna, en columnas


# Hacia dónde mira cada columna, para dibujar el juego. La grilla de `flyvis` no
# trae orientación; sale de la calibración de T5: T5a prefiere -x y T5c +y, y en
# la mosca T5a es de adelante hacia atrás y T5c hacia arriba (Maisak et al.,
# 2013). Así que +x es adelante y +y arriba, y ésta es la grilla del ojo derecho.
GRADOS = 5.0       # entre omatidios vecinos
CENTRO_AZ = 75.0   # el centro del ojo derecho, en grados a la derecha del frente
ACEPTANCIA = 5.0   # ancho a media altura de lo que ve un omatidio
AZ = np.radians(CENTRO_AZ - X * GRADOS)
EL = np.radians(Y * GRADOS)


SIGMA = np.radians(ACEPTANCIA) / 2.355

# La arena: el borde es un muro (el motor lo trata como pared: ni los cuerpos
# ni los rayos lo cruzan). Con franjas verticales, porque un muro liso no le da
# movimiento al ojo y la mosca no lo podría ver venir.
MURO_ALTO = 2.4    # ALTURA_MURO en render.ts
OJO_ALTO = 0.5     # la cabeza de la mosca sobre el piso
FRANJA = 2.0       # período de las franjas, en unidades del mundo
SUELO = 0.8 * FONDO


def muros(ojo_xy, rumbo, az, arena):
    """Luminancia del borde de la arena `(ancho, alto)` en cada columna.

    Cada columna tira un rayo horizontal hasta el borde. El muro ocupa las
    elevaciones entre el piso y su altura a esa distancia; arriba es fondo y
    abajo el piso. Las franjas pierden contraste con la distancia como en un ojo
    de verdad: la aceptancia gaussiana del omatidio es un filtro, y franjas más
    finas que una columna producirían aliasing —movimiento que no existe.
    """
    fi = rumbo + az
    c, s = np.cos(fi), np.sin(fi)
    ex, ey = ojo_xy
    with np.errstate(divide="ignore", invalid="ignore"):
        tx = np.where(c > 0, (arena[0] - ex) / c, np.where(c < 0, -ex / c, np.inf))
        ty = np.where(s > 0, (arena[1] - ey) / s, np.where(s < 0, -ey / s, np.inf))
    d = np.maximum(np.minimum(tx, ty), 1e-3)
    en_x = tx < ty
    a_lo_largo = np.where(en_x, ey + d * s, ex + d * c)
    oblicuo = np.maximum(np.where(en_x, abs(c), abs(s)), 1e-3)
    f = d / (FRANJA * oblicuo)  # ciclos por radián
    contraste = 0.6 * np.exp(-2 * (np.pi * SIGMA * f) ** 2)
    muro = FONDO * (1 + contraste * np.sin(2 * np.pi * a_lo_largo / FRANJA))
    arriba, abajo = np.arctan2(MURO_ALTO - OJO_ALTO, d), np.arctan2(-OJO_ALTO, d)
    w = ndtr((arriba - EL) / SIGMA) * ndtr((EL - abajo) / SIGMA)
    return w * muro + (1 - w) * np.where(EL < abajo, SUELO, FONDO)


def retina_de(ojo_xy, rumbo, objetos, lado=1, arena=None):
    """Luminancia en las 721 columnas de un ojo, parado en `ojo_xy` y con el
    cuerpo mirando hacia `rumbo` (radianes, como `facing` en el motor).

    `lado` 1 es el ojo derecho y -1 el izquierdo: el mismo ojo en espejo, así
    la grilla de `flyvis` sigue con +x adelante en los dos. El mundo del motor
    es y-abajo, así que un ángulo positivo respecto del rumbo queda a la
    derecha. `arena` agrega el borde como muro (`muros`).

    Cada objeto `[x, y, radio]` es una esfera oscura a la altura del ojo. Cada
    omatidio promedia con una gaussiana de `ACEPTANCIA`: sin eso un proyectil
    más chico que una columna parpadea al pasar entre ellas.
    """
    az_col = lado * AZ
    lum = np.full(len(X), FONDO) if arena is None else muros(ojo_xy, rumbo, az_col, arena)
    for x, y, r in objetos:
        dx, dy = x - ojo_xy[0], y - ojo_xy[1]
        d = np.hypot(dx, dy)
        if d <= r:
            continue
        az = np.arctan2(dy, dx) - rumbo
        alfa = np.arcsin(r / d)
        delta = np.arccos(np.clip(np.cos(EL) * np.cos(az_col - az), -1.0, 1.0))
        lum *= 1.0 - (ndtr((alfa - delta) / SIGMA) - ndtr((-alfa - delta) / SIGMA))
    return lum


class EnVivo:
    """El ojo en lazo cerrado: los dos ojos en un lote, un tick por vez,
    arrastrando su estado. Lo que ve en un tick depende de lo que hizo el cuerpo
    en el anterior, así que no se puede mirar la película entera de una vez.

    `ver(cuadros)` con `(ojos, 721)` devuelve por tipo la respuesta sobre el
    reposo, `(ojos, 721)`, promediada en los `subpasos` del tick.
    """

    def __init__(self, ojo, tipos, dt, subpasos, ojos=2):
        self.red, self.dt, self.sub = ojo.red, dt, subpasos
        self.idx = {t: np.flatnonzero(ojo.tipo == t) for t in tipos}
        gris = torch.full((ojos, 1, len(X)), FONDO)
        with torch.no_grad():
            estado = self.red.fade_in_state(1.0, dt, gris)
            quieto = self.red.simulate(gris[:, None].expand(ojos, 100, 1, len(X)), dt,
                                       initial_state=estado, as_states=True)
        self.estado = quieto[-1]
        self.reposo = quieto[-1].nodes.activity.numpy().copy()

    def ver(self, cuadros):
        mov = torch.tensor(cuadros.astype(np.float32))[:, None, None, :]
        with torch.no_grad():
            estados = self.red.simulate(mov.expand(-1, self.sub, 1, -1), self.dt,
                                        initial_state=self.estado, as_states=True)
        self.estado = estados[-1]
        a = torch.stack([e.nodes.activity for e in estados]).mean(0).numpy() - self.reposo
        return {t: a[:, i] for t, i in self.idx.items()}


def disco(radio, cx=None, cy=0.0):
    cx = np.zeros(CUADROS) if cx is None else cx
    return np.array([np.where(np.hypot(X - cx[k], Y - cy) <= radio[k], 0.0, FONDO)
                     for k in range(CUADROS)])


def estimulos():
    t = np.arange(CUADROS) * DT
    # Looming con perfil físico: el radio crece como 1/(tiempo hasta el choque),
    # que es lo que hace un objeto que se acerca a velocidad constante.
    loom = np.clip(0.8 / np.maximum(1.0 - t, 1e-3), 0, 16) * (t > 0.2)
    cubierto = (disco(loom) == 0).mean(1)
    # Los desplazamientos entran y salen desde fuera del ojo y están presentes
    # todo el tiempo: simétricos respecto del centro. La primera versión hacía
    # aparecer el disco de golpe a un costado e inflaba el movimiento "hacia
    # afuera", que es justo lo que había que descartar.
    viaje = np.linspace(-22, 22, CUADROS)
    # El que se aleja recorre el looming al revés, pero **solo hasta radio 6**, y
    # arranca ya presente. La primera versión invertía el looming entero:
    # empezaba con un disco que tapaba todo el ojo y se achicaba rápido, y ese
    # golpe de luz disparaba a LC4 a 57 Hz sin nada que ver con alejarse.
    tramo = loom[(loom > 0) & (loom <= 6.0)][::-1]
    aleja = np.zeros(CUADROS)
    aleja[:20] = tramo[0]
    aleja[20:20 + len(tramo)] = tramo[:CUADROS - 20]
    return {
        "looming": disco(loom),
        "se_aleja": disco(aleja),
        "desplaza_centro": disco(np.full(CUADROS, 4.0), viaje),
        "desplaza_arriba": disco(np.full(CUADROS, 4.0), viaje, cy=7.0),
        # La misma cantidad de oscuridad que el looming, sin forma ni movimiento.
        "oscurece": np.tile((FONDO * (1 - cubierto))[:, None], (1, len(X))),
    }


class Ojo:
    def __init__(self, modelo=MODELO):
        self.red = flyvis.NetworkView(flyvis.results_dir / modelo).init_network()
        c = self.red.connectome
        self.tipo = np.array([t.decode() if isinstance(t, bytes) else str(t)
                              for t in c.nodes.type[:]])
        self.nu = np.asarray(c.nodes.u[:], float)
        self.nv = np.asarray(c.nodes.v[:], float)

    def mirar(self, cuadros, dt=DT):
        mov = torch.tensor(cuadros.astype(np.float32))[:, None, :]
        estado = self.red.fade_in_state(1.0, dt, mov[[0]])
        r = self.red.simulate(mov[None], dt, initial_state=estado).cpu()
        return LayerActivity(r, self.red.connectome, keepref=True)

    def posicion(self, tipo):
        """Posición de cada célula del tipo, en el orden de `LayerActivity`."""
        m = self.tipo == tipo
        px, py = hex_utils.hex_to_pixel(self.nu[m], self.nv[m])
        return np.asarray(px) / PASO, np.asarray(py) / PASO

    def calibrar(self):
        """Dirección preferida de T5a-d: un borde oscuro barriendo en cuatro
        direcciones, y gana la que más respuesta da sobre el reposo."""
        base = self.mirar(np.full((CUADROS, len(X)), FONDO))
        dirs = {(1, 0): "+x", (-1, 0): "-x", (0, 1): "+y", (0, -1): "-y"}
        suma = {}
        for (dx, dy) in dirs:
            frente = np.linspace(-16, 16, CUADROS)[:, None]
            a = self.mirar(np.where((X * dx + Y * dy)[None, :] < frente, 0.0, FONDO))
            for s in "abcd":
                k = f"T5{s}"
                r = np.clip(a[k][0, 20:].numpy() - base[k][0, 20:].numpy(), 0, None)
                suma[(k, (dx, dy))] = r.sum()
        return {f"T5{s}": max(dirs, key=lambda d: suma[(f"T5{s}", d)]) for s in "abcd"}


def main():
    DATOS.mkdir(exist_ok=True)
    ojo = Ojo()
    cal = ojo.calibrar()
    print("dirección preferida de T5:", {k: v for k, v in cal.items()})
    np.save(DATOS / "flyvis_calibracion.npy", np.array([cal[f"T5{s}"] for s in "abcd"], float))

    base = ojo.mirar(np.full((CUADROS, len(X)), FONDO))
    tipos = [t for t in TIPOS_FLYVIS if (ojo.tipo == t).any()]
    for nombre, cuadros in estimulos().items():
        a = ojo.mirar(cuadros)
        guardar = {}
        for t in tipos:
            guardar[f"r_{t}"] = (a[t][0].numpy() - base[t][0].numpy()).astype(np.float32)
            guardar[f"xy_{t}"] = np.stack(ojo.posicion(t), axis=1).astype(np.float32)
        np.savez_compressed(DATOS / f"flyvis_{nombre}.npz", dt=DT, **guardar)
        print(f"  {nombre:16} {len(tipos)} tipos × {CUADROS} cuadros → data/flyvis_{nombre}.npz")


if __name__ == "__main__":
    main()
