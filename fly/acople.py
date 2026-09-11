"""Ojos de verdad: `flyvis` ve, y nuestro conectoma sigue desde ahí.

`flyvis` simula el sistema visual hasta los detectores de movimiento (T4/T5)
con parámetros entrenados sobre la conectividad del conectoma. Su respuesta se
inyecta como corriente en las neuronas **homólogas** de MaleCNS —mismo tipo,
misma columna—, y de ahí en adelante manda el cableado de MaleCNS sin
entrenar: LPLC2, LC4, la fibra gigante.

Tres piezas, cada una validada por separado antes de juntarlas:

- **Columnas.** Las T4/T5 de MaleCNS no traen columna; se derivan de sus
  vecinos sinápticos (`ojo.columnas_derivadas`). Escondiendo la anotación de
  Mi1, Tm1 y Tm9, la derivación acierta la columna en el 98-100%.
- **Orientación.** Las entradas T4/T5 de las 84 LPLC2 del ojo derecho forman
  una cruz —cada dirección de movimiento desplazada hacia su lado—, y esa cruz
  ancla qué es arriba y qué es atrás en la grilla de MaleCNS. El mapa ajustado
  con dos direcciones predice la tercera con 2° de error.
- **Acople.** Corriente = ganancia × lo que la neurona de `flyvis` se despolariza
  sobre su reposo. Las neuronas acopladas quedan fijadas: ignoran su entrada
  sináptica de MaleCNS, que en el lóbulo óptico no funciona sin entrenar.

    .venv-ojo/bin/python fly/ojo_flyvis.py   # primero: el ojo mira los estímulos
    python fly/acople.py                     # después: el conectoma responde
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ojo as O  # noqa: E402
import red as R  # noqa: E402

DATOS = R.DATOS
ESTIMULOS = ("looming", "se_aleja", "desplaza_centro", "desplaza_arriba", "oscurece")
GANANCIAS = (1.5, 3.0, 6.0)
# Hasta cuántas columnas de distancia se acepta emparejar una neurona de MaleCNS
# con la célula de flyvis más cercana. Las dos grillas no coinciden punto a punto
# (una es cuadrada en sus coordenadas y la otra hexagonal).
EMPAREJAR = 0.75
# La medida es el **pico**: la tasa máxima en cualquier ventana de 250 ms. La
# primera versión promediaba de los 200 ms al final, y el looming —que hace todo
# en los últimos 250 ms antes del choque— quedaba diluido: LC4 llegaba a 43 Hz
# en ese tramo y el promedio decía 8,8. El pico además es justo con todos los
# estímulos (ninguno tiene "su" ventana) y es lo que va a usar el juego: el boss
# reacciona cuando la tasa cruza un umbral, en el momento que sea.
VENTANA_MS = 250.0


def cruz(red, H, lado):
    """Corrimiento medio, en columnas de MaleCNS, de las entradas T4/T5 de cada
    subtipo (a-d) a las LPLC2 de un ojo, respecto de todas sus entradas T4/T5.

    Cada LPLC2 recibe cada dirección de movimiento desde el brazo de su campo
    receptivo donde un objeto que se expande se mueve en esa dirección (Klapoetke
    et al., 2017): los cuatro corrimientos forman una cruz, y apuntan hacia donde
    prefiere cada subtipo."""
    de_lado = O._columnas(red)["lado"].to_numpy() == lado
    lplc2 = np.flatnonzero((red.tipo == "LPLC2") & de_lado)
    W = abs(red.W).tocsr()[lplc2]  # (LPLC2, pre)
    con_col = ~np.isnan(H[:, 0])
    Hc = np.nan_to_num(H)

    def media(mascara):
        Ws = W[:, np.flatnonzero(mascara & con_col)]
        peso = np.asarray(Ws.sum(1)).ravel()
        return (Ws @ Hc[mascara & con_col]) / np.maximum(peso, 1e-9)[:, None], peso

    todas, _ = media(np.isin(red.tipo, [f"T{k}{s}" for k in "45" for s in "abcd"]) & de_lado)
    d = []
    for s in "abcd":
        m, peso = media(np.isin(red.tipo, [f"T4{s}", f"T5{s}"]) & de_lado)
        ok = peso > 0
        d.append((m[ok] - todas[ok]).mean(0))
    return np.array(d)


def mapa(red, H, lado, cal):
    """El giro (o espejo) que lleva la cruz de LPLC2 de un ojo a las direcciones
    preferidas de T5a-d en `flyvis` (`cal`): Procrustes ortogonal. Devuelve el
    mapa y cuánto se desvía cada brazo de la cruz, en grados."""
    d = cruz(red, H, lado)
    dn = d / np.linalg.norm(d, axis=1, keepdims=True)
    u, _, vt = np.linalg.svd(cal.T @ dn)
    M = u @ vt
    llega = dn @ M.T
    error = np.degrees(np.arccos(np.clip((llega * cal).sum(1), -1, 1)))
    return M, error


class Acople:
    def __init__(self, red: R.Red, lado: str = "R"):
        """El acople de un ojo: `flyvis` le da al lóbulo óptico de ese `lado`.

        Los dos ojos usan la misma grilla de `flyvis` (+x adelante, +y arriba):
        el izquierdo se dibuja en espejo (`ojo_flyvis.retina_de`). El mapa del
        derecho es el que se validó a mano (`mapa_malecns_flyvis.npy`); el del
        izquierdo sale del mismo ajuste por la cruz de LPLC2, que reproduce el del
        derecho (`chequear_mapas`)."""
        self.red = red
        self.ojo = lado
        H, _ = O.columnas_derivadas(red, lado)
        lados = O._columnas(red)["lado"].to_numpy()
        cal = np.load(DATOS / "flyvis_calibracion.npy")
        # El mapa se ajustó asumiendo esta calibración. Si flyvis cambiara la
        # orientación de su grilla, todo el acople quedaría girado sin avisar.
        assert np.allclose(cal, [(-1, 0), (1, 0), (0, 1), (0, -1)]), \
            f"la calibración de T5 cambió: {cal.tolist()}; rehacer el mapa"
        if lado == "R":
            M = np.load(DATOS / "mapa_malecns_flyvis.npy")
        else:
            M, error = mapa(red, H, lado, cal)
            assert error.max() < 30, f"la cruz de LPLC2 del ojo {lado} no cierra: {error.round()}"

        # El centro de la grilla de flyvis es el centro del ojo de MaleCNS.
        mi1 = (red.tipo == "Mi1") & (lados == lado) & ~np.isnan(H[:, 0])
        centro = np.median(H[mi1], axis=0)
        self.en_flyvis = (H - centro) @ M.T  # posición de cada neurona en la grilla de flyvis
        self.lado = lados
        self.pares = None

    def emparejar(self, xy_por_tipo):
        """Para cada tipo: qué neurona de MaleCNS recibe de qué célula de flyvis."""
        self.pares = {}
        for t, xy in xy_por_tipo.items():
            idx = np.flatnonzero((self.red.tipo == t) & (self.lado == self.ojo)
                                 & ~np.isnan(self.en_flyvis[:, 0]))
            if not idx.size:
                continue
            d = np.hypot(self.en_flyvis[idx, None, 0] - xy[None, :, 0],
                         self.en_flyvis[idx, None, 1] - xy[None, :, 1])
            j = d.argmin(1)
            ok = d[np.arange(idx.size), j] <= EMPAREJAR
            self.pares[t] = (idx[ok], j[ok])
        return self.pares

    @property
    def fijas(self):
        return np.concatenate([i for i, _ in self.pares.values()])

    def correr(self, respuesta, ganancia, semilla=0, dt_ojo=0.01, leer=None):
        """Corre el LIF con el ojo acoplado. `respuesta[t]` es `(cuadros, 721)`.

        `leer(disparos)` reduce cada cuadro antes de guardarlo: una pelea entera
        sin reducir son 5 GB de disparos.
        """
        sim = R.Simulador(self.red, R.Parametros(), semilla, fijas=self.fijas)
        cuadros = next(iter(respuesta.values())).shape[0]
        pasos_por_cuadro = int(round(dt_ojo * 1000 / sim.p.dt))
        ext = np.zeros(self.red.n, np.float32)
        salida = []
        for k in range(cuadros):
            ext[:] = 0.0
            for t, (i, j) in self.pares.items():
                ext[i] = ganancia * np.maximum(respuesta[t][k, j], 0.0)
            d = sim.avanzar(pasos_por_cuadro * sim.p.dt, ext)
            salida.append(d if leer is None else leer(d))
        return np.concatenate(salida), sim.p


def pico(disparos, idx, p, ventana_ms=VENTANA_MS):
    """Tasa máxima del grupo, en Hz, en cualquier ventana de `ventana_ms`."""
    por_paso = disparos[:, idx].sum(axis=1).astype(float)
    n = int(ventana_ms / p.dt)
    suma = np.convolve(por_paso, np.ones(n), mode="valid")
    return float(suma.max() / idx.size / (ventana_ms / 1000.0))


def cargar(nombre):
    z = np.load(DATOS / f"flyvis_{nombre}.npz")
    tipos = [k[2:] for k in z.files if k.startswith("r_")]
    return {t: z[f"r_{t}"] for t in tipos}, {t: z[f"xy_{t}"] for t in tipos}


def main():
    red = R.construir()
    ac = Acople(red)
    _, xy = cargar("looming")
    pares = ac.emparejar(xy)
    n = sum(len(i) for i, _ in pares.values())
    print(f"neuronas de MaleCNS acopladas al ojo: {n:,} en {len(pares)} tipos")
    for t in ("T4a", "T5c", "Tm3", "LPLC2"):
        if t in pares:
            print(f"  {t:5} {len(pares[t][0]):4} emparejadas")

    lado = ac.lado
    grupos = {
        "LPLC2": np.flatnonzero((red.tipo == "LPLC2") & (lado == "R")),
        "LC4": np.flatnonzero((red.tipo == "LC4") & (lado == "R")),
        "DNp01": red.indices("DNp01"),
    }
    todas = np.arange(red.n)

    print(f"\n{'ganancia':>8} {'estímulo':16}" + "".join(f"{g:>9}" for g in grupos) + "   red Hz")
    tabla = {}
    for g in GANANCIAS:
        for nombre in ESTIMULOS:
            resp, _ = cargar(nombre)
            d, p = ac.correr(resp, g)
            fila = {k: pico(d, v, p) for k, v in grupos.items()}
            tabla[(g, nombre)] = fila
            print(f"{g:8} {nombre:16}" + "".join(f"{fila[k]:9.1f}" for k in grupos)
                  + f"   {R.hz(d, todas, p):5.1f}", flush=True)
        print()

    # La salida es LPLC2/LC4, no la fibra gigante: con ojos de verdad, la
    # inhibición del cerebro central —GABAérgica, real en el cableado, pero sin
    # su fuerza y su momento correctos en un modelo sin entrenar— apaga a DNp01
    # justo durante el looming. DNp01 se sigue midiendo, pero no decide.
    print("--- veredicto: ¿el pico del looming le gana al de cada control? ---")
    for g in GANANCIAS:
        for k in ("LPLC2", "LC4"):
            loom = tabla[(g, "looming")][k]
            peor = max(tabla[(g, n)][k] for n in ESTIMULOS[1:])
            print(f"  ganancia {g:4}  {k:6} looming {loom:6.1f} Hz · mejor control {peor:6.1f} Hz · "
                  f"{'PASA' if loom >= 2 * max(peor, 0.5) else 'no'}")


if __name__ == "__main__":
    main()
