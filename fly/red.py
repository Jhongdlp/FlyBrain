"""La red: el conectoma como matriz dispersa, y un LIF que la hace correr.

Sin nada del juego acá. Esto es la mosca sola, y tiene que poder validarse sola
— ver `sobresalto.py`, que es el test con respuesta conocida.

**Lo que el conectoma da y lo que no.** Da quién conecta con quién y cuántas
sinapsis. No da el signo (viene de la predicción de neurotransmisor, aparte), ni
el peso en unidades físicas, ni las constantes de tiempo. Esos tres son
elecciones nuestras, y por eso `escala` se barre en vez de fijarse: el régimen
donde una red así hace algo interesante es una franja estrecha entre apagarse y
convulsionar, y encontrarla es el trabajo.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import scipy.sparse as sp

DATOS = Path(__file__).resolve().parent.parent / "data"

# Acetilcolina excita; glutamato, GABA e histamina inhiben. Dopamina,
# octopamina y serotonina son moduladores: no dan un signo utilizable en un LIF
# simple, así que sus salidas van a cero. Son 3.070 de 164.506 neuronas.
SIGNOS = {"acetylcholine": 1.0, "glutamate": -1.0, "gaba": -1.0, "histamine": -1.0}

# Por debajo de 5 sinapsis una conexión es ruido de reconstrucción. El umbral se
# lleva el 76% de las aristas y deja el 72% de la masa sináptica.
UMBRAL = 5


@dataclass
class Red:
    W: sp.csc_matrix  # (post, pre), ya con signo
    tipo: np.ndarray
    superclase: np.ndarray

    @property
    def n(self) -> int:
        return self.W.shape[0]

    def indices(self, *tipos: str) -> np.ndarray:
        """Índices de las neuronas de esos tipos celulares."""
        return np.flatnonzero(np.isin(self.tipo, tipos))


def construir() -> Red:
    """Arma la matriz desde los .feather y la cachea. La segunda vez, carga."""
    cache = DATOS / "red.npz"
    if cache.exists():
        z = np.load(cache, allow_pickle=False)
        W = sp.csr_matrix((z["data"], z["indices"], z["indptr"]), shape=tuple(z["shape"]))
        return Red(W.tocsc(), z["tipo"], z["superclase"])

    import pandas as pd

    ann = pd.read_feather(DATOS / "anotaciones.feather")[["bodyId", "type", "superclass"]]
    nt = pd.read_feather(DATOS / "neurotransmisores.feather")[["body", "consensus_nt"]]
    ann = (ann[ann["type"].notna()]
           .merge(nt, left_on="bodyId", right_on="body", how="left")
           .reset_index(drop=True))
    signo = ann["consensus_nt"].map(SIGNOS).fillna(0.0).to_numpy(np.float32)

    w = pd.read_feather(DATOS / "conectoma.feather", columns=["body_pre", "body_post", "weight"])
    w = w[w["weight"] >= UMBRAL]
    pos = pd.Series(np.arange(len(ann), dtype=np.int32), index=ann["bodyId"].values)
    pre = pos.reindex(w["body_pre"].values).to_numpy()
    post = pos.reindex(w["body_post"].values).to_numpy()
    # Aristas hacia o desde cuerpos sin tipo asignado: fuera.
    ok = ~(np.isnan(pre) | np.isnan(post))
    pre, post = pre[ok].astype(np.int32), post[ok].astype(np.int32)
    val = w["weight"].to_numpy(np.float32)[ok] * signo[pre]

    n = len(ann)
    W = sp.csr_matrix((val, (post, pre)), shape=(n, n), dtype=np.float32)
    W.sort_indices()
    np.savez_compressed(cache, data=W.data, indices=W.indices, indptr=W.indptr,
                        shape=np.array(W.shape),
                        tipo=ann["type"].to_numpy().astype(str),
                        superclase=ann["superclass"].to_numpy().astype(str))
    return Red(W.tocsc(), ann["type"].to_numpy().astype(str),
               ann["superclass"].to_numpy().astype(str))


@dataclass
class Parametros:
    """Todo en milisegundos y en unidades de umbral (V_reposo = 0, V_umbral = 1)."""
    dt: float = 0.5
    tau_m: float = 20.0     # membrana
    tau_s: float = 5.0      # corriente sináptica
    refractario: float = 2.0
    # Los dos valores medidos, no elegidos: ver el barrido en fly/README.md.
    # `escala` es el centro de la meseta que pasa el experimento del sobresalto;
    # `ruido` es el nivel más alto al que la red sigue **muda sin sinapsis**, así
    # que toda la actividad que aparece es recurrente y no ruido colado.
    escala: float = 0.03
    ruido: float = 2.0


class Simulador:
    """La red corriendo, con estado que persiste entre llamadas.

    Es una clase y no una función porque el juego la consulta tick a tick: el
    potencial de membrana y la corriente sináptica tienen que sobrevivir de un
    tick al siguiente, o cada tick empezaría con una red recién nacida y no
    habría dinámica ninguna.

    La propagación es por eventos: solo se leen las columnas de las neuronas que
    dispararon. Con ~1% de actividad son 0,7 ms por paso contra 7,9 del producto
    completo — la diferencia entre correr esto en una laptop y tener que
    alquilar una GPU.
    """

    def __init__(self, red: Red, p: Parametros, semilla: int = 0):
        self.red, self.p = red, p
        self.rng = np.random.default_rng(semilla)
        self.V = np.zeros(red.n, np.float32)
        self.I = np.zeros(red.n, np.float32)
        self.congelado = np.zeros(red.n, np.int32)
        self.ultimo = np.zeros(red.n, bool)
        self._decae_I = np.float32(np.exp(-p.dt / p.tau_s))
        self._decae_V = np.float32(p.dt / p.tau_m)
        self._ref = int(p.refractario / p.dt)

    def paso(self, ext: np.ndarray | None = None) -> np.ndarray:
        """Un paso de `p.dt` ms. `ext` es corriente externa por neurona."""
        p, red = self.p, self.red
        self.I *= self._decae_I
        activas = np.flatnonzero(self.ultimo)
        if activas.size:
            self.I += p.escala * np.asarray(red.W[:, activas].sum(axis=1), np.float32).ravel()

        e = self.rng.standard_normal(red.n).astype(np.float32) * p.ruido
        if ext is not None:
            e += ext

        self.V += self._decae_V * (-self.V + self.I + e)
        self.V[self.congelado > 0] = 0.0
        self.congelado[self.congelado > 0] -= 1

        s = self.V > 1.0
        self.V[s] = 0.0
        self.congelado[s] = self._ref
        self.ultimo = s
        return s

    def avanzar(self, ms: float, ext: np.ndarray | None = None) -> np.ndarray:
        """`ms` de simulación con la misma corriente externa. Devuelve `(pasos, n)`."""
        return np.array([self.paso(ext) for _ in range(int(ms / self.p.dt))])


def simular(red: Red, p: Parametros, ms: float, estimulo=None, semilla: int = 0):
    """Corre la red desde cero. `estimulo` es `(indices, corriente, desde_ms, hasta_ms)`."""
    sim = Simulador(red, p, semilla)
    idx, corriente, desde, hasta = estimulo or (np.array([], int), 0.0, 0.0, 0.0)
    ext = np.zeros(red.n, np.float32)
    ext[idx] = corriente
    cero = np.zeros(red.n, np.float32)
    pasos = int(ms / p.dt)
    return np.array([sim.paso(ext if desde <= t * p.dt < hasta else cero)
                     for t in range(pasos)])


def hz(disparos: np.ndarray, idx: np.ndarray, p: Parametros) -> float:
    """Tasa media de disparo de un grupo, en Hz."""
    if idx.size == 0 or disparos.shape[0] == 0:
        return 0.0
    return float(disparos[:, idx].sum() / idx.size / (disparos.shape[0] * p.dt / 1000.0))


def somas(red: Red) -> np.ndarray:
    """Posición 3D del cuerpo celular de cada neurona, en el orden de `red`.

    `(n, 3)` float32, en unidades de vóxel del volumen de EM. **NaN donde no
    hay soma**: el 16% de las neuronas, casi todas sensoriales, que tienen el
    cuerpo celular fuera del sistema nervioso (en el ojo, en la periferia). Se
    simulan igual; solo no hay dónde dibujarlas.
    """
    import pandas as pd

    ann = pd.read_feather(DATOS / "anotaciones.feather")[["type", "somaLocation"]]
    ann = ann[ann["type"].notna()].reset_index(drop=True)
    # El orden de `red` sale del mismo filtro. Si alguna vez dejan de coincidir,
    # cada neurona se dibujaría en el lugar de otra y nada lo delataría.
    assert len(ann) == red.n and (ann["type"].to_numpy().astype(str) == red.tipo).all(), \
        "las anotaciones no están en el orden de la red: borrá data/red.npz"
    pos = np.full((red.n, 3), np.nan, np.float32)
    tiene = ann["somaLocation"].notna().to_numpy()
    pos[tiene] = np.stack(ann.loc[tiene, "somaLocation"].to_numpy()).astype(np.float32)
    return pos
