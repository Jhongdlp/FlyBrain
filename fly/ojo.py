"""La retina: a dónde mira cada fotorreceptor.

Los fotorreceptores R1-R6 del conectoma no traen coordenada de columna. Las
neuronas de la lámina a las que les hablan sí (L1, L2 y L3, al 99%), así que cada
fotorreceptor hereda la columna de la neurona de lámina a la que más sinapsis le
da. Es el mismo truco que el campo receptivo de LC4: lo que el conectoma no dice
directamente, lo dice su cableado.

**La geometría es una aproximación, y hay que saber cuál.** Las coordenadas
`(hex1, hex2)` se tratan como una grilla **cuadrada** a `GRADOS` por paso. Se
midió con las somas de Mi1 (la columna de la médula, casi completa): los dos
pasos diagonales quedan a la misma distancia (~2.000 vóxeles), que es lo que da
una grilla cuadrada y no una hexagonal, donde uno sería vecino y el otro no. Las
somas están desplazadas de sus columnas, así que la medición es ruidosa; la
topología —quién es vecino de quién— es lo sólido, y es lo que importa para
detectar algo que se expande.

**Lo que todavía no está: hacia dónde mira el ojo en el mundo.** Acá cada ojo es
un parche de grilla centrado en su propio medio. Para el experimento de si ve
(un disco que crece sobre la retina) alcanza; para el juego va a hacer falta
orientarlo — qué columna mira al frente y cuál arriba.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

import red as R

# Ángulo entre omatidios vecinos en Drosophila: 4,5-5°.
GRADOS = 5.0
LAMINA = ("L1", "L2", "L3")


@dataclass
class Retina:
    """Un fotorreceptor por fila: índice en la red, ojo y hacia dónde mira."""

    indice: np.ndarray  # (m,) índice de neurona en la red
    ojo: np.ndarray     # (m,) "L" o "R"
    x: np.ndarray       # (m,) grados, horizontal dentro del ojo
    y: np.ndarray       # (m,) grados, vertical dentro del ojo

    def del_ojo(self, lado: str) -> np.ndarray:
        return np.flatnonzero(self.ojo == lado)


def _columnas(red: R.Red) -> pd.DataFrame:
    """Columna y lado de cada neurona de la red, alineados con su orden."""
    ann = pd.read_feather(R.DATOS / "anotaciones.feather")
    ann = ann[ann["type"].notna()].reset_index(drop=True)
    assert (ann["type"].to_numpy().astype(str) == red.tipo).all(), \
        "las anotaciones no están en el orden de la red: borrá data/red.npz"
    return pd.DataFrame({
        "hex1": ann["assignedOlHex1"].astype(float),
        "hex2": ann["assignedOlHex2"].astype(float),
        # La mayoría de las neuronas del lóbulo óptico no tiene soma en el
        # volumen; el lado sale de dónde está su raíz.
        "lado": ann["somaSide"].fillna(ann["rootSide"]).astype(str),
    })


def retina(red: R.Red) -> Retina:
    col = _columnas(red)
    fotorreceptores = red.indices("R1-R6")
    es_lamina = np.isin(red.tipo, LAMINA) & col["hex1"].notna().to_numpy()

    indice, ojo, hx, hy = [], [], [], []
    for i in fotorreceptores:
        w = red.W[:, i]  # a quién le habla
        destinos, pesos = w.indices, np.abs(w.data)
        ok = es_lamina[destinos]
        if not ok.any():
            continue  # le habla a una columna sin coordenada: no sabemos dónde mira
        j = destinos[ok][np.argmax(pesos[ok])]
        indice.append(i)
        ojo.append(col.at[j, "lado"])
        hx.append(col.at[j, "hex1"])
        hy.append(col.at[j, "hex2"])

    indice, ojo = np.array(indice), np.array(ojo)
    hx, hy = np.array(hx), np.array(hy)
    x, y = np.zeros(len(indice)), np.zeros(len(indice))
    for lado in ("L", "R"):
        m = ojo == lado
        # Centrado en el medio de las columnas de ese ojo, a GRADOS por paso.
        x[m] = (hx[m] - np.median(hx[m])) * GRADOS
        y[m] = (hy[m] - np.median(hy[m])) * GRADOS
    return Retina(indice, ojo, x, y)


# Los tipos que simula `flyvis` y que existen con el mismo nombre en MaleCNS.
# Los fotorreceptores quedan afuera: los simula `flyvis` y en MaleCNS se llaman
# distinto ("R1-R6"); tampoco hacen falta, porque nadie los lee desde acá.
TIPOS_FLYVIS = (
    "L1 L2 L3 L4 L5 Lawf1 Lawf2 C2 C3 Mi1 Mi2 Mi4 Mi9 Mi10 Mi13 Mi14 Mi15 "
    "T1 T2 T2a T3 T4a T4b T4c T4d T5a T5b T5c T5d Tm1 Tm2 Tm3 Tm4 Tm5Y Tm5a "
    "Tm5b Tm5c Tm9 Tm16 Tm20 Tm30 TmY3 TmY4 TmY5a TmY10 TmY13 TmY14 TmY15 TmY18"
).split()


def columnas_derivadas(red: R.Red, lado: str = "R", rondas: int = 4, minimo: float = 20.0):
    """Columna `(hex1, hex2)` de cada neurona de un ojo, directa o derivada.

    Directa si el conectoma la anota. Si no, el promedio de las columnas de sus
    vecinos sinápticos —entradas y salidas— que ya la tienen, pesado por
    sinapsis, en rondas: lo que se asigna en una ronda sirve de evidencia a la
    siguiente. Solo se asigna con al menos `minimo` sinapsis de evidencia.

    Devuelve `(n, 2)` float con NaN donde no se pudo, y la ronda en que se
    asignó cada una (0 = anotada).
    """
    col = _columnas(red)
    del_lado = (col["lado"].to_numpy() == lado)
    H = np.array(col[["hex1", "hex2"]], dtype=float)  # copia: pandas 3 la da de solo lectura
    H[~del_lado] = np.nan
    ronda = np.where(np.isnan(H[:, 0]), -1, 0)

    A = abs(red.W).tocsr()           # (post, pre)
    S = (A + A.T).tocsr()            # vecinos en las dos direcciones
    for k in range(1, rondas + 1):
        conocida = ~np.isnan(H[:, 0])
        Hk = np.where(conocida[:, None], H, 0.0)
        peso = S @ conocida.astype(float)
        suma = S @ Hk
        nueva = (~conocida) & del_lado & (peso >= minimo)
        H[nueva] = suma[nueva] / peso[nueva, None]
        ronda[nueva] = k
        if not nueva.any():
            break
    return H, ronda


if __name__ == "__main__":
    r = R.construir()
    ret = retina(r)
    total = r.indices("R1-R6").size
    print(f"fotorreceptores R1-R6: {total:,} · con columna: {len(ret.indice):,}")
    for lado in ("L", "R"):
        m = ret.del_ojo(lado)
        cols = len(set(zip(ret.x[m], ret.y[m])))
        print(f"  ojo {lado}: {m.size:5} fotorreceptores en {cols:4} columnas · "
              f"campo {np.ptp(ret.x[m]):.0f}° x {np.ptp(ret.y[m]):.0f}°")

    H, ronda = columnas_derivadas(r)
    print("\ncolumnas del ojo derecho, tipos que simula flyvis:")
    print(f"  {'tipo':7} {'neuronas':>8} {'anotada':>8} {'derivada':>9} {'sin':>5}")
    lado = _columnas(r)["lado"].to_numpy()
    for t in TIPOS_FLYVIS:
        m = (r.tipo == t) & (lado == "R")
        if m.sum():
            print(f"  {t:7} {m.sum():8} {(ronda[m] == 0).sum():8} {(ronda[m] > 0).sum():9} {(ronda[m] < 0).sum():5}")
