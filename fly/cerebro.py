"""El cerebro que les da las órdenes a las patas, entrenado como `flyvis`.

`cordon.py` mostró que, con tasas, lo de abajo transmite: DNg100 hace caminar y
DNa02 gira. Lo que falta está arriba: el cerebro no manda esas descendentes. Y
sin entrenar no hay régimen donde lo haga: con el sistema nervioso entero en
tasas, o el cerebro queda mudo o se desboca (ver `fly/README.md`).

Lo mismo le pasó a Lappalainen et al. con el ojo, y lo resolvieron así: la
conectividad del conectoma fija, y **unos pocos números por tipo celular**
entrenados contra una tarea. Acá:

- **Qué se simula**: el cordón de las seis patas (`cordon.subred`), los sensores
  táctiles, las ascendentes, y el cerebro a un salto de las ascendentes y a un
  salto de las descendentes que llegan a las patas.
- **Qué se entrena**: ganancia y umbral por tipo celular, solo en el cerebro y
  las descendentes. El cordón queda con los parámetros de Pugliese et al., que
  ya se validaron: si algo mejora, tiene que venir de arriba.
- **La tarea es de conducta, no de neuronas**: tocar de un lado tiene que girar
  hacia el otro, sin saturar las patas. No se le dice qué descendentes usar.

La marcha está puesta (DNg100 fija), como en `cordon.giro`.

    .venv-ojo/bin/python fly/cerebro.py --inicio   # cómo arranca, sin entrenar
    .venv-ojo/bin/python fly/cerebro.py            # entrena (retoma de data/cerebro.pt)
"""

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cordon as C  # noqa: E402
import patas as P  # noqa: E402
import red as R  # noqa: E402

DT = 2.0  # ms: con τ ≈ 20 ms, Euler aguanta, y la mitad de pasos para entrenar
MARCHA_HZ = 20.0


def armar(red):
    """Índices a simular, y cuáles son del cerebro (entrenables)."""
    ti, td = P.tacto(red)
    cordon = np.union1d(C.subred(red, ("fl", "ml", "hl")), np.concatenate([ti, td]))
    sc = red.superclase.astype(str)
    an = np.flatnonzero(sc == "ascending_neuron")
    dn = np.intersect1d(np.flatnonzero(sc == "descending_neuron"), cordon)
    W = (red.W != 0).astype(np.float32).tocsr()  # post × pre
    de_an = np.zeros(red.n, bool)
    de_an[an] = True
    de_an = (W @ de_an.astype(np.float32)) > 0  # reciben de una ascendente
    a_dn = np.zeros(red.n, bool)
    a_dn[dn] = True
    a_dn = (W.T.tocsr() @ a_dn.astype(np.float32)) > 0  # le hablan a una descendente
    cerebro = (np.char.startswith(sc, "cb") | (sc == "visual_projection")) & de_an & a_dn
    idx = np.unique(np.concatenate([cordon, an, np.flatnonzero(cerebro), dn]))
    entrena = cerebro[idx] | np.isin(idx, dn)
    return idx, entrena


