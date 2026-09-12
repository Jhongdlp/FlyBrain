"""Aprender por castigo: la dopamina en el cuerpo pedunculado.

En la mosca, lo que aprende es el cuerpo pedunculado. Cada imagen u olor prende
un grupo chico de células de Kenyon (KC); las KC le hablan a las neuronas de
salida (MBON); y cuando algo sale mal, las dopaminérgicas PPL1 debilitan las
sinapsis KC→MBON que estaban activas justo antes. La próxima vez esa imagen
empuja menos a esas MBON. Castigo también es dopamina: las PAM señalan
recompensa y las PPL1 castigo.

El conectoma trae el circuito completo (4.064 KC, 97 MBON, 16 PPL1), pero
nuestro LIF no lo trae en su régimen:

- **Las KC no eran esparsas.** Con los parámetros de toda la red disparaban el
  49% a 12 Hz sin estímulo ninguno; en la mosca, una imagen prende el 5-10% y en
  reposo están casi mudas. Así la dopamina castigaría todo por igual. Las KC de
  verdad tienen umbral alto (y APL, que acá son dos neuronas y no alcanzan), así
  que llevan un sesgo negativo: `SESGO_KC`, medido abajo. Sacar las sinapsis
  KC→KC —axo-axónicas, en los lóbulos— no alcanzaba: 49% → 46%.
- **La dopamina no hace nada en `red.py`**: los moduladores tienen signo 0. Acá
  no es corriente sino plasticidad, y sus sinapsis se leen del conectoma crudo.

    python fly/dopamina.py         # los chequeos, en orden
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import red as R  # noqa: E402

# Corriente fija en las KC. Barrido sin estímulo, 500 ms:
#   sesgo   0 → 48,7% activas, 12,0 Hz      -3 → 5,2%, 0,82 Hz
#        -1 → 27,3%, 5,5 Hz                 -4 → 2,1%, 0,29 Hz
#        -2 → 12,9%, 2,2 Hz
# -3 es el régimen de la mosca: casi mudas en reposo, y el resto de la red casi
# no se entera (1,8 → 1,5 Hz de media).
SESGO_KC = -3.0


def kc(red) -> np.ndarray:
    return np.flatnonzero(np.char.startswith(red.tipo.astype(str), "KC"))


def de_tipo(red, prefijo) -> np.ndarray:
    return np.flatnonzero(np.char.startswith(red.tipo.astype(str), prefijo))


def compartimentos(red, dan="PPL1") -> np.ndarray:
    """Cuánto le llega de cada dopaminérgica `dan` (PPL1 castigo, PAM
    recompensa) a cada MBON: `(n_mbon, n_dan)`, filas que suman 1 (o 0 si no le
    llega ninguna).

    Sale de las sinapsis DAN→MBON del conectoma crudo: en `red.W` valen 0,
    porque la dopamina no es corriente. Una DAN hace sinapsis en las dendritas
    de las MBON de su compartimento, así que es un buen indicador de qué MBON
    modula. Se lee el archivo en tandas —son 500 MB— y se cachea.
    """
    cache = R.DATOS / ("dopamina.npz" if dan == "PPL1" else f"dopamina_{dan}.npz")
    ppl1, mbon = de_tipo(red, dan), de_tipo(red, "MBON")
    if not cache.exists():
        import pandas as pd
        import pyarrow.compute as pc
        import pyarrow.ipc as ipc

        ann = pd.read_feather(R.DATOS / "anotaciones.feather")[["bodyId", "type"]]
        cuerpo = ann[ann["type"].notna()]["bodyId"].to_numpy()
        pos = {b: i for i, b in enumerate(cuerpo)}
        f = ipc.open_file(R.DATOS / "conectoma.feather")
        filas = []
        for k in range(f.num_record_batches):
            b = f.get_batch(k)
            m = pc.and_(pc.starts_with(b["type_pre"], dan), pc.starts_with(b["type_post"], "MBON"))
            filas.append(b.filter(m).select(["body_pre", "body_post", "weight"]).to_pandas())
        e = pd.concat(filas)
        e = e[e["body_pre"].isin(pos) & e["body_post"].isin(pos)]
        np.savez(cache, pre=e["body_pre"].map(pos).to_numpy(),
                 post=e["body_post"].map(pos).to_numpy(), w=e["weight"].to_numpy())
    z = np.load(cache)
    C = np.zeros((mbon.size, ppl1.size))
    fila = {i: k for k, i in enumerate(mbon)}
    col = {i: k for k, i in enumerate(ppl1)}
    for a, b, w in zip(z["pre"], z["post"], z["w"]):
        if w >= R.UMBRAL:
            C[fila[b], col[a]] += w
    return C / np.maximum(C.sum(1, keepdims=True), 1e-9)


# La regla. Una KC queda "elegible" cuando dispara y lo sigue siendo TRAZA_MS
# después: así el castigo, que llega al tocar la pared, alcanza a lo que la mosca
# vio mientras se acercaba. En la mosca la ventana KC→dopamina es de segundos.
TRAZA_MS = 1000.0
# Cuánto deprime un tick de castigo pleno a una sinapsis elegible.
ETA = 0.05
# Una sinapsis no baja de esta fracción de su peso original.
PISO = 0.1
# Corriente en las PPL1 cuando la mosca toca una pared: el dolor.
DOLOR = 3.0
# Disparos por tick de una PPL1 sobre su promedio que todavía son ruido. Sin
# esto, sus fluctuaciones solas deprimían todo de a poco.
MARGEN = 2.0


class Plasticidad:
    """KC→MBON se debilita donde coinciden una KC elegible y dopamina de las DAN
    que llegan a esa MBON. Solo deprime, sea castigo (PPL1) o recompensa (PAM):
    en la mosca las dos deprimen, y lo que cambia es en qué compartimento. Sin la
    vuelta atrás.

    Cambia `red.W` en su lugar: la mosca que aprende tiene que tener su propia
    copia del conectoma (`aprendiz`), o les contagiaría lo aprendido a las demás.

    ponytail: la dopamina se mide como disparos de cada DAN por encima de su
    propio promedio (disparan solas en este LIF); el día que estén calladas en
    reposo, sobra la resta.
    """

    def __init__(self, red, tick_ms=1000.0 / 60.0, dans=("PPL1",)):
        self.red = red
        self.kc, self.mbon = kc(red), de_tipo(red, "MBON")
        # Todas las DAN juntas: una columna de C por neurona, de cualquier grupo.
        self.dan = np.concatenate([de_tipo(red, d) for d in dans])
        self.C = np.hstack([compartimentos(red, d) for d in dans])
        W = red.W  # CSC (post, pre): la columna j son las sinapsis que salen de j
        pre = np.repeat(np.arange(W.shape[1]), np.diff(W.indptr))
        es_kc = np.zeros(red.n, bool); es_kc[self.kc] = True
        es_mbon = np.zeros(red.n, int) - 1; es_mbon[self.mbon] = np.arange(self.mbon.size)
        self.pos = np.flatnonzero(es_kc[pre] & (es_mbon[W.indices] >= 0))
        self.de_kc = np.searchsorted(self.kc, pre[self.pos])
        self.a_mbon = es_mbon[W.indices[self.pos]]
        self.w0 = W.data[self.pos].copy()
        self.traza = np.zeros(self.kc.size)
        self.decae = np.exp(-tick_ms / TRAZA_MS)
        self.base = np.zeros(self.dan.size)

    def tick(self, d):
        """`d`: disparos del tick, `(pasos, n)`."""
        self.traza = np.maximum(self.traza * self.decae, d[:, self.kc].any(0))
        dan = d[:, self.dan].sum(0).astype(float)
        da = np.maximum(dan - self.base - MARGEN, 0.0)
        self.base += (dan - self.base) / 120  # 2 s
        llega = self.C @ da  # dopamina en cada MBON
        cambio = ETA * self.traza[self.de_kc] * llega[self.a_mbon]
        if cambio.any():
            W = self.red.W.data
            W[self.pos] = np.maximum(W[self.pos] * np.exp(-cambio), PISO * self.w0)

    def cuanto(self) -> float:
        """Peso KC→MBON medio, relativo al original."""
        return float((self.red.W.data[self.pos] / self.w0).mean())


def aprendiz(red):
    """Una copia de la red con su propio conectoma, para que aprenda sola."""
    import dataclasses

    return dataclasses.replace(red, W=red.W.copy())


class Escena:
    """Un entorno de mentira para mirar sin pelear: la mosca en `pos` mirando
    `rumbo`, nadie más en la arena. Tiene lo único que `ojo_juego.Mosca` le pide
    al motor."""

    def __init__(self, pos, rumbo):
        self.pos, self.rumbo = np.array(pos, float), rumbo

    def escena(self, _):
        # El jugador lejos y fuera de la vista: detrás de la mosca.
        atras = self.pos - 40 * np.array([np.cos(self.rumbo), np.sin(self.rumbo)])
        return (*self.pos, self.rumbo, 0.9), np.array([[*atras, 0.4]], np.float32)


PARED = dict(pos=(6.0, 1.6), rumbo=0.0)      # pared (y=0) a la izquierda, a 1,6
ABIERTA = dict(pos=(10.0, 10.0), rumbo=0.0)  # el centro de la arena


def mosca(red, **kw):
    import ojo_juego as J  # carga flyvis: solo si hace falta

    return J.Mosca(red, tacto=0, umbral=np.inf, **kw)


def paseo(m, pos, rumbo, leer, ticks=60, dolor_desde=None):
    """La mosca `m` camina recto desde `pos` a paso de marcha (~6 u/s). Devuelve
    los disparos de `leer` sumados, sin los primeros 10 ticks. Con
    `dolor_desde`, desde ese tick le duele, como si tocara la pared."""
    esc = Escena(pos, rumbo)
    avance = 0.1 * np.array([np.cos(rumbo), np.sin(rumbo)])
    cuenta = np.zeros(leer.size)
    for t in range(ticks):
        duele = dolor_desde is not None and t >= dolor_desde
        m.politica(esc, None, None, dolor=1.0 if duele else 0.0)
        esc.pos += avance
        if t >= 10:
            cuenta += m.d[:, leer].sum(0)
    return cuenta


def distingue(red):
    """¿La pared cerca prende otras KC que la arena abierta? Si no, no hay nada
    que el castigo pueda asociar con la pared.

    Cada condición dos veces con otra semilla: el parecido de una condición
    consigo misma es el techo, y contra eso se compara el parecido entre las dos.
    """
    idx = kc(red)
    c = {(n, s): paseo(mosca(red, semilla=s), leer=idx, **kw)
         for n, kw in (("pared", PARED), ("abierta", ABIERTA)) for s in (0, 1)}

    def parecido(a, b):  # coseno entre patrones de KC
        return float(a @ b / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-9))

    mismo = np.mean([parecido(c[("pared", 0)], c[("pared", 1)]),
                     parecido(c[("abierta", 0)], c[("abierta", 1)])])
    cruzado = np.mean([parecido(c[("pared", s)], c[("abierta", r)]) for s in (0, 1) for r in (0, 1)])
    activas = {n: np.mean([(c[(n, s)] > 0).mean() for s in (0, 1)]) for n in ("pared", "abierta")}
    print(f"KC activas: pared {activas['pared']:.1%} · abierta {activas['abierta']:.1%}")
    print(f"parecido del patrón de KC: misma condición {mismo:.2f} · pared contra abierta {cruzado:.2f}")
    return mismo, cruzado


def asocia(red, veces=6):
    """Sin juego: la pared con dolor, varias veces. ¿Baja la respuesta de las
    MBON a la pared más que a la arena abierta, que nunca dolió?

    Se miden las MBON a las que les llega alguna PPL1: son las únicas que el
    castigo puede cambiar.
    """
    m = mosca(aprendiz(red), aprender=True)
    mb = de_tipo(red, "MBON")[compartimentos(red).sum(1) > 0]

    def respuesta():
        return {n: paseo(m, leer=mb, ticks=40, **kw).sum() for n, kw in (("pared", PARED), ("abierta", ABIERTA))}

    antes = respuesta()
    for _ in range(veces):
        paseo(m, leer=mb, ticks=50, dolor_desde=30, **PARED)
        paseo(m, leer=mb, ticks=30, **ABIERTA)
    despues = respuesta()
    r = {n: despues[n] / max(antes[n], 1) for n in antes}
    print(f"MBON con PPL1, disparos antes → después: pared {antes['pared']:.0f} → {despues['pared']:.0f} "
          f"({r['pared']:.2f}) · abierta {antes['abierta']:.0f} → {despues['abierta']:.0f} ({r['abierta']:.2f})")
    print(f"peso KC→MBON medio: {m.plasticidad.cuanto():.2f} del original")
    return r


if __name__ == "__main__":
    red = R.construir()
    if "--asocia" in sys.argv:
        asocia(red)
    else:
        distingue(red)
