"""El cordón ventral como modelo de tasas, el de Pugliese et al. (2025).

En `patas.py` el LIF del cordón ventral no dejó pasar a DNa02, y subirle la
ganancia lo hacía convulsionar. Pugliese et al. simularon este mismo cordón
(entre otros, en MaleCNS) y la marcha apareció: estimular DNg100 hace oscilar a
las motoneuronas de las seis patas, desde un circuito de tres neuronas. Lo
hicieron con **tasas en vez de espigas**, porque muchas premotoras del cordón
ventral no disparan: son de voltaje graduado, lo mismo que se sospechaba acá.

    τ dr/dt = max(r_max · tanh(a/r_max · (I + Σ w r − θ)), 0) − r

Parámetros por neurona **sorteados, no ajustados**: los de su
`configs/neuron_params/default.yaml`, con ganancia y umbral escalados por el
volumen de cada neurona. Los pesos son sinapsis con signo × 0,03.

**Lo que da** (resultados en `fly/README.md`): DNg100 hace oscilar a las patas a
8-11 Hz, la frecuencia de paso de la mosca, pero una de cada cinco descendentes
también (en el paper, una de cada treinta). Y DNa02 sí llega a las patas, cosa
que en el LIF nunca pasó: t = 22 en 12 de 12 semillas.

    python fly/cordon.py          # ~10 min: ¿DNg100 hace oscilar a las patas?
    python fly/cordon.py --giro   # ~8 min: ¿DNa02 y el tacto giran, como en patas.py?
"""

import sys
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks

sys.path.insert(0, str(Path(__file__).resolve().parent))
import patas as P  # noqa: E402
import red as R  # noqa: E402

PESO = 0.03
TAU, A, THETA, RMAX = (20.0, 2.0), (1.0, 0.1), (7.5, 0.6), (200.0, 10.0)
# Corriente en DNg100 que usaron para los conectomas de cuerpo entero (mCNS,
# BANC); para MANC y FANC, 250 y 150.
MARCHA = 400.0
DT = 1.0  # ms


NEURONAS = ("https://storage.googleapis.com/flyem-male-cns/v1.0/database/"
            "neuprint-inputs/Neuprint_Neurons.feather")


def tamanos(red: R.Red) -> np.ndarray:
    """Volumen de cada neurona en vóxeles, en el orden de `red`.

    No está en los archivos planos: sale de la tabla de neuronas de neuPrint
    (4,6 GB, se baja una vez, se leen dos columnas y se borra)."""
    cache = R.DATOS / "tamanos.npy"
    if not cache.exists():
        import pandas as pd
        import pyarrow.feather as pf
        from urllib.request import urlretrieve

        crudo = R.DATOS / "neuronas_tmp.feather"
        if not crudo.exists():
            urlretrieve(NEURONAS, crudo)
        t = pf.read_table(crudo, columns=["bodyId:long", "size:long"], memory_map=True).to_pandas()
        vol = pd.Series(t["size:long"].to_numpy(float), index=t["bodyId:long"].to_numpy())
        ann = pd.read_feather(R.DATOS / "anotaciones.feather")[["bodyId", "type"]]
        ann = ann[ann["type"].notna()]
        np.save(cache, vol.reindex(ann["bodyId"].to_numpy()).to_numpy())
        crudo.unlink()
    return np.load(cache)


def subred(red: R.Red, patas=("fl",)) -> np.ndarray:
    """La subred de Pugliese et al.: las motoneuronas de `patas`, todo lo que les
    habla (sus premotoras), y las descendentes que les hablan a las premotoras.
    Con el cordón entero, cualquier descendente lo prendía al tope.

    ponytail: `red` no trae las neuronas sin tipo asignado, así que para las
    patas delanteras quedan 3.166 neuronas contra sus 4.310 en MaleCNS."""
    sub = R.columna(red, "subclass").astype(str)
    mn = np.flatnonzero((red.superclase == "vnc_motor") & np.isin(sub, patas))
    W = red.W.tocsr()
    pre = np.setdiff1d(W[mn].indices, mn)
    dn = np.flatnonzero(red.superclase == "descending_neuron")
    dn = dn[np.asarray((W[pre][:, dn] != 0).sum(0)).ravel() > 0]
    return np.unique(np.concatenate([mn, pre, dn]))