class Cerebro(torch.nn.Module):
    def __init__(self, red, idx, entrena, semilla=0):
        super().__init__()
        # Los parámetros de base, los de `cordon.Cordon`, escalados contra la
        # mediana del cordón: la escala en la que se validaron.
        ref = np.nanmedian(C.tamanos(red)[C.subred(red)])
        base = C.Cordon(red, idx, semilla, ref=ref)
        self.en = base.en
        W = (red.W[:, idx].tocsr()[idx] * C.PESO).tocsr()
        self.W = torch.sparse_csr_tensor(torch.from_numpy(W.indptr.astype(np.int64)),
                                         torch.from_numpy(W.indices.astype(np.int64)),
                                         torch.from_numpy(W.data.astype(np.float32)), W.shape)
        f = lambda x: torch.tensor(x, dtype=torch.float32)
        self.tau, self.a0, self.theta0, self.rmax = f(base.tau), f(base.a), f(base.theta), f(base.rmax)
        tipos, self.tipo = np.unique(red.tipo[idx][entrena], return_inverse=True)
        self.tipos = tipos
        self.cuales = torch.from_numpy(np.flatnonzero(entrena))
        self.tipo = torch.from_numpy(self.tipo)
        # log-multiplicadores por tipo: en 0 es el modelo sin entrenar
        self.ganancia = torch.nn.Parameter(torch.zeros(tipos.size))
        self.umbral = torch.nn.Parameter(torch.zeros(tipos.size))

    def parametros(self):
        a, th = self.a0.clone(), self.theta0.clone()
        a[self.cuales] = a[self.cuales] * torch.exp(self.ganancia[self.tipo])
        th[self.cuales] = th[self.cuales] * torch.exp(self.umbral[self.tipo])
        return a, th

    def forward(self, fijas, tasas, ms, leer):
        """`fijas`: índices del modelo que dicta algo de afuera; `tasas`:
        `(len(fijas), lote)` en Hz. Devuelve `(pasos, len(leer), lote)` y la tasa
        media de las entrenables (para no dejar que se desboquen)."""
        a, th = self.parametros()
        a, th = a[:, None], th[:, None]
        tau, rmax = self.tau[:, None], self.rmax[:, None]
        r = torch.zeros(self.tau.shape[0], tasas.shape[1])
        salida, brillo = [], 0.0
        for _ in range(int(ms / DT)):
            x = torch.sparse.mm(self.W, r) - th
            fx = torch.relu(rmax * torch.tanh(a / rmax * x))
            r = r + DT / tau * (fx - r)
            r = r.index_put((fijas,), tasas)
            salida.append(r[leer])
            brillo = brillo + r[self.cuales].mean()
        return torch.stack(salida), brillo / len(salida)


def ensayos(red, m, intensidades):
    """Las entradas fijas de un lote: DNg100 en marcha, y el tacto de cada lado
    a cada intensidad (más la columna sin tacto)."""
    ti, td = P.tacto(red)
    g = red.indices("DNg100")
    fijas = torch.from_numpy(m.en[np.concatenate([g, ti, td])])
    cols = [(0.0, 0.0)] + [(u, 0.0) for u in intensidades] + [(0.0, u) for u in intensidades]
    tasas = torch.zeros(fijas.shape[0], len(cols))
    tasas[:g.size] = MARCHA_HZ
    for k, (izq, der) in enumerate(cols):
        tasas[g.size:g.size + ti.size, k] = izq
        tasas[g.size + ti.size:, k] = der
    return fijas, tasas


def leer_patas(red, m):
    pat = P.Patas(red)
    return torch.from_numpy(m.en[np.concatenate([pat.izq, pat.der])]), pat.izq.size


def giro(traza, n):
    """(izq − der)/(izq + der) de las motoneuronas, por columna, sobre los
    últimos 200 ms. Ancla DNa02: positivo es girar a la izquierda."""
    t = traza[-int(200 / DT):].mean(0)
    izq, der = t[:n].mean(0), t[n:].mean(0)
    return (izq - der) / (izq + der + 1e-6), izq + der


def inicio():
    red = R.construir()
    idx, entrena = armar(red)
    m = Cerebro(red, idx, entrena)
    print(f"{idx.size:,} neuronas · {int(entrena.sum()):,} entrenables en {m.tipos.size:,} tipos · "
          f"{m.W._nnz():,} conexiones", flush=True)
    intens = [0.5, 1.0, 2.0]
    fijas, tasas = ensayos(red, m, intens)
    leer, n = leer_patas(red, m)
    import time
    t0 = time.time()
    with torch.no_grad():
        tr, brillo = m(fijas, tasas, 400.0, leer)
    g, suma = giro(tr, n)
    print(f"{time.time() - t0:.1f} s por 400 ms · cerebro a {float(brillo):.2f} Hz de media")
    print("columna      giro (+ izq)  suma MN")
    nombres = ["sin tacto"] + [f"tacto izq {u}" for u in intens] + [f"tacto der {u}" for u in intens]
    for k, nombre in enumerate(nombres):
        print(f"  {nombre:13} {float(g[k]):+.3f}   {float(suma[k]):6.2f}")


