# La mosca

Simulación LIF sobre el conectoma MaleCNS v1.0. Sin nada del juego: esto es la
mosca sola, y tiene que poder validarse sola.

```
paso0.py       comprueba que la fase 1 es construible (datos, aristas, E/I, circuito)
red.py         el conectoma como matriz dispersa + el simulador LIF
sobresalto.py  el experimento: ¿la fibra gigante responde al looming?
piloto.py      la mosca maneja la esquiva del boss dentro del juego
```

```bash
python fly/paso0.py --descargar    # 540 MB, bucket público, una sola vez
python fly/sobresalto.py           # ~2 min en CPU
```

## El resultado

La fase 1 **pasa**. Estimular LC4+LPLC2 hace disparar a DNp01 unas 30 veces más
que estimular el mismo número de neuronas de proyección visual al azar, de forma
consistente entre semillas, y en un rango de escala sináptica de 7x.

```
escala  red Hz  sincr    GF looming      GF control    razón  latencia
  0.01    0.17  0.03%   70.2±0.8     0.0±0.0        70x     8.4 ms
  0.02    0.35  0.06%   76.8±1.3     5.6±5.7        14x     7.2 ms
  0.03    0.52  0.10%   75.8±1.6     2.4±2.3        32x     6.6 ms
  0.05    2.94  0.50%   45.5±4.9     2.0±2.8        23x     6.5 ms
  0.07    7.70  0.76%   37.8±9.0     1.0±2.0        38x     5.5 ms
```

## Cómo se encontró la franja

El conectoma da la topología. **No da el signo** (viene de la predicción de
neurotransmisor, aparte), **ni el peso en unidades físicas, ni las constantes de
tiempo.** Elegir esos tres es el trabajo, y el régimen donde una red así hace
algo es una franja estrecha entre apagarse y convulsionar.

Barrido de ruido de fondo × escala sináptica, 60 ms, tasa media de la red:

```
ruido \ escala   1e-4    1e-3     0.01     0.03     0.10     0.30     1.00     3.00
       1.0        0.0     0.0      0.0      0.0      0.0      0.0        —        —
       2.0        0.0     0.0      0.0      0.0      0.0      7.6     26.2     52.0
       3.0        0.3     0.3      0.4      1.6      9.1     23.6     46.5     62.8
       4.0        2.2     2.2      2.8      5.2     13.9     30.9     48.9     62.6
```

**Se eligió ruido = 2.0** porque es el nivel más alto al que la red sigue **muda
sin sinapsis**: toda la actividad que aparece es recurrente y no ruido colado. Un
ruido de 3 o 4 ya hace disparar la red por sí solo, y entonces no se sabe qué
está midiendo el experimento.

**Y escala por debajo de 0.1**, que fue el hallazgo que no se veía venir: por
encima de eso la actividad recurrente *ahoga la señal*. La red sube a 12–30 Hz,
la inhibición apaga hasta las neuronas estimuladas directamente (LC4 y LPLC2
bajan a 2 Hz de los 40 que reciben), y la respuesta de la fibra gigante se vuelve
un sorteo: entre 0 y 49 spikes según la semilla. Más ganancia sináptica da
*menos* respuesta, y no monótonamente.

Por eso el criterio de la meseta no es un adorno. Con un solo punto medido en
0.1, este experimento habría dado 25.6x y parecido un éxito, cuando en realidad
estaba en la pendiente del acantilado.

## Lo que este resultado **no** dice

- **No hay visión.** La corriente se inyecta directamente en LC4 y LPLC2. Toda la
  cadena fotorreceptores → médula → LC no se simula. Por eso la latencia da 5–8
  ms, que es un salto sináptico y no la latencia visual real de la mosca, que es
  de decenas de ms.
- **No hay looming, hay drive sincronizado.** El estímulo real es un objeto
  expandiéndose, con estructura espacial y temporal. Acá son 311 neuronas
  recibiendo la misma corriente durante 100 ms.
