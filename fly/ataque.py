"""La mosca ataca: embiste al rival cuando lo huele encima, y la dopamina la
envalentona.

Tercera acción del boss atada a biología, y la primera que **cambia con la
experiencia**:

    olor del rival (cVA) → ORN_DA1 → DA1_lPN → células de Kenyon
    KC → MBON, y la balanza de valencia decide: acercarse o evitar
    acertar → PAM (recompensa) ┐ deprimen KC→MBON del compartimento que les
    recibir daño → PPL1 (castigo) ┘ toca, y la balanza se corre

**El olor.** *Drosophila* macho reconoce a otro macho por la cVA, su feromona, y
eso promueve agresión (Wang y Anderson 2010). Or67d → glomérulo DA1 → DA1_lPN,
que es de las entradas más fuertes a las células de Kenyon de este conectoma
(10.519 sinapsis): el rival entra al cuerpo pedunculado —que es lo que aprende—
por su propia puerta. Que la concentración caiga con la distancia lo pone el
motor, como el looming.

**La lectura sale de las MBON**, con la valencia publicada (Aso et al. 2014):
las de compartimentos PPL1 empujan a acercarse, las de compartimentos PAM a
evitar, y la balanza entre las dos es la decisión. No es la primera opción: se
probaron antes las dos vías más obvias y ninguna sobrevive al LIF (números en
`fly/README.md`):

- estimular pC1/aIPg —las neuronas de agresión del macho— dispara descendentes
  muy específicas (DNp68, DNg74_a, DNg86: 40x sobre el control), pero **el olor
  del rival no las mueve**: 0,81 Hz contra 0,70 del control;
- deprimir al máximo KC→MBON no mueve ni una descendente (±2 disparos, ruido),
  así que lo que el cuerpo pedunculado aprende no sale por ahí.

**El régimen es otro, y eso es un resultado.** Con el ruido de fondo en 2,0 —el
de `sobresalto.py`— la red se enciende sola a los pocos segundos (~3 Hz), las
interneuronas del lóbulo antenal disparan solas y **cierran el olfato**: las PN
del glomérulo DA1 quedan a 0 Hz aunque se les inyecte corriente, las KC ya están
al 3% por el fondo, y la balanza queda plana a cualquier distancia. Con 1,5 la
red no se enciende (0 Hz de fondo) y el olfato pasa. Por eso esta mosca corre a
1,5.

Tiene un precio medido, y hay que decirlo: con ruido 1,5 la fibra gigante
dispara **de más**. Con la ganancia de looming de `piloto.GANANCIA`, calibrada
para el ruido 2,0, la precisión de la esquiva cae del 88% al 33% (cobertura 41%
→ 87%, lift 8,8x → 3,3x). Sigue por encima del criterio de `piloto.py`, pero la
ganancia hay que rebarrerla en este régimen.

**Y el miedo, que es lo que faltaba.** El castigo no puede volverla cautelosa: las
MBON de acercarse casi no dependen de las KC (12,8 → 12,2 disparos aunque se les
deprima la entrada; las de evitar, en cambio, se apagan de 7,0 a 0,7 con la
recompensa), así que la plasticidad solo sabe envalentonarla. Lo que sí le da
cautela es el golpe: cuando la lastiman, el porrazo entra por los sensores
táctiles de las patas del lado del que vino, que es la única vía sensorial que
sobrevivió al LIF (`patas.py`), y la aparta. Y el rumbo solo persigue al olor
mientras la balanza dice acercarse.

Lo mecánico, marcado como deuda igual que `piloto.virar`: girar el rumbo, porque
DNa02 no sobrevivió al LIF (`patas.py`). El **signo** de ese giro sí es de la
mosca: persigue solo cuando su cuerpo pedunculado dice acercarse.

    python fly/ataque.py            # ¿aprende? ¿es jugable?
    python fly/ataque.py --grabar   # una pelea, en web/public/mosca.bin
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dopamina as D  # noqa: E402
import engine  # noqa: E402
import patas as PA  # noqa: E402
import piloto as P  # noqa: E402
import red as R  # noqa: E402
from oponente import Oponente  # noqa: E402

TAU = 2 * np.pi
EMBESTIDA = (2 << 6) | (3 << 3)  # Use(ToolId::Charge, ángulo)

# La embestida es el ataque porque es lo que hace un macho: embestir al rival.
# Medido contra el oponente guionado, sin mosca: conecta el 83% de las veces por
# debajo de 5 unidades y el 0% por encima. Ahí está la decisión.
ALCANCE = 5.0

# El olor del rival: cae con la distancia, y es lo que guía todo el ataque.
# `olor(d) = exp(-d/ESCALA)`, con la escala en unidades de arena.
#
# La corriente que entra en las ORN_DA1 es `OLOR * olor(d)`, y las KC solo se
# prenden en una franja estrecha de corriente: medido, 0% por debajo de 0,4,
# 0,9% entre 0,4 y 0,55, y 2,9% —el régimen de la mosca— por encima. La escala
# pone esa franja en el espacio: **la elegimos para que caiga donde la embestida
# conecta** (por debajo de 5 unidades), no donde caía antes (8 a 12), que dejaba
# a la mosca embistiendo desde fuera de alcance. Es la misma clase de perilla
# que la ganancia del looming en `piloto.py`: escala de un sentido, elegida
# midiendo.
#
#   escala 10: olor a 5 unidades 0,67 · a 8 0,49 · a 12 0,33  → ataca de lejos
#   escala  6: olor a 5 unidades 0,48 · a 8 0,29 · a 12 0,15  → ataca a tiro
OLOR = 1.1
ESCALA_OLOR = 6.0
# Cuánto gira por tick hacia el rival siguiendo el olor, como mucho.
VIRAJE_OLOR = 0.08

# El ruido de fondo de esta mosca, y el porqué está en el docstring: con 2,0 la
# red se enciende sola y el olfato se cierra.
RUIDO = 1.5

# Ventana para leer la balanza: 100 ms, el orden de una decisión de mosca.
VENTANA = 6
# El pulso de dopamina de un evento: corriente en las DAN y cuántos ticks.
#
# Los dos salen de la regla, no del gusto: `dopamina.MARGEN` descarta hasta 2
# disparos por tick y por DAN como ruido, y con corriente 3 —la del dolor de las
# paredes— las PAM dan 1,6, o sea nada. Con 10 dan 3,8, que deja 1,8 de señal.
# Seis ticks (100 ms) de eso deprimen a la mitad las sinapsis elegibles: la
# mosca aprende de un golpe, que es como aprende una mosca.
DOPAMINA = 10.0
PULSO = 6
# Cuánto dura el golpe: segundo y medio. No es dopamina, es el porrazo. Mientras
# dura, la mosca no embiste y se retira.
#
# Dos cosas medidas detrás del número. Una: con 200 ms no se veía nada, porque
# la persecución volvía a apuntar el rumbo al rival en el tick siguiente. La
# otra: el tacto de las patas —la vía real, la que la aparta de las paredes—
# **solo la empuja un poco** (`patas.py`: pasa su experimento por poco, y en
# pelea sigue rozando paredes un tercio del tiempo), así que por sí solo no
# aleja a la mosca de nadie: con el porrazo puesto seguía cerrando distancia
# después de cada golpe (4,2 → 2,9 unidades). Por eso la retirada es mecánica.
GOLPE = 90

TICKS = 1800  # 30 s: con el enfriamiento de la embestida son ~10 ataques


def hacia(w) -> int:
    """Ángulo del boss al jugador, como byte. Geometría, igual que la dirección
    de la esquiva: lo que decide la mosca es *cuándo* embestir, no hacia dónde —
    un macho que embiste ya está orientado al rival."""
    return int(round(np.arctan2(w[1] - w[5], w[0] - w[4]) / TAU * 256)) % 256


def distancia(w) -> float:
    return float(np.hypot(w[0] - w[4], w[1] - w[5]))


class Agresor(P.Piloto):
    """La mosca entera: esquiva con la fibra gigante, camina con las patas y
    embiste cuando la balanza del cuerpo pedunculado dice acercarse.

    `aprender=False` es el control sin plasticidad: los mismos pulsos de
    dopamina entran igual —son corriente en PAM y PPL1 de verdad— pero ninguna
    sinapsis cambia. Es lo que separa "aprendió" de "la dopamina la despertó".
    """

    def __init__(self, red, aprender=True, semilla=0, grabar=False, **kw):
        kw.setdefault("ruido", RUIDO)
        super().__init__(red, semilla=semilla, grabar=grabar, **kw)
        self.kc = D.kc(red)
        self.mbon = D.de_tipo(red, "MBON")
        self.cva = red.indices("ORN_DA1")
        self.pam, self.ppl1 = D.de_tipo(red, "PAM"), D.de_tipo(red, "PPL1")
        # El voto de cada MBON: +1 acercarse (compartimento de castigo, PPL1),
        # -1 evitar (compartimento de recompensa, PAM), 0 las que reciben las dos
        # y no distinguen. Es la valencia publicada, no algo ajustado acá.
        self.voto = ((D.compartimentos(red, "PPL1").sum(1) > 0).astype(float)
                     - (D.compartimentos(red, "PAM").sum(1) > 0))
        self.plasticidad = D.Plasticidad(red, dans=("PPL1", "PAM")) if aprender else None
        self.carrera = []
        self.ataques = []   # (tick, distancia)
        self.premios, self.castigos = [], []
        self.golpe = (-1, 0.0)  # hasta qué tick duele, y de qué lado
        self.reposo = self._calibrar()

    def _calibrar(self, ticks=90):
        """La mosca sola, sin rival: de ahí salen el reposo de cada MBON y el
        umbral para embestir, que son **tres sigmas del ruido de su propia
        balanza**. No es una perilla de cuánto ataca: es dónde termina su ruido.
        De paso le calienta la membrana antes de la pelea."""
        d = []
        for _ in range(ticks):
            self.tick(0.0)
            d.append(self.d[:, self.mbon].sum(0))
        if self.actividad is not None:
            self.actividad.clear()  # el .act empieza en el primer tick de la pelea
        d = np.array(d)
        reposo = d.mean(axis=0)
        ruido = np.convolve((d - reposo) @ self.voto, np.ones(VENTANA), "valid")
        self.umbral = 3 * float(ruido.std())
        return reposo

    def tick(self, looming, rayos=None, olor=0.0, premio=0.0, castigo=0.0,
             golpe=0.0) -> bool:
        self.ext[:] = 0.0
        self.ext[self.loom] = P.GANANCIA * looming
        self.ext[self.kc] = D.SESGO_KC
        self.ext[self.cva] = olor
        self.ext[self.pam] = DOPAMINA * premio
        self.ext[self.ppl1] = DOPAMINA * castigo
        self.tocar(rayos)
        # El golpe se siente por donde entró: los sensores táctiles de las patas
        # del lado del que pega. Es la misma vía que la aparta de las paredes
        # —la única que sobrevivió al LIF en `patas.py`— y es lo que la hace
        # retroceder cuando la lastiman. `golpe` es +1 por la derecha, -1 por la
        # izquierda, 0 si no le pegaron.
        if golpe and self.tacto:
            self.ext[self.tacto[1 if golpe > 0 else 0]] = PA.TACTO
        gf = self.avanzar()
        if self.plasticidad is not None:
            self.plasticidad.tick(self.d)
        return gf

    def balanza(self) -> float:
        """Disparos de MBON de acercarse menos los de evitar, sobre el reposo, en
        los últimos 100 ms. **Es la decisión**: si la balanza se va a acercarse,
        la mosca embiste.

        Medida en pelea: 0,0 ± 0,0 con el rival a más de 12 unidades (ni una KC
        prendida), +10 ± 16 entre 8 y 12, +36 ± 2 por debajo de 8. O sea que la
        balanza dice "hay un rival y está cerca", y en la franja de en medio
        titubea — que es donde la dopamina tiene algo que corregir.
        """
        self.carrera.append((self.d[:, self.mbon].sum(0) - self.reposo) @ self.voto)
        return float(sum(self.carrera[-VENTANA:]))

    def politica(self, t, obs, w) -> tuple[int, int]:
        """Un tick de mosca: percibe, y de ahí sale la acción del boss."""
        d = distancia(w)
        olor = float(np.exp(-d / ESCALA_OLOR))
        gf = self.tick(float(obs[engine.IDX_LOOMING]), obs[:16], olor=OLOR * olor,
                       premio=float(self.premios[-1] > t) if self.premios else 0.0,
                       castigo=float(self.castigos[-1] > t) if self.castigos else 0.0,
                       golpe=self.golpe[1] if self.golpe[0] > t else 0.0)
        balanza = self.balanza()
        if gf:
            return self.esquivar(w)
        # ponytail: MECÁNICO, NO ES LA MOSCA. El giro no sale del conectoma desde
        # que DNa02 no sobrevivió al LIF (`patas.py`), así que el rumbo se gira a
        # mano — pero **el signo lo pone la mosca**: se acerca al olor solo
        # mientras su cuerpo pedunculado dice acercarse. Si la balanza no llega
        # al umbral, no persigue: camina con sus patas y el tacto. Sin esto iba
        # siempre encima del rival, que es lo que se veía como falta de cautela.
        # Se quita cuando una vía del conectoma la oriente sola.
        # Mientras duele el rumbo va al revés: se retira. Es la otra mitad de la
        # misma deuda mecánica, con el signo puesto por un evento real (le
        # pegaron) en vez de por una regla de distancia.
        duele = self.golpe[0] > t
        if duele or balanza > self.umbral:
            objetivo = hacia(w) / 256 * TAU + (np.pi if duele else 0.0)
            self.rumbo += np.clip(np.angle(np.exp(1j * (objetivo - self.rumbo))),
                                  -VIRAJE_OLOR, VIRAJE_OLOR) * (1.0 if duele else olor)
        # El cuerpo tiene que poder: la embestida en frío o a mitad de otra
        # animación no existe, y contarla como ataque mentiría la tasa de acierto.
        listo = obs[32] == 0 and obs[34] == 0 and not duele
        if listo and balanza > self.umbral:
            self.ataques.append((t, d))
            self.rumbo = hacia(w) / 256 * TAU
            return EMBESTIDA, hacia(w)
        return self.caminar()

    def recompensa(self, t):
        """Acertó: dopamina de las PAM durante `PULSO` ticks."""
        self.premios.append(t + PULSO)

    def castigo(self, t, w):
        """Le pegaron: dopamina de las PPL1, y el porrazo por el lado del que
        vino. Lo segundo es lo que la hace retroceder: el castigo por sí solo no
        puede: las MBON de acercarse casi no dependen de las KC (medido: 12,8 →
        12,2 disparos aunque se les deprima la entrada), así que la plasticidad
        no tiene palanca para volverla cautelosa. Ver `fly/README.md`."""
        self.castigos.append(t + PULSO)
        rel = np.angle(np.exp(1j * (hacia(w) / 256 * TAU - self.rumbo)))
        self.golpe = (t + GOLPE, 1.0 if rel > 0 else -1.0)


def pelea(mosca, semilla=1, ticks=TICKS, esquiva=0.0):
    """Una pelea entera. Como `piloto.corrida`, pero la política ve la
    observación (el enfriamiento de la embestida vive ahí) y la dopamina entra
    cuando el motor dice que alguien cobró daño."""
    env = engine.VecEnv(1, seed=semilla, arena=P.ARENA)
    oponente = Oponente(semilla, arena=P.ARENA, esquiva=esquiva)
    obs = env.reset()
    log, hp = env.fight_log(0), float(env.world_state()[0][7])
    golpes, recibidos = [], []

    for t in range(ticks):
        w = env.world_state()[0]
        byte, param = mosca.politica(t, obs[0], w)
        obs, _, done = env.step(np.array([[oponente(w, obs[0]), byte, param]], np.uint8))
        w2 = env.world_state()[0]
        if w2[6] < w[6]:  # el jugador perdió vida: la embestida conectó
            golpes.append(t)
            mosca.recompensa(t)
        if w2[7] < w[7]:
            recibidos.append(t)
            mosca.castigo(t, w)
        if done[0]:
            break
        log, hp = env.fight_log(0), float(env.world_state()[0][7])

    return {"log": log, "hp": hp, "ticks": t + 1,
            "ataques": np.array(mosca.ataques, float).reshape(-1, 2),
            "golpes": np.array(golpes), "recibidos": np.array(recibidos),
            "jugador_hp": float(env.world_state()[0][6])}


def resumen(r) -> dict:
    a = r["ataques"]
    # Un golpe llega hasta 40 ticks después de la embestida (windup 22 + activa).
    acierto = sum(((r["golpes"] >= t) & (r["golpes"] < t + 40)).any() for t, _ in a)
    return {"ataques": len(a), "golpes": acierto,
            "acierto": acierto / max(len(a), 1),
            "distancia": float(a[:, 1].mean()) if len(a) else 0.0,
            "cerca": float((a[:, 1] <= ALCANCE).mean()) if len(a) else 0.0,
            "dano": 100.0 - r["jugador_hp"], "recibido": 1000.0 - r["hp"]}


def main(ticks=900, peleas=2, esquiva=0.5):
    """Las dos preguntas del ataque.

    1. **¿La dopamina cambia la conducta?** La misma mosca pelea varias veces
       seguidas conservando lo aprendido, y se compara con la misma sin
       plasticidad: los pulsos de dopamina entran igual, pero no cambian
       sinapsis. Si la diferencia estuviera solo en que la dopamina la despierta,
       las dos se moverían igual.
    2. **¿Es jugable?** El techo lo pone el motor —la embestida se enfría 300
       ticks y avisa 22 antes de salir—, así que lo que decide si el jugador
       sobrevive es si esquiva la telegrafía. Se mide con el oponente esquivando
       la mitad y sin esquivar ninguna.
    """
    red = R.construir()
    print(f"olor del rival: {red.indices('ORN_DA1').size} ORN_DA1 · "
          f"MBON acercarse/evitar {int((D.compartimentos(red,'PPL1').sum(1)>0).sum())}/"
          f"{int((D.compartimentos(red,'PAM').sum(1)>0).sum())} · "
          f"ruido {RUIDO} · {peleas} peleas de {ticks} ticks\n")
    print("                    pelea  ataques  golpes  acierto  distancia  balanza  "
          "daño al jugador  al boss  KC→MBON")
    filas = {}
    for nombre, kw in (("dopamina", {}), ("sin plasticidad", {"aprender": False})):
        mosca = Agresor(D.aprendiz(red), semilla=0, **kw)
        for i in range(peleas):
            corte = len(mosca.carrera)
            r = pelea(mosca, semilla=i + 1, ticks=ticks, esquiva=esquiva)
            s = resumen(r)
            s["balanza"] = float(np.mean(mosca.carrera[corte:]))
            s["peso"] = mosca.plasticidad.cuanto() if mosca.plasticidad else 1.0
            filas.setdefault(nombre, []).append(s)
            print(f"  {nombre:18} {i+1:4}  {s['ataques']:7}  {s['golpes']:6}  "
                  f"{s['acierto']:7.0%}  {s['distancia']:9.1f}  {s['balanza']:7.1f}  "
                  f"{s['dano']:15.0f}  {s['recibido']:7.0f}  {s['peso']:7.3f}", flush=True)

    print("\n=== jugable: el mismo boss contra un jugador que no esquiva ===")
    mosca = Agresor(D.aprendiz(red), semilla=0)
    duro = resumen(pelea(mosca, semilla=1, ticks=ticks, esquiva=0.0))
    print(f"  sin esquivar: {duro['golpes']} golpes de {duro['ataques']}, "
          f"{duro['dano']:.0f} de daño al jugador (de 100)")

    print("\n--- veredicto ---")
    con, sin = filas["dopamina"], filas["sin plasticidad"]
    for nombre, ss in filas.items():
        print(f"  {nombre:18} acierto {ss[0]['acierto']:.0%} → {ss[-1]['acierto']:.0%} · "
              f"ataques {ss[0]['ataques']} → {ss[-1]['ataques']} · "
              f"balanza {ss[0]['balanza']:.1f} → {ss[-1]['balanza']:.1f}")
    sube = con[-1]["acierto"] - con[0]["acierto"]
    if sube > 0.1 and sube > sin[-1]["acierto"] - sin[0]["acierto"]:
        print("\n  PASA: con plasticidad la mosca acierta más al final que al principio,"
              " y sin ella no.")
    else:
        print("\n  NO (todavía): el acierto no sube con la plasticidad más que sin ella."
              " Lo que sí cambia es la balanza, y con ella cuánto se atreve.")


def grabar(nombre="mosca", ticks=TICKS, esquiva=0.5):
    """Una pelea de la mosca que ataca, para verla en el navegador."""
    red = R.construir()
    P.PUBLICO.mkdir(exist_ok=True)
    dibujadas = P.exportar_cerebro(red)
    mosca = Agresor(D.aprendiz(red), grabar=True)
    r = pelea(mosca, ticks=ticks, esquiva=esquiva)

    _, boss_hp, n = engine.reproducir(r["log"])
    assert boss_hp == r["hp"], f"la reproducción diverge: {boss_hp} contra {r['hp']}"
    s = resumen(r)
    destino = P.PUBLICO / f"{nombre}.bin"
    destino.write_bytes(r["log"])
    spikes = P.exportar_actividad(mosca.actividad, P.PUBLICO / f"{nombre}.act")
    print(f"cerebro: {dibujadas:,} de {red.n:,} neuronas con posición · {spikes:,} disparos")
    print(f"{n} ticks · {s['ataques']} embestidas a {s['distancia']:.1f} de media, "
          f"{s['golpes']} conectaron ({s['acierto']:.0%}) · {s['cerca']:.0%} lanzadas a tiro · "
          f"daño al jugador {s['dano']:.0f} · al boss {s['recibido']:.0f}")
    print(f"reproducción verificada → {destino.relative_to(destino.parents[2])}")
    print(f"\n  ./scripts/dev.sh   y abrí   http://localhost:5173/?pelea={nombre}")


def humo():
    """El chequeo barato, sin mosca: que el byte de la embestida sea el que el
    motor entiende, y que a quemarropa conecte. Si `log.rs` cambia el
    empaquetado o la embestida deja de alcanzar, salta acá y no en una pelea de
    ocho minutos."""
    env = engine.VecEnv(1, seed=1, arena=P.ARENA)
    obs = env.reset()
    golpes = 0
    # 400 ticks: el boss camina a 4,5 u/s y arranca a 24 unidades del jugador.
    for t in range(400):
        w = env.world_state()[0]
        cerca = distancia(w) <= ALCANCE and obs[0, 32] == 0 and obs[0, 34] == 0
        accion = (EMBESTIDA, hacia(w)) if cerca else (P.MOVE | (hacia(w) >> 2), 0)
        obs, _, done = env.step(np.array([[0, *accion]], np.uint8))
        golpes += env.world_state()[0][6] < w[6]
        if done[0]:
            break
    assert golpes > 0, "la embestida no conectó ni a quemarropa contra un jugador quieto"
    print(f"OK: {golpes} embestidas conectadas contra un jugador quieto")


if __name__ == "__main__":
    if "--humo" in sys.argv:
        humo()
    elif "--grabar" in sys.argv:
        grabar()
    else:
        main()