# La tarea. Cuánto tiene que girar un toque, sobre el giro sin tacto; hasta
# dónde puede llegar la suma de las motoneuronas (con el cordón solo y la marcha
# puesta es ~1 Hz; el estado "interruptor" de `cordon.py` es ~50); y la tasa
# media del cerebro, que en la mosca es esparso.
MARGEN = 0.1
PATAS_MAX = 5.0
CEREBRO_MAX = 2.0
ITERACIONES = 300
# Con 0,05 las primeras 30 iteraciones se fueron casi enteras en bajar el cerebro
# de 26 a 18 Hz: el paso en log-parámetros era demasiado corto.
PASO = 0.2
MS = 300.0  # los últimos 200 se leen; 100 de transitorio
GUARDADO = R.DATOS / "cerebro.pt"
VALIDA = [0.75, 1.5]  # intensidades que nunca se ven al entrenar


def perdida(m, red, intens, leer, n, ms=MS):
    fijas, tasas = ensayos(red, m, intens)
    tr, brillo = m(fijas, tasas, ms, leer)
    g, suma = giro(tr, n)
    k = len(intens)
    izq, der = g[1:1 + k] - g[0], g[1 + k:] - g[0]  # respecto de sin tacto
    # tocar a la izquierda → girar a la derecha (negativo), y al revés
    tarea = torch.relu(MARGEN + izq).mean() + torch.relu(MARGEN - der).mean()
    patas = torch.relu(torch.log(suma / PATAS_MAX)).pow(2).mean()
    cerebro = torch.relu(brillo - CEREBRO_MAX)
    reg = 1e-3 * (m.ganancia.pow(2).mean() + m.umbral.pow(2).mean())
    return tarea + patas + cerebro + reg, dict(
        tarea=float(tarea), izq=float(izq.mean()), der=float(der.mean()),
        suma=float(suma.mean()), cerebro=float(brillo))


def entrenar():
    red = R.construir()
    idx, entrena = armar(red)
    m = Cerebro(red, idx, entrena)
    leer, n = leer_patas(red, m)
    opt = torch.optim.Adam([m.ganancia, m.umbral], lr=PASO)
    rng = np.random.default_rng(0)
    desde = 0
    if GUARDADO.exists():
        z = torch.load(GUARDADO, weights_only=False)  # trae los tipos como numpy
        m.load_state_dict(z["modelo"], strict=False)
        opt.load_state_dict(z["opt"])
        for grupo in opt.param_groups:
            grupo["lr"] = PASO
        desde = z["iteracion"] + 1
    for it in range(desde, ITERACIONES):
        intens = sorted(rng.uniform(0.3, 2.0, 2).tolist())
        opt.zero_grad()
        loss, info = perdida(m, red, intens, leer, n)
        loss.backward()
        opt.step()
        print(f"{it:4} pérdida {float(loss):.3f} · giro izq {info['izq']:+.3f} der {info['der']:+.3f} · "
              f"patas {info['suma']:5.1f} Hz · cerebro {info['cerebro']:5.2f} Hz", flush=True)
        if it % 10 == 9 or it == ITERACIONES - 1:
            with torch.no_grad():
                _, v = perdida(m, red, VALIDA, leer, n)
            print(f"     validación ({VALIDA} Hz): giro izq {v['izq']:+.3f} der {v['der']:+.3f} · "
                  f"patas {v['suma']:5.1f} · cerebro {v['cerebro']:5.2f}", flush=True)
            torch.save({"modelo": {"ganancia": m.ganancia, "umbral": m.umbral},
                        "opt": opt.state_dict(), "iteracion": it, "tipos": m.tipos}, GUARDADO)


if __name__ == "__main__":
    if "--inicio" in sys.argv:
        inicio()
    else:
        entrenar()