class Cordon:
    def __init__(self, red: R.Red, idx, semilla=0, ref=None):
        """`ref`: el volumen que vale 1 en el escalado. Por defecto la mediana
        de `idx`, como ellos; con el sistema nervioso entero esa mediana la
        bajan las neuronas diminutas del lóbulo óptico, y hay que fijarla."""
        self.idx = idx
        self.en = np.full(red.n, -1)
        self.en[self.idx] = np.arange(self.idx.size)  # índice de la red → del cordón
        # A las descendentes no les llega nada: su actividad la pone el cerebro.
        # Ellos contaban solo sinapsis dentro del cordón; `red.W` suma también las
        # del cerebro, y descendente↔ascendente cerraba bucles que el cordón no
        # tiene (estimular cualquier descendente prendía 1.100 de 3.166).
        W = red.W[:, self.idx].tocsr()[self.idx] * PESO
        dn = red.superclase[self.idx] == "descending_neuron"
        self.W = W.multiply((~dn)[:, None]).tocsr()
        rng = np.random.default_rng(semilla)
        n = self.idx.size
        sortear = lambda m, s: np.maximum(rng.normal(m, s, n), 1e-3)
        self.tau, self.a, self.theta, self.rmax = (sortear(*x) for x in (TAU, A, THETA, RMAX))
        # Una neurona grande tiene menos resistencia de entrada: menos ganancia y
        # más umbral. Sin esto, dicen ellos, DNg100 no da ritmo; acá tampoco daba.
        s = tamanos(red)[idx]
        s = s / (np.nanmedian(s) if ref is None else ref)
        s[~(s > 0)] = 1.0
        self.a /= s
        self.theta *= s
        self.r = np.zeros(n)

    def paso(self, I, fijas=None, tasas=None):
        """Un paso de DT ms. `I`: corriente por neurona del cordón. `fijas`
        (índices del cordón) quedan en `tasas` Hz: las entradas que dicta algo de
        afuera, como las descendentes que manda el cerebro."""
        x = I + self.W @ self.r - self.theta
        f = np.maximum(self.rmax * np.tanh(self.a / self.rmax * x), 0.0)
        self.r += DT / self.tau * (f - self.r)
        if fijas is not None:
            self.r[fijas] = tasas
        return self.r

    def correr(self, ms, I, leer, fijas=None, tasas=None):
        # `copy`: con un slice, `paso(I)[leer]` es una vista de `self.r` y todas
        # las filas terminaban siendo el último paso.
        return np.array([self.paso(I, fijas, tasas)[leer].copy() for _ in range(int(ms / DT))])


def ritmo(tasa) -> tuple[float, float]:
    """Qué tan periódica es una traza, de 0 a 1, y su frecuencia en Hz: el pico
    más alto de su autocorrelación fuera del cero (altura y prominencia, lo
    menor), relativo al mismo número para un seno puro. Una versión corta del
    `neuron_oscillation_score` de Pugliese et al."""
    def crudo(x):
        rango = x.max() - x.min()
        if rango < 1e-6:
            return 0.0, 0
        x = 2 * (x - x.min()) / rango - 1
        ac = np.correlate(x, x, "full")[len(x) - 1:]
        ac = ac / max(abs(ac).max(), 1e-9)
        picos, prop = find_peaks(ac, prominence=0.05, height=-np.inf)
        if not picos.size:
            return 0.0, 0
        k = np.argmax(prop["prominences"])
        return min(prop["peak_heights"].max(), prop["prominences"].max()), picos[k]

    s, periodo = crudo(tasa)
    if not periodo:
        return 0.0, 0.0
    ref, _ = crudo(np.sin(2 * np.pi * np.arange(len(tasa)) / periodo))
    return float(np.clip(s / max(ref, 1e-6), 0, 1)), 1000.0 / (periodo * DT)


def prueba(red, cor, mn, estimulo, ms=1000.0):
    """Estimular `estimulo` (índices de la red) y medir las motoneuronas `mn`.

    Devuelve el ritmo medio de las activas y su frecuencia mediana, o NaN si la
    corrida es de las que ellos descartaban: menos de 5 neuronas reclutadas o
    más de 1.500."""
    I = np.zeros(cor.idx.size)
    I[cor.en[estimulo]] = MARCHA
    cor.r[:] = 0.0
    todo = cor.correr(ms, I, slice(None))[250:]  # sin el transitorio, como ellos
    reclutadas = int((todo.mean(0) > 0.01).sum()) - np.isin(cor.idx, estimulo).sum()
    if not 5 <= reclutadas <= 1500:
        return np.nan, np.nan
    tasa = todo[:, cor.en[mn]]
    activas = np.flatnonzero(tasa.mean(0) > 0.01)
    if not activas.size:
        return 0.0, np.nan
    r = np.array([ritmo(tasa[:, k]) for k in activas])
    return float(r[:, 0].mean()), float(np.median(r[r[:, 0] > 0, 1])) if (r[:, 0] > 0).any() else np.nan


