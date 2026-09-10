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
    escala: float = 2e-4    # sinapsis → corriente. **La perilla que se barre.**
    ruido: float = 0.02     # actividad espontánea; sin esto la red no arranca


def simular(red: Red, p: Parametros, ms: float, estimulo=None, semilla: int = 0):
    """Corre la red y devuelve la matriz de disparos `(pasos, n)` como bool.

    `estimulo` es `(indices, corriente, desde_ms, hasta_ms)`, o `None`.

    La propagación es por eventos: solo se leen las columnas de las neuronas que
    dispararon. Con ~1% de actividad son 0,7 ms por paso contra 7,9 del producto
    completo — la diferencia entre correr esto en una laptop y tener que
    alquilar una GPU.
    """
    rng = np.random.default_rng(semilla)
    n, pasos = red.n, int(ms / p.dt)
    V = np.zeros(n, np.float32)
    I = np.zeros(n, np.float32)
    congelado = np.zeros(n, np.int32)
    disparos = np.zeros((pasos, n), bool)

    decae_I = np.float32(np.exp(-p.dt / p.tau_s))
    decae_V = np.float32(p.dt / p.tau_m)
    ref_pasos = int(p.refractario / p.dt)

    idx_est, corriente, desde, hasta = estimulo or (np.array([], int), 0.0, 0, 0)

    for t in range(pasos):
        I *= decae_I
        activas = np.flatnonzero(disparos[t - 1]) if t else np.array([], np.int32)
        if activas.size:
            I += p.escala * np.asarray(red.W[:, activas].sum(axis=1), np.float32).ravel()

        ext = rng.standard_normal(n).astype(np.float32) * p.ruido
        if desde <= t * p.dt < hasta:
            ext[idx_est] += corriente

        V += decae_V * (-V + I + ext)
        V[congelado > 0] = 0.0
        congelado[congelado > 0] -= 1

        s = V > 1.0
        disparos[t] = s
        V[s] = 0.0
        congelado[s] = ref_pasos

    return disparos


def hz(disparos: np.ndarray, idx: np.ndarray, p: Parametros) -> float:
    """Tasa media de disparo de un grupo, en Hz."""
    if idx.size == 0 or disparos.shape[0] == 0:
        return 0.0
    return float(disparos[:, idx].sum() / idx.size / (disparos.shape[0] * p.dt / 1000.0))
