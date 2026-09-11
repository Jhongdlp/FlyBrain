"""Las patas: la mosca camina leyendo sus propias motoneuronas.

MaleCNS no es solo el cerebro: es el sistema nervioso entero, con el cordón
ventral, que en la mosca hace lo que la médula espinal. Ahí están las 381
motoneuronas de las seis patas, cada una anotada con su pata (delantera, media,
trasera) y su lado. **La lectura es de ellas, no de las descendentes**: la orden
baja del cerebro, el cordón ventral la reparte entre las patas, y lo que mueve al
boss es lo que llega a los músculos.

    DNg100 (BDN2) → cordón ventral → motoneuronas de las seis patas → avance y giro

**En este experimento la marcha la encendemos nosotros**, igual que en el
laboratorio se enciende con optogenética: corriente tónica en DNg100, la
descendente de caminar hacia adelante (BDN2, Sapkal et al. 2024). Se eligió
porque de las candidatas es la que más llega directo a las seis patas (250-420
sinapsis por pata y lado a un salto; P9 y MDN, 10 y 12 en total). En el juego no
hace falta: ahí las patas las despierta lo que la mosca ve (`piloto.andar`).

**El giro está en el cableado**, por dos vías:

- DNa02 —la descendente cuya asimetría predice el giro en la mosca
  (Rayshubskiy et al. 2020)— habla solo con las patas de su lado, y a dos saltos
  inhibe las de su lado y excita las del otro. Es como gira un insecto: las
  patas de adentro frenan y las de afuera empujan.
- El tacto de las patas de un lado excita las motoneuronas de ese lado: directo
  a su pata (640-940 sinapsis) y a dos saltos ~10 veces más a su lado que al
  otro. Pared a la izquierda → las izquierdas empujan → se aparta.

Este archivo comprueba si eso sobrevive a la simulación: la entrada por un lado
contra la entrada por el otro, pareado por semilla, y el mismo contraste con
pares bilaterales de descendentes al azar como control.

    python fly/patas.py            # ~30 min en CPU
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import red as R  # noqa: E402

MARCHA = "DNg100"
# Lleva a DNg100 a ~9 Hz: la inhibición que recibe se come la mayor parte. Con
# 2.5 en la escala del sobresalto las patas quedan en 3-5 Hz; a escala 0.01 no
# llega nada al cordón ventral, que está a más saltos que la fibra gigante.
CORRIENTE = 2.5
# Los sensores táctiles son ~900 por lado: con 2.5 serían una descarga. 1.5 los
# lleva a ~25 Hz.
TACTO = 1.5

# 100 ms para que la marcha se asiente, 500 de medida. Con 100 ms de medida el
# ruido entre semillas (±2-4 Hz) era del tamaño del efecto.
ASIENTA, MIDE = 100.0, 500.0
SEMILLAS = 12
N_CONTROLES = 4


class Patas:
    """Qué motoneuronas mueven cada lado."""

    def __init__(self, red: R.Red):
        lado = R.columna(red, "somaSide").astype(str)
        pata = np.isin(R.columna(red, "subclass").astype(str), ["fl", "ml", "hl"])
        mn = pata & (red.superclase == "vnc_motor")
        # El soma de una motoneurona de pata está del lado de la pata que mueve.
        self.izq = np.flatnonzero(mn & (lado == "L"))
        self.der = np.flatnonzero(mn & (lado == "R"))
        self.lado = lado

    def leer(self, disparos: np.ndarray) -> tuple[int, int]:
        """Disparos de las patas izquierdas y derechas en `(pasos, n)`."""
        return int(disparos[:, self.izq].sum()), int(disparos[:, self.der].sum())


def asimetria(red, p, pat, extra, corriente, semilla) -> float:
    """Hz de las patas derechas menos las izquierdas, con la marcha encendida."""
    sim = R.Simulador(red, p, semilla)
    ext = np.zeros(red.n, np.float32)
    ext[red.indices(MARCHA)] = CORRIENTE
    ext[extra] = corriente
    sim.avanzar(ASIENTA, ext)
    d = sim.avanzar(MIDE, ext)
    return R.hz(d, pat.der, p) - R.hz(d, pat.izq, p)


def contraste(red, p, pat, izq, der, corriente, semilla) -> float:
    """Estimular `izq` menos estimular `der`: cuánto más empujan las patas
    derechas cuando la entrada va por la izquierda."""
    return (asimetria(red, p, pat, izq, corriente, semilla)
            - asimetria(red, p, pat, der, corriente, semilla))


def por_lado(pat, idx):
    return idx[pat.lado[idx] == "L"], idx[pat.lado[idx] == "R"]


def tacto(red):
    """Los sensores táctiles de las patas, por lado. No tienen soma en el sistema
    nervioso, así que el lado sale de por dónde entra la raíz."""
    clase = R.columna(red, "class").astype(str)
    nervio = R.columna(red, "entryNerve").astype(str)
    raiz = R.columna(red, "rootSide").astype(str)
    t = ((red.superclase == "vnc_sensory") & (clase == "mechanosensory_tactile")
         & np.isin(nervio, ["ProLN", "MesoLN", "MetaLN"]))
    return np.flatnonzero(t & (raiz == "L")), np.flatnonzero(t & (raiz == "R"))


def main():
    red = R.construir()
    p = R.Parametros()
    pat = Patas(red)
    print(f"patas: {pat.izq.size} motoneuronas izquierdas, {pat.der.size} derechas · "
          f"marcha {MARCHA} a {CORRIENTE:g}\n")

    # Control: descendentes bilaterales de a una neurona por lado, como DNa02.
    # Si cualquier descendente de un lado moviera las patas igual, el giro no
    # sería de DNa02 sino de "meterle corriente a un lado".
    dn = red.superclase == "descending_neuron"
    tipos, cuenta = np.unique(red.tipo[dn], return_counts=True)
    pares = [t for t in tipos[cuenta == 2] if t not in ("DNa02", "DNa01", MARCHA)
             and sorted(pat.lado[red.indices(t)]) == ["L", "R"]]
    controles = np.random.default_rng(0).choice(pares, N_CONTROLES, replace=False)

    # (nombre, izquierda, derecha, corriente, signo que predice el cableado).
    # DNa02 frena su lado: las patas derechas empujan más → positivo. El tacto
    # excita su lado: las izquierdas empujan más → negativo, y la mosca se aparta.
    entradas = [("DNa02", *por_lado(pat, red.indices("DNa02")), CORRIENTE, +1),
                ("tacto", *tacto(red), TACTO, -1)]
    entradas += [(t, *por_lado(pat, red.indices(t)), CORRIENTE, 0) for t in controles]

    print(f"{'':10}" + " ".join(f"s{s:<5}" for s in range(SEMILLAS)) + "   media")
    filas = {}
    for nombre, izq, der, corriente, signo in entradas:
        c = np.array([contraste(red, p, pat, izq, der, corriente, s) for s in range(SEMILLAS)])
        filas[nombre] = (c * signo if signo else c)
        print(f"{nombre:10}" + " ".join(f"{x:+5.1f} " for x in c) + f"  {c.mean():+5.2f}", flush=True)

    ruido = max(abs(c.mean()) for n, c in filas.items() if n not in ("DNa02", "tacto"))
    print(f"\n  controles: |media| hasta {ruido:.2f} Hz")
    for nombre in ("DNa02", "tacto"):
        c = filas[nombre]  # ya con el signo del cableado: positivo = acierta
        # t de una muestra contra cero. La primera versión pedía "5 de 6 semillas
        # con el signo" y dio PASA con t = 1.3: una semilla en +0.0 contaba.
        t = c.mean() / (c.std(ddof=1) / np.sqrt(SEMILLAS))
        if t > 2.5 and c.mean() > ruido:
            veredicto = "PASA: gira como predice el cableado, y una descendente cualquiera no"
        elif c.mean() > ruido:
            veredicto = "A MEDIAS: el signo del cableado, pero no se separa del ruido"
        else:
            veredicto = "NO: no se distingue de los controles"
        print(f"  {nombre}: {c.mean():+.2f} Hz con el signo del cableado, t = {t:.1f} · {veredicto}")


if __name__ == "__main__":
    main()
