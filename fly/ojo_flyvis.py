"""El ojo: `flyvis` mira un estímulo y deja lo que respondió cada neurona.

Corre en su propio entorno (`.venv-ojo`, Python 3.11: `flyvis` no soporta 3.14)
y se comunica con el resto por archivos. Además de la compatibilidad, así el
LIF no carga PyTorch en memoria al mismo tiempo: juntos no entran en 6 GB.

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

    def mirar(self, cuadros):
        mov = torch.tensor(cuadros.astype(np.float32))[:, None, :]
        estado = self.red.fade_in_state(1.0, DT, mov[[0]])
        r = self.red.simulate(mov[None], DT, initial_state=estado).cpu()
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
