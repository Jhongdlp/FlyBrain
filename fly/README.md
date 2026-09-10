# La mosca

Simulación LIF sobre el conectoma MaleCNS v1.0. Sin nada del juego: esto es la
mosca sola, y tiene que poder validarse sola.

```
paso0.py       comprueba que la fase 1 es construible (datos, aristas, E/I, circuito)
red.py         el conectoma como matriz dispersa + el simulador LIF
sobresalto.py  el experimento: ¿la fibra gigante responde al looming?
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

## Lo siguiente

DNp01 disparando **es** la esquiva del boss. Es la primera acción del juego
mapeada a biología real en vez de asignada a dedo. Lo que falta para conectarla:
convertir la geometría del combate en un patrón de estimulación (un objeto que se
acerca en el mundo 2D → qué LC4 y qué LPLC2, por azimut) y leer DNp01 como el
disparo de `ToolId::Dash`.