# A cuánto quedan fijadas las entradas en `giro`: DNg100 a lo que le da la
# corriente de ellos (~20 Hz), y lo que se estimula de un lado a lo mismo.
TASA = 20.0


class Espinal:
    """El cordón de las seis patas manejando el cuerpo: la mosca espinal.

    La marcha puesta (DNg100 a `TASA`) y el tacto entrando por sus sensores, a
    `TASA` por el toque de 0 a 1: los mismos valores de `giro`, fijados antes de
    ver una pelea. Las descendentes del cerebro LIF **no entran**: con ellas el
    cordón pierde el ritmo (ver `fly/README.md`). El cerebro sigue decidiendo la
    esquiva; las patas son del cordón solo.
    """

    def __init__(self, red, tacto, semilla=0):
        """`tacto`: (sensores que reciben el toque izquierdo, los del derecho),
        o None sin tacto; como `piloto.Piloto.tacto`."""
        ti, td = P.tacto(red)
        self.cor = Cordon(red, np.union1d(subred(red, ("fl", "ml", "hl")), np.concatenate([ti, td])), semilla)
        pat = P.Patas(red)
        self.mn, self.n = self.cor.en[np.concatenate([pat.izq, pat.der])], pat.izq.size
        g = red.indices("DNg100")
        self.fijas = self.cor.en[np.concatenate([g, *(tacto or ())])]
        self.tasas = np.zeros(self.fijas.size)
        self.tasas[:g.size] = TASA
        self.i = slice(g.size, g.size + (tacto[0].size if tacto else 0))
        self.d = slice(self.i.stop, None)

    def tocar(self, izq, der):
        self.tasas[self.i] = TASA * izq
        self.tasas[self.d] = TASA * der

    def tick(self, ms):
        """Tasa media de las motoneuronas izquierdas y derechas en `ms`."""
        tr = self.cor.correr(ms, 0.0, self.mn, self.fijas, self.tasas)
        return float(tr[:, :self.n].mean()), float(tr[:, self.n:].mean())

    def activas(self, lif):
        """Para el panel del cerebro: las neuronas del cordón las pone este
        modelo (las que pasan de 5 Hz), no sus espigas en el LIF."""
        return np.union1d(lif[~np.isin(lif, self.cor.idx)], self.cor.idx[self.cor.r > 5.0]).astype(np.uint32)