- **No hay plasticidad.** Los pesos no cambian. Nada aprende todavía.
- **El signo E/I sale de una predicción**, no de mediciones. Cubre el 98,1% de
  las neuronas, pero es un clasificador y tiene su tasa de error.

Nada de eso invalida el resultado: el circuito de escape está en el conectoma,
transmite, y responde de forma específica. Es exactamente lo que la fase 1 tenía
que averiguar.

## La mosca en el juego: DNp01 → esquiva

```
algo se acerca → vision::looming → LC4 + LPLC2 → DNp01 → ToolId::Dash
```

El motor calcula la señal de looming (`engine/src/vision.rs`): la tasa de
expansión angular `2rv/d²` de lo que se le viene encima al boss, que es lo que
responden LC4 y LPLC2. Es geometría y vive en Rust, igual que los raycasts. La
mosca recibe ese número como corriente, corre 16,67 ms de LIF por tick de juego,
y si la fibra gigante dispara, el boss esquiva.

**La mosca decide *si* esquivar; hacia dónde es geometría** (de costado a la
línea de tiro). La fibra gigante no es direccional, y fingir que lo es sería
inventar biología.

Escenario: boss quieto, jugador guionado que cruza el hueco del muro central y
le dispara el cañón. Control: **las mismas esquivas en ticks al azar.**

```
=== lazo abierto: ¿dispara cuando hay un tiro? ===
  900 ticks, 26 con proyectil encima (2.9%)
  la fibra gigante disparó en 77 ticks
  precisión 10%  ·  cobertura 31%  ·  lift 3.6x sobre el azar

=== lazo cerrado: ¿esquivar así sirve? ===
                        esquivas   daño recibido
  boss quieto                   0       110 ± 0
  esquiva la mosca             13         0 ± 0
  esquiva al azar              13        60 ± 10
```

### Cómo leer esto sin engañarse

- **La precisión de 10% no es un fallo, es la biología.** LC4 responde a todo lo
  que se expande en el campo visual, y el jugador caminando hacia el boss
  también se expande. La mosca no distingue un proyectil de un depredador que se
  acerca — no tiene por qué. Contra proyectiles solos, dispara 3,6 veces más de
  lo que tocaría por azar.
- **En lazo cerrado el timing es limpio**: las 8 órdenes de esquiva de la semilla
  0 caen con un proyectil encima, las 8. Una ráfaga de la fibra gigante entre los
  ticks 130 y 137, justo cuando llega el primer tiro.
- **El "0 de daño" está inflado por el oponente.** Tras esa primera esquiva el
  boss queda fuera de la línea de tiro, y el jugador guionado apunta en 8
  direcciones y no vuelve a acertar. Lo que el experimento demuestra es que la
  esquiva llega **a tiempo**; el tamaño del efecto sobre el daño es propiedad de
  un oponente tonto, no de la mosca.
- **Las 4 semillas son una sola pelea.** El guion del jugador es determinista;
  las semillas solo cambian el ruido de la mosca. De ahí el "± 0".
- **La ganancia sensorial (10) se eligió barriendo** en lazo abierto: con 2,5 la
  fibra gigante se pierde el 80% de los tiros, con 20 dispara a todo.

### Lo que falta

- **Un oponente que re-apunte.** Sin eso, cualquier esquiva parece mejor de lo
  que es. El replay de peleas humanas de EPOCH sería el candidato natural.
- **Retinotopía.** Todas las LC4 tienen campo receptivo derivable del conectoma
  —el centroide de las columnas que las alimentan, mediana 18 por neurona— así
  que el looming se puede inyectar por azimut en vez de a todas por igual. No
  hace falta para el escape, que no es direccional; sí para que la mosca
  *gire*.
- **Velocidad.** 900 ticks de mosca tardan ~2,5 minutos en CPU con esta
  ganancia. Para grabar peleas sueltas sobra; para generar miles, es donde entra
  la GPU.
