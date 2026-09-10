# La mosca

Simulación LIF sobre el conectoma MaleCNS v1.0. Sin nada del juego: esto es la
mosca sola, y tiene que poder validarse sola.

```
paso0.py       comprueba que la fase 1 es construible (datos, aristas, E/I, circuito)
red.py         el conectoma como matriz dispersa + el simulador LIF
sobresalto.py  el experimento: ¿la fibra gigante responde al looming?
piloto.py      la mosca maneja la esquiva del boss dentro del juego
oponente.py    el jugador guionado: rodea la cobertura, recupera el tiro y dispara
```

```bash
python fly/paso0.py --descargar    # 540 MB, bucket público, una sola vez
python fly/sobresalto.py           # ~2 min en CPU
python fly/piloto.py               # ~12 min: la mosca contra su control
python fly/piloto.py --grabar      # ~3 min: una pelea para verla en el navegador
./scripts/dev.sh                   # y abrir http://localhost:5173/?pelea=mosca
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

Escenario: boss quieto, y el oponente de `oponente.py` rodeando la cobertura
para dispararle el cañón. Control: **las mismas esquivas en ticks al azar.**

```
=== lazo abierto: ¿dispara cuando hay un tiro? ===
  900 ticks, 90 con proyectil encima (10.0%)
  la fibra gigante disparó en 40 ticks
  precisión 88%  ·  cobertura 39%  ·  lift 8.8x sobre el azar

=== lazo cerrado: ¿esquivar así sirve? ===
                        esquivas   daño recibido
  boss quieto                   0       110 ± 0
  esquiva la mosca             44        44 ± 0
  esquiva al azar              44        88 ± 0
```

Con el mismo número de esquivas, la mosca deja pasar la mitad del daño que el
azar. Cuando la fibra gigante dispara, 9 de cada 10 veces hay un proyectil
encima.

### El oponente importa tanto como la mosca

La primera versión de este experimento daba **0 de daño contra 60**, y era
mentira a favor de la mosca. El oponente caminaba en línea recta hacia el boss;
la primera esquiva lo dejaba detrás de una caja, el oponente se clavaba contra
ella sin visión, y no volvía a disparar en 750 ticks. Cualquier esquiva parecía
salvadora.

(Una explicación anterior de este README decía que el problema era que el
oponente apuntaba en 8 direcciones y no re-apuntaba. **Era falsa**: el motor fija
el cañón sobre el boss en cada disparo. El problema era la navegación.)

`oponente.py` lo arregla con BFS sobre una grilla de la arena: busca la celda más
cercana con tiro al boss y llega rodeando los muros. Y exige que el **tubo** del
proyectil esté despejado, no solo el rayo de visión del motor — sin eso se paraba
donde el rayo pasaba y le disparaba 700 ticks a la esquina de una caja (holgura
0,23 contra un proyectil de radio 0,3).

Con el oponente competente la precisión en lazo abierto sube de 10% a 88%. No es
que la mosca haya cambiado: es que el oponente viejo caminaba hacia el boss todo
el tiempo, y un cuerpo que se acerca también se expande en el campo visual. El
nuevo se para a disparar, y lo que se expande pasan a ser los proyectiles.

### Cómo leer esto sin engañarse

- **La resolución es baja.** El cañón tiene 3 s de enfriamiento, así que en 900
  ticks el oponente dispara unas cinco veces. "44 contra 88" son 2 impactos
  contra 4. El resultado es consistente —el mismo en las 4 semillas— pero es un
  conteo chico. Peleas de 3600 ticks lo afinarían, a cuatro veces el costo.
- **"± 0" en las 4 semillas no es una pelea repetida.** Cada semilla le da al
  oponente otra distancia de tiro preferida y cambia la trayectoria; lo que no
  cambia es el conteo de impactos, porque lo limita el enfriamiento del cañón.
- **La mosca decide *si*; hacia dónde es geometría.** La esquiva va siempre de
  costado a la línea de tiro.
- **La ganancia sensorial (10) se eligió barriendo** en lazo abierto: con 2,5 la
  fibra gigante se pierde el 80% de los tiros, con 20 dispara a todo.

### Verla

`python fly/piloto.py --grabar` juega una pelea con la mosca y la guarda en
`web/public/mosca.bin`. Antes de guardarla, el motor la re-simula desde cero y
comprueba que llega al mismo final: lo que se ve en el navegador es la pelea que
jugó la mosca, no una aproximación.

### Lo que falta

- **Retinotopía.** Todas las LC4 tienen campo receptivo derivable del conectoma
  —el centroide de las columnas que las alimentan, mediana 18 por neurona— así
  que el looming se puede inyectar por azimut en vez de a todas por igual. No
  hace falta para el escape, que no es direccional; sí para que la mosca
  *gire*.
- **Velocidad.** 900 ticks de mosca tardan ~2,5 minutos en CPU con esta
  ganancia. Para grabar peleas sueltas sobra; para generar miles, es donde entra
  la GPU.