def giro(red, semillas=12, n_controles=4):
    """El experimento de `patas.py`, sobre este cordón: con la marcha puesta,
    ¿DNa02 y el tacto de un lado mueven las patas como predice el cableado, y un
    par de descendentes cualquiera no? Pareado por semilla (la semilla sortea los
    parámetros de las neuronas). Mismo criterio que allá: t > 2,5 y por encima de
    la media de cualquier control."""
    ti, td = P.tacto(red)
    idx = np.union1d(subred(red, ("fl", "ml", "hl")), np.concatenate([ti, td]))
    pat = P.Patas(red)
    mn = np.concatenate([pat.izq, pat.der])
    dn = red.superclase == "descending_neuron"
    tipos, cuenta = np.unique(red.tipo[dn], return_counts=True)
    pares = [t for t in tipos[cuenta == 2] if t not in ("DNa02", "DNa01", "DNg100")
             and sorted(pat.lado[red.indices(t)]) == ["L", "R"] and np.isin(red.indices(t), idx).all()]
    controles = np.random.default_rng(0).choice(pares, n_controles, replace=False)
    # (nombre, izquierda, derecha, signo que predice el cableado), como en patas.py
    entradas = [("DNa02", *P.por_lado(pat, red.indices("DNa02")), +1), ("tacto", ti, td, -1)]
    entradas += [(t, *P.por_lado(pat, red.indices(t)), 0) for t in controles]
    g = red.indices("DNg100")
    print(f"cordón de las seis patas: {idx.size:,} neuronas · entradas fijas a {TASA:g} Hz\n")

    def asimetria(cor, extra):
        cor.r[:] = 0.0
        tr = cor.correr(600.0, 0.0, cor.en[mn], cor.en[np.concatenate([g, extra])], TASA)[100:]
        return tr[:, pat.izq.size:].mean() - tr[:, :pat.izq.size].mean()

    filas = {n: [] for n, *_ in entradas}
    for s in range(semillas):
        cor = Cordon(red, idx, s)
        for nombre, izq, der, _ in entradas:
            filas[nombre].append(asimetria(cor, izq) - asimetria(cor, der))
        print(f"  semilla {s}: " + "  ".join(f"{n} {filas[n][-1]:+.1f}" for n in filas), flush=True)
    filas = {n: np.array(c) for n, c in filas.items()}
    ruido = max(abs(c.mean()) for n, c in filas.items() if n not in ("DNa02", "tacto"))
    print(f"\n  controles: |media| hasta {ruido:.2f} Hz")
    for nombre, *_, signo in entradas[:2]:
        c = filas[nombre] * signo
        t = c.mean() / (c.std(ddof=1) / np.sqrt(semillas))
        # Negativo y firme no es "no llega": es que llega al revés de lo que
        # suponía patas.py (más actividad de un lado = ese lado empuja más).
        veredicto = ("PASA" if t > 2.5 and c.mean() > ruido else
                     "LLEGA, CON EL SIGNO CONTRARIO" if t < -2.5 and -c.mean() > ruido else
                     "A MEDIAS" if c.mean() > ruido else "NO")
        print(f"  {nombre}: {c.mean():+.2f} Hz con el signo del cableado, t = {t:.1f} · {veredicto}")


def _tamiz(args):
    semilla, tipos = args
    red = R.construir()
    idx = subred(red)
    mn = idx[(red.superclase[idx] == "vnc_motor") & (R.columna(red, "subclass").astype(str)[idx] == "fl")]
    cor = Cordon(red, idx, semilla)
    return [prueba(red, cor, mn, red.indices(t))[0] for t in tipos]


def main():
    """El experimento de ellos: estimular cada tipo de descendente de la subred y
    ver cuál hace oscilar a las patas. DNg100 tiene que salir arriba."""
    from multiprocessing import Pool

    red = R.construir()
    idx = subred(red)
    dn = idx[red.superclase[idx] == "descending_neuron"]
    tipos = np.unique(red.tipo[dn])
    print(f"subred de las patas delanteras: {idx.size:,} neuronas · {tipos.size} tipos de descendente\n")
    semillas = (0, 1)
    with Pool(3) as pool:
        filas = pool.map(_tamiz, [(s, tipos[k::3]) for s in semillas for k in range(3)])
    score = np.full((len(semillas), tipos.size), np.nan)
    for j, (s, k) in enumerate((s, k) for s in semillas for k in range(3)):
        score[s, k::3] = filas[j]
    ok = ~np.isnan(score).all(0)
    media = np.where(ok, np.nansum(score, 0) / np.maximum((~np.isnan(score)).sum(0), 1), np.nan)
    orden = np.argsort(-np.where(ok, media, -1))
    g = list(tipos).index("DNg100")
    print(f"{ok.sum()} de {tipos.size} tipos con alguna corrida estable · "
          f"ritmo medio 0: {(media[ok] == 0).mean():.0%} · > 0,5: {(media[ok] > 0.5).mean():.1%}")
    print(f"DNg100: ritmo {media[g]:.2f} · puesto {int(np.flatnonzero(orden == g)[0]) + 1} de {ok.sum()}")
    print("los diez más rítmicos:", ", ".join(f"{tipos[j]} {media[j]:.2f}" for j in orden[:10]))
    mn = idx[(red.superclase[idx] == "vnc_motor") & (R.columna(red, "subclass").astype(str)[idx] == "fl")]
    r = np.array([prueba(red, Cordon(red, idx, s), mn, red.indices("DNg100")) for s in range(6)])
    print(f"DNg100 en 6 réplicas: ritmo {np.round(r[:, 0], 2)} · frecuencia {np.round(r[:, 1], 1)} Hz"
          " (la marcha de la mosca: 7-15 Hz)")


if __name__ == "__main__":
    if "--giro" in sys.argv:
        giro(R.construir())
    else:
        main()
