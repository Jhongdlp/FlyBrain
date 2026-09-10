"""Paso 0 — comprobar que la fase 1 es construible, antes de escribir el simulador.

No es "bajar datos": son cuatro preguntas que pueden matar el plan, y sale
barato responderlas ahora. Baja lo mínimo del conectoma MaleCNS v1.0 y verifica:

  1. Que los archivos están donde decimos y se leen.
  2. Cuántas aristas tiene el grafo — de ahí sale si hace falta GPU o no.
  3. Que hay predicción de neurotransmisor, sin la cual no hay signo E/I y no
     hay simulación posible.
  4. Que el circuito de looming (LC4, LPLC2 → DNp01) existe y está bien
     cableado. Si no, la fase 1 tal como está diseñada no existe.

El bucket es **público**: no hace falta cuenta de neuPrint ni token para esto.

    python fly/paso0.py [--descargar]

Los datos van a `data/`, fuera del control de versiones. Son 540 MB.
"""

import sys
from pathlib import Path
from urllib.request import urlopen

import pandas as pd

BUCKET = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
DATOS = Path(__file__).resolve().parent.parent / "data"

# Solo tres de los once archivos. `traced-only` y no el completo: el completo
# incluye fragmentos sin trazar que no son neuronas y pesa el doble.
ARCHIVOS = {
    "anotaciones.feather": "body-annotations-male-cns-v1.0-minconf-0.5.feather",
    "neurotransmisores.feather": "body-neurotransmitters-male-cns-v1.0.feather",
    "conectoma.feather": "connectome-weights-male-cns-v1.0-minconf-0.5-traced-only.feather",
}

# Los del reflejo de escape: las dos poblaciones visuales sensibles a objetos en
# expansión, y la fibra gigante donde convergen. Es un test con respuesta
# conocida, que es lo único que permite distinguir "mi simulación está mal" de
# "el conectoma es así".
LOOMING = ["LC4", "LPLC2", "DNp01"]

# Acetilcolina excita; glutamato, GABA e histamina inhiben. El resto son
# moduladores y no dan un signo utilizable en un LIF simple.
SIGNOS = {"acetylcholine": +1, "glutamate": -1, "gaba": -1, "histamine": -1}


def descargar():
    DATOS.mkdir(exist_ok=True)
    for local, remoto in ARCHIVOS.items():
        destino = DATOS / local
        if destino.exists():
            print(f"  {local} ya está")
            continue
        print(f"  bajando {local} …", flush=True)
        with urlopen(f"{BUCKET}/{remoto}") as r, open(destino, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        print(f"  {local}  {destino.stat().st_size / 1e6:.0f} MB")


def main():
    if "--descargar" in sys.argv:
        descargar()
    faltan = [n for n in ARCHIVOS if not (DATOS / n).exists()]
    if faltan:
        raise SystemExit(f"faltan {faltan}. Corré con --descargar")

    ann = pd.read_feather(DATOS / "anotaciones.feather")
    tipadas = ann[ann["type"].notna()]
    print(f"\n1. {len(ann):,} cuerpos, {len(tipadas):,} con tipo celular asignado")
    print(f"   descendentes (la salida motora del boss): "
          f"{(ann['superclass'] == 'descending_neuron').sum():,}")

    w = pd.read_feather(DATOS / "conectoma.feather", columns=["weight"])["weight"]
    print(f"\n2. {len(w):,} aristas, {w.sum():,} sinapsis")
    print("   umbral  aristas      sinapsis  RAM a 8 B/arista")
    for u in (1, 3, 5, 10):
        m = w >= u
        print(f"     >={u:<3} {m.sum():>10,}  {100 * w[m].sum() / w.sum():8.1f}%"
              f"  {m.sum() * 8 / 1e6:8.1f} MB")

    nt = pd.read_feather(DATOS / "neurotransmisores.feather", columns=["body", "consensus_nt"])
    j = tipadas[["bodyId", "type"]].merge(nt, left_on="bodyId", right_on="body", how="left")
    con_signo = j["consensus_nt"].isin(SIGNOS).sum()
    print(f"\n3. neurotransmisor con signo E/I en {con_signo:,} de {len(j):,}"
          f" = {100 * con_signo / len(j):.1f}%")

    print("\n4. el circuito de looming:")
    for t in LOOMING:
        s = j[j["type"] == t]
        nts = s["consensus_nt"].value_counts().to_dict()
        assert len(s), f"{t} no está en el dataset: la fase 1 no es construible"
        print(f"     {t:7} {len(s):4} neuronas  {nts}")

    tipos = pd.read_feather(DATOS / "conectoma.feather",
                            columns=["type_pre", "type_post", "weight"])
    entra = (tipos[tipos["type_post"] == "DNp01"]
             .groupby("type_pre")["weight"].sum().sort_values(ascending=False))
    print(f"\n   entradas a DNp01 ({entra.sum():,} sinapsis desde {len(entra)} tipos):")
    for t, n in entra.head(5).items():
        print(f"     {t:10} {n:>6,}")
    # La comprobación que valida el dataset contra la biología conocida: si LC4
    # y LPLC2 no son las dos primeras, algo está mal en cómo leímos el archivo.
    assert set(entra.head(2).index) == {"LC4", "LPLC2"}, \
        "LC4 y LPLC2 no dominan la entrada a la fibra gigante: revisá la lectura"
    print("\n   OK: LC4 y LPLC2 dominan la entrada a la fibra gigante,"
          " como dice la literatura.")


if __name__ == "__main__":
    main()
