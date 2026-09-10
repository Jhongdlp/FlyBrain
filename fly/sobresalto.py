"""El experimento del sobresalto: ¿la fibra gigante responde al looming?

**Es un test con respuesta conocida, y ésa es toda su razón de ser.** Un objeto
que se acerca activa LC4 y LPLC2, que convergen en DNp01 (la fibra gigante), que
dispara el salto de escape. Está documentado hasta la latencia, y en este
conectoma LC4 y LPLC2 son las dos entradas dominantes a DNp01 — lo comprueba
`paso0.py`.

Sin un test así no se puede distinguir "mi simulador está roto" de "el conectoma
es así", y se depura a ciegas para siempre.

El control es lo que le da sentido: se estimula **el mismo número de neuronas de
proyección visual**, elegidas al azar. Si DNp01 respondiera igual, lo que
estaríamos midiendo sería "meterle corriente al sistema visual la despierta", no
el circuito de escape.

    python fly/sobresalto.py
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import red as R  # noqa: E402

LOOMING = ("LC4", "LPLC2")

# 50 ms de reposo, 100 ms de estímulo, 100 ms para ver la cola de la respuesta.
BASAL, ESTIMULO, TOTAL = 50.0, 100.0, 250.0
# Lleva a LC4/LPLC2 a ~80 Hz, que es el orden de lo que se mide en la mosca.
CORRIENTE = 2.5
N_CONTROLES = 5

# Ruido 2.0: a este nivel la red está **muda sin sinapsis**, así que todo lo que
# dispare es recurrente y no ruido colado. Medido barriendo el ruido: a 1.0 y 2.0
# la red da 0.0 Hz sin importar la escala sináptica.
RUIDO = 2.0

# La franja de escala sináptica que funciona, encontrada barriendo de 1e-4 a 3.0.
# **Por encima de 0.1 la actividad recurrente ahoga la señal**: la red sube a
# 12-30 Hz, la inhibición apaga hasta las neuronas estimuladas directamente, y
# la respuesta de la fibra gigante se vuelve un sorteo (0 a 49 spikes según la
# semilla). Que el rango que pasa abarque 7x y no un punto es el tercer
# criterio, y es el que la gente se saltea.
ESCALAS = (0.01, 0.02, 0.03, 0.05, 0.07)
SEMILLAS = 4


def ensayo(r, p, idx, semilla):
    d = R.simular(r, p, TOTAL, (idx, CORRIENTE, BASAL, BASAL + ESTIMULO), semilla)
    paso = lambda ms: int(ms / p.dt)
    gf = r.indices("DNp01")
    # La ventana se pasa del estímulo a propósito: la fibra gigante puede
    # disparar después de que la entrada se corta.
    resp = d[paso(BASAL) : paso(BASAL + ESTIMULO + 50)][:, gf]
    cuando = np.flatnonzero(resp.any(axis=1))
    return {
        "gf": int(resp.sum()),
        # Latencia al primer disparo desde el inicio del estímulo. Contraste
        # más contra biología: en la mosca la GF responde en decenas de ms.
        "latencia": float(cuando[0] * p.dt) if cuando.size else float("nan"),
        "red": R.hz(d, np.arange(r.n), p),
        # Fracción de la población que dispara en el paso más sincronizado. Si
        # esto se dispara, no es una respuesta: es una convulsión.
        "sincronia": float(d.sum(axis=1).max() / r.n),
    }


def main():
    r = R.construir()
    rng = np.random.default_rng(0)
    vpn = np.flatnonzero(r.superclase == "visual_projection")
    loom = r.indices(*LOOMING)
    # Mismo tamaño que LC4+LPLC2: si el control fuera más chico, cualquier
    # diferencia sería de cuánta corriente entró, no de por dónde entró.
    controles = [rng.choice(np.setdiff1d(vpn, loom), loom.size, replace=False)
                 for _ in range(N_CONTROLES)]

    print(f"looming: {loom.size} neuronas (LC4+LPLC2) · control: {loom.size} de "
          f"{vpn.size} de proyección visual, al azar · {SEMILLAS} semillas\n")
    print("escala  red Hz  sincr    GF looming      GF control    razón  latencia")

    filas = []
    for esc in ESCALAS:
        p = R.Parametros(escala=esc, ruido=RUIDO)
        L = [ensayo(r, p, loom, s) for s in range(SEMILLAS)]
        C = [ensayo(r, p, c, 100 + i)["gf"] for i, c in enumerate(controles)]
        lm, ls = np.mean([e["gf"] for e in L]), np.std([e["gf"] for e in L])
        cm, cs = float(np.mean(C)), float(np.std(C))
        # Media de control por debajo de un spike: la razón no significa nada,
        # así que se compara contra 1 y se dice ">".
        razon = lm / max(cm, 1.0)
        lat = np.nanmean([e["latencia"] for e in L])
        print(f"{esc:6.2f} {np.mean([e['red'] for e in L]):7.2f} "
              f"{max(e['sincronia'] for e in L):6.2%}  {lm:5.1f}±{ls:<4.1f}  "
              f"{cm:5.1f}±{cs:<4.1f} {razon:8.0f}x {lat:7.1f} ms")
        filas.append((esc, lm, cm, razon, np.mean([e["red"] for e in L]),
                      max(e["sincronia"] for e in L), ls))

    print("\n--- veredicto ---")
    pasan = []
    for esc, lm, cm, razon, red, sincr, ls in filas:
        motivos = []
        # Tasa media de una mosca real: unos pocos Hz. Diez es generoso.
        if not 0.1 <= red <= 10: motivos.append(f"red a {red:.1f} Hz")
        if sincr >= 0.05: motivos.append("sincronizada")
        if lm < 5: motivos.append("la GF no responde")
        if razon < 3: motivos.append(f"solo {razon:.0f}x sobre el control")
        # Si la respuesta cambia de una semilla a otra, no es una respuesta.
        if lm > 0 and ls / lm > 0.3: motivos.append("inconsistente entre semillas")
        print(f"  escala {esc:5.2f}  {'PASA' if not motivos else 'no: ' + ', '.join(motivos)}")
        if not motivos:
            pasan.append(esc)

    print(f"\n{len(pasan)} de {len(ESCALAS)} escalas pasan los tres criterios.")
    if len(pasan) >= 2:
        print(f"Meseta de {min(pasan)} a {max(pasan)} ({max(pasan)/min(pasan):.0f}x): "
              "hay régimen, no una coincidencia de un punto.")
    else:
        print("Sin meseta. Un solo punto que funciona no es un régimen.")


if __name__ == "__main__":
    main()
