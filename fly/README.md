# La mosca

Simulación LIF sobre el conectoma MaleCNS v1.0. Sin nada del juego: esto es la
mosca sola, y tiene que poder validarse sola.

```
paso0.py       comprueba que la fase 1 es construible (datos, aristas, E/I, circuito)
red.py         el conectoma como matriz dispersa + el simulador LIF
sobresalto.py  el experimento: ¿la fibra gigante responde al looming?
piloto.py      la mosca maneja la esquiva del boss dentro del juego
ojo.py         la retina: a dónde mira cada fotorreceptor; columnas derivadas
ojo_flyvis.py  el ojo de flyvis mira los estímulos (corre en .venv-ojo)
acople.py      la salida de flyvis entra en MaleCNS y se mide LPLC2/LC4/DNp01
oponente.py    el jugador guionado: rodea la cobertura, recupera el tiro y dispara
patas.py       las motoneuronas de las patas, y si DNa02 y el tacto giran la marcha
cordon.py      el cordón ventral como modelo de tasas (Pugliese et al. 2025)
```

```bash
python fly/paso0.py --descargar    # 540 MB, bucket público, una sola vez
python fly/sobresalto.py           # ~2 min en CPU
python fly/piloto.py               # ~12 min: la mosca contra su control
python fly/patas.py                # ~30 min: ¿DNa02 y el tacto giran las patas?
python fly/piloto.py --andar       # ~25 min: camina, con el tacto cruzado de control
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

## Qué es esto y qué no: un reflejo, no aprendizaje

**La mosca no aprendió a esquivar. Nadie la entrenó.** Es un reflejo innato: el
conectoma es el escaneo del cerebro de una mosca adulta real, y ese cerebro ya
trae el circuito de escape armado. Una mosca esquiva un objeto que se le viene
encima sin haberlo aprendido nunca, igual que nadie aprende el reflejo de la
rodilla. Lo "entrenó" la evolución.

El cableado *es* el comportamiento, y no lo pusimos nosotros: lo leímos del
escaneo. Las dos entradas más fuertes a la fibra gigante son LC4 (6.362
sinapsis) y LPLC2 (4.862). Ninguna regla dice "si viene un proyectil, esquivá";
la respuesta sale de cómo está conectada la red, y por eso responde ~30 veces
más a LC4/LPLC2 que a otras 311 neuronas visuales al azar.

**Lo que pusimos a mano**, para no exagerar:

- **La señal entra ya masticada.** En la mosca real, los ojos y el lóbulo óptico
  calculan "algo se acerca" y recién ahí se activan LC4 y LPLC2. Acá el motor
  calcula el looming (`2rv/d²`) y lo inyecta directo en esas neuronas: nos
  salteamos el ojo. Es el atajo más grande del experimento.
- **La salida la mapeamos nosotros.** En la mosca, la fibra gigante activa los
  músculos del salto; acá, la esquiva del juego.
- **Tres números globales ajustados barriendo**: escala sináptica, ruido de fondo
  y ganancia de entrada. No neurona por neurona, pero elegidos por nosotros.
- **La dirección de la esquiva** es geometría, no la mosca.

**La parte incómoda.** Con todo eso junto, hoy el conectoma hace más o menos lo
que haría `if looming > umbral: esquivar()`. **No lo comparamos contra esa
regla**, y es probable que ella lo haga igual o mejor: usamos la única vía del
cerebro donde la respuesta llega casi directa desde la entrada, y las otras
164.000 neuronas no deciden nada. Lo demostrado es que la simulación y el enchufe
funcionan y que un reflejo real se transfiere a un juego; **no** que el cerebro
aporte algo que no aporte un `if`. Eso cambia cuando la decisión dependa de más
cerebro: la cadena visual completa, girar, o dos conductas compitiendo.

**Aprender de verdad** sería otra cosa: en la mosca ocurre sobre todo en el cuerpo
pedunculado (*mushroom body*), donde la dopamina cambia la fuerza de ciertas
sinapsis según si lo que pasó fue bueno o malo. Habría que implementar esa
plasticidad y conectarle la recompensa del juego a las dopaminérgicas. Y ni
siquiera en la mosca real el escape se aprende: si algo aprende, será qué
situaciones son peligrosas, no a esquivar.

**Pendiente:** la mosca contra la regla del `if`, con el mismo control de
esquivas al azar. Es lo que hay que saber antes de mostrarlo.

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

## Los ojos: primer intento, y dónde choca

El objetivo era quitar el atajo: que la luz entre por los fotorreceptores y que
el propio conectoma calcule "algo se acerca" hasta LC4, en vez de inyectárselo.

**Lo que hay en los datos.** 3.377 fotorreceptores R1-R6, pero 1.989 son
fragmentos sin una sola sinapsis de salida con peso ≥5: el ojo queda al borde
del volumen escaneado. El ojo efectivo son **1.382 fotorreceptores en 561
columnas** (el derecho al ~44%, el izquierdo al ~21%). No traen columna; la
heredan de la neurona de lámina a la que más le hablan (`ojo.py`). El camino
existe y es el de los libros: fotorreceptor → L1/L2/L3 (100.000+ sinapsis) →
médula → **LC4/LPLC2 a 3 saltos → DNp01 a 4.**

**Lo que pasa al simular.** Los fotorreceptores responden a la luz y la lámina se
enciende a oscuras. **Pero a LC4/LPLC2 no llega nada: 0 Hz** en toda
combinación probada. Se corta en la primera capa de la médula:

| | lámina (claro → oscuro) | Mi1/Tm3 | T4 | T5 | LC4/LPLC2 |
|---|---|---|---|---|---|
| modelo tal cual | 28 → 37 | 0 | 0 | 0 | **0** |
| + tono de reposo en el lóbulo óptico | 6,8 → 12,1 | 8,9 → 10,3 | ~1 | ~0,3 | **0** |

**Por qué, y no es un ajuste.** El sistema visual de la mosca calcula con
inversiones de signo por desinhibición: la luz apaga a L1 (glutamatérgica,
inhibidora), y L1 deja de frenar a Mi1, que se enciende. Eso funciona porque en
la mosca real esas neuronas son de voltaje graduado y siempre algo activas. En
nuestro modelo una neurona en reposo está callada, y a una neurona callada no se
la puede "dejar de frenar". Con un tono de reposo la desinhibición viaja un poco
más, pero se diluye capa a capa. Y la selectividad al looming necesita además
detectores de dirección (T4/T5) que dependen de dinámicas finas que un LIF
uniforme no tiene.

**Es un resultado conocido.** Lappalainen et al. (Nature, 2024) construyeron un
modelo del sistema visual de la mosca con la conectividad del conectoma y
encontraron que la conectividad sola no alcanza: los parámetros desconocidos
por neurona y por sinapsis hubo que ajustarlos entrenando la red en una tarea
(detectar movimiento). Con eso, el modelo predijo la separación ON/OFF y la
selectividad de dirección medidas en 26 estudios. Su código es `flyvis` (MIT).

**Conclusión del intento:** el reflejo del cerebro central funciona sin
entrenar porque es una vía corta de neuronas que disparan espigas. El lóbulo
óptico es otra clase de computadora, y no se deja simular con el mismo modelo.

## Verificación de `flyvis` como ojo (opción 2)

La idea: que `flyvis` —el modelo del sistema visual de Lappalainen et al.— haga
el ojo, y que su salida entre en nuestro conectoma, que sigue hasta LC4, LPLC2 y
la fibra gigante.

**Corre.** Solo soporta Python 3.9–3.12, así que va en su propio entorno
(`.venv-ojo`, Python 3.11, PyTorch solo-CPU; ojo que `pip install flyvis` trae
un `torchvision` que no casa con el torch de CPU y hay que alinearlo desde el
mismo índice). Pico de 1,4 GB de memoria, ~5 veces más lento que tiempo real a
pasos de 10 ms: sirve para grabar, no para jugar en vivo.

**Qué es:** 65 tipos celulares, 45.669 neuronas, retina hexagonal de 721
columnas, de los fotorreceptores hasta T4/T5. **Solo 734 parámetros entrenados**
(más 2.959 fijos): no se entrenaron sinapsis una por una sino unos pocos
números por tipo celular, y la conectividad es la del conectoma. La frase honesta
con este ojo: *ojos con un modelo entrenado del sistema visual real; del lóbulo
al escape, el cableado sin entrenar.*

**Selectividad de dirección: sí.** Bordes oscuros barriendo en cuatro
direcciones: T5a, b, c y d prefieren cuatro direcciones distintas, dos
horizontales opuestas y dos verticales opuestas, con hasta 4,4x de selectividad.

**Firma de looming en T4/T5: no concluyente.** Un índice radial (¿el movimiento
detectado va del centro hacia afuera?) da +0,38 al looming y −0,13 al que se
aleja en el modelo 000, pero en los modelos 001 y 002 un disco que solo se
desplaza da más que el looming. La primera versión de este test además tenía un
control mal hecho (el disco aparecía de golpe y pasaba más tiempo de un lado),
que inflaba justo lo que había que descartar. No es que `flyvis` falle: en la
mosca, la selectividad al looming la calcula LPLC2 con dendritas radiales e
inhibición lateral, y ese cableado está en MaleCNS, no en `flyvis`. Un índice
que suma movimiento es una medida demasiado cruda.

**Encaje con MaleCNS: estructuralmente sí.** 49 de los 65 tipos existen con el
mismo nombre (los demás son sobre todo diferencias de nomenclatura de
fotorreceptores). LPLC2 recibe el 55% de su entrada de tipos que `flyvis`
simula (T5a-d, T4c, Tm5Y, Tm20); LC4, el 60% (TmY3, T2, Tm4, Tm2, Tm3).

**Lo que falta para la prueba de verdad** —meter la salida de `flyvis` en las
LPLC2 de MaleCNS y ver si ellas y la fibra gigante distinguen el looming:

1. Emparejar columnas: las T4/T5/Tm de MaleCNS no traen columna; se derivan de
   sus entradas (Mi1 la tiene al 99%), igual que los fotorreceptores.
2. Alinear las dos grillas: se puede anclar con las propias etiquetas de
   dirección (T5a, b, c, d), que tienen el mismo significado en los dos modelos.
3. Acoplar: voltaje graduado de `flyvis` → corriente en la neurona homóloga del
   LIF, con una ganancia.
4. El experimento con los controles justos, como el del sobresalto.

## Ojos con `flyvis` + conectoma: el primer experimento

**Cómo se enchufan.** `flyvis` simula 49 tipos celulares del ojo derecho con
equivalente en MaleCNS; su respuesta sobre el reposo entra como corriente en las
neuronas homólogas (mismo tipo, misma columna): **21.976 neuronas**, que quedan
fijadas a lo que dice el ojo. De ahí en adelante manda el cableado de MaleCNS.
Cada pieza se validó sola antes de juntarlas:

- **Columnas.** Las T4/T5 de MaleCNS no traen columna; se derivan de sus
  vecinos sinápticos. Escondiendo la anotación de Mi1, Tm1 y Tm9, la derivación
  acierta la columna en el 98-100% (error mediano 0,07 columnas).
- **Orientación.** Las entradas T4/T5 de las 84 LPLC2 del ojo derecho forman una
  cruz: cada dirección de movimiento, desplazada hacia su lado (arriba y abajo
  opuestas a 178°, perpendiculares a adelante/atrás). Es el cableado radial del
  detector de looming (Klapoetke et al., 2017), recuperado solo con columnas
  derivadas, y ancla qué es arriba y qué es atrás. El mapa ajustado con dos
  direcciones predice la tercera con 2° de error; es casi una rotación pura.

**Resultado del primer intento: no pasa, pero el ojo funciona.** Con la tasa
promediada sobre 900 ms ningún grupo separaba el looming de los controles, y la
fibra gigante disparaba con cualquier cosa menos con el looming. Mirando la
respuesta en el tiempo (ganancia 6):

| ms | 200-500 | 500-800 | 800-950 | 950-1100 (choque) |
|---|---|---|---|---|
| LPLC2 | 0,4 | 0,5 | 6,2 | 10,8 |
| LC4 | 0,1 | 0,7 | 8,2 | 43,0 |
| DNp01 | 1,7 | 0 | 0 | 0 |

LPLC2 y LC4 hacen exactamente lo que hacen en la mosca: callados mientras el
objeto está lejos y cada vez más fuertes a medida que se acerca. El promedio lo
escondía, porque todo pasa en los últimos 250 ms.

**Por qué la fibra gigante no responde: inhibición.** Durante el looming le
llegan 72.704 de excitación (de LC4 y LPLC2) y 351.445 de inhibición, desde
GNG300, SAD073, LHAD1g1, IN12B015 y CL367 — GABAérgicas, con confianza 0,81-0,89
en la predicción de neurotransmisor. No es un error de la regla "glutamato
inhibe": esa inhibición existe en el cableado real. Al final del looming el
campo visual entero se oscurece, eso excita a medio cerebro central, y las vías
inhibidoras que convergen sobre la fibra gigante le ganan a LC4. Es la lección de
la fase 1 otra vez, ahora a la salida: en la fase 1 solo se estimulaban 311
neuronas y el resto del cerebro no se enteraba; con ojos de verdad se entera
todo, y los parámetros calibrados entonces no alcanzan. **Lo que falta no es la
inhibición sino su fuerza y su momento, que el cableado no trae.**

**Dos controles estaban mal**, y los dos a favor de algo que no era el looming:
"se aleja" arrancaba con un disco que tapaba el ojo entero y se achicaba rápido
(disparaba a LC4 a 57 Hz por el golpe de luz), y la medida promediada diluía el
looming. Corregidos: "se aleja" arranca en radio 6 y ya presente, y la medida
pasa a ser el pico en cualquier ventana de 250 ms.

**Decisión: la salida pasa a ser LPLC2/LC4**, no la fibra gigante. Es lo que se
puede afirmar sin exagerar —*los detectores de looming de la mosca, con ojos de
verdad, deciden la esquiva*— y aprovecha la parte que funciona. Entrenar los
parámetros del cerebro central contra la tarea de escapar, como `flyvis` hizo con
la visión, queda como el proyecto de fondo.

### Con los controles corregidos: LPLC2 pasa, LC4 no

Pico en Hz en cualquier ventana de 250 ms (`python fly/acople.py`):

| ganancia | estímulo | LPLC2 | LC4 | DNp01 |
|---|---|---|---|---|
| 3 | **looming** | **3,4** | 5,0 | 2 |
| 3 | se aleja | 0,7 | 11,8 | 52 |
| 3 | desplaza al centro | 0,4 | 1,4 | 4 |
| 3 | desplaza arriba | 1,0 | 1,5 | 0 |
| 3 | oscurece | 1,5 | 3,1 | 0 |
| 6 | **looming** | **9,9** | 29,7 | 2 |
| 6 | se aleja | 3,6 | 20,1 | 98 |
| 6 | desplaza al centro | 3,6 | 17,7 | 86 |
| 6 | desplaza arriba | 3,9 | 9,6 | 8 |
| 6 | oscurece | 4,8 | 18,1 | 0 |

A ganancia 1,5 no se mueve nada: el ojo no alcanza a empujar al conectoma.

- **LPLC2 separa el looming de los cuatro controles**, a ganancia 3 (2,3× el mejor
  control) y a 6 (2,1×). Le gana incluso a "oscurece", que tiene la misma
  cantidad de oscuridad sin forma ni movimiento. Es el resultado que se buscaba, y
  cuadra con la biología: LPLC2 es el detector de looming selectivo (Klapoetke et
  al., 2017).
- **LC4 no es selectivo.** Responde casi igual a oscurecer, a alejarse y a
  desplazarse. No sirve como salida.
- **La fibra gigante hace lo contrario que en la mosca**: se dispara con lo que se
  aleja y con lo que pasa por delante (52-98 Hz) y se queda callada con el looming.
  Es la inhibición de más arriba; se mide pero no decide.

**Cómo leer esto sin engañarse.** Es una sola semilla, y el margen es justo: el
criterio pide 2× y LPLC2 da 2,1-2,3×. Hay además un sesgo conocido en "se aleja":
los primeros 200 ms el disco está quieto, y como el acople mide sobre el reposo en
gris, las células tónicas del ojo (L2, Tm5b, TmY4, Mi9) empujan todo ese rato
aunque nada se mueva. No se comprobó si eso es lo que dispara a LC4 y a la fibra
gigante en ese control.

**La salida es LPLC2, sola.** Para cablearla a la esquiva falta lo que el
experimento no tiene: dibujar el mundo del juego en la retina de `flyvis` (hoy los
estímulos son discos sintéticos) y fijar un umbral de LPLC2 entre el mejor control
y el looming.

## Las patas: la mosca camina

MaleCNS no es solo el cerebro: trae el cordón ventral, que en la mosca hace lo
que la médula espinal, con **381 motoneuronas de pata** anotadas por pata
(delantera, media, trasera) y lado. El boss camina leyéndolas a ellas, no a las
descendentes: lo que lo mueve es lo que llega a los músculos.

```
lo que ve → red → cordón ventral → motoneuronas de las seis patas → avance y giro
lo que toca → sensores táctiles de las patas ↗
```

**La lectura (`piloto.py`) es tracción diferencial.** Cada lado empuja en
proporción a lo que disparan sus motoneuronas en el tick: la suma da la
velocidad (el boss camina esa fracción de los ticks) y la diferencia gira el
rumbo. Es la simplificación grande: ni marcha, ni fases de apoyo y vuelo, ni
flexores contra extensores. Cada pata es "cuánto empuja".

**Lo que pusimos a mano:**

- `GIRO`, `PASO`: cuánto gira una asimetría y cuántos disparos valen un paso.
  `GIRO` está anclado a DNa02 (su efecto medido gira ~75°/s, el orden de una
  mosca caminando).
- `CERO`: a la asimetría se le resta su promedio de los últimos 2 s. El LIF sin
  calibrar tiene un sesgo de lado —en una pelea las patas derechas empujaban
  +0,046 todo el tiempo, en otra semilla al revés— y sin quitarlo el boss daba
  vueltas en un solo sentido (98% antihorario). Se come también una orden de
  giro sostenida más de 2 s.
- **Nadie le ordena caminar.** La primera versión encendía la marcha con
  corriente en DNg100 (BDN2). El control sin ella dio lo mismo: 46 disparos de
  pata por tick con y sin. Las patas las despierta la red entera cuando el
  jugador se acerca; la corriente solo las adelantaba 14 ticks. Se quitó.
- `ALCANCE`, `TACTO`: desde qué distancia toca una pata la pared, y cuánta
  corriente es un toque (la de `patas.py`, que lleva a los sensores a ~25 Hz).

### El giro está en el cableado

| entrada | a un salto | a dos saltos |
|---|---|---|
| DNa02 izquierda | solo patas izquierdas | inhibe las izquierdas, excita las derechas |
| tacto, pata media izquierda | 765 sinapsis a su pata | 481k/462k a las izquierdas contra 39k/48k a las derechas |
| MDN (caminar hacia atrás) | casi nada | sobre todo patas traseras (288k contra 87k delanteras) |

Las tres coinciden con lo que se sabe de la mosca. DNa02 es como gira un insecto
(las patas de adentro frenan); el tacto sería un reflejo de evitación (pared a la
izquierda → empujan las izquierdas → se aparta).

### DNa02 no sobrevive a la simulación; el tacto sí, por poco

`patas.py` pone la marcha, estimula la entrada por un lado y después por el otro
—pareado por semilla, 12 semillas— y compara con pares bilaterales de
descendentes al azar. Criterio fijado antes de ver los números: t > 2,5 y por
encima de la media de cualquier control.

```
          s0     s1     s2     s3     s4     s5     s6     s7     s8     s9     s10    s11      media
DNa02      +0.9   +0.2   +2.2   +0.0   -1.4   +1.9   -0.0   +0.9   -0.6   +1.8   -0.0   -0.8   +0.43
tacto      -1.2   -0.6   -0.6   +0.7   -1.6   +0.6   +0.4   -3.3   -0.6   -2.0   -1.2   -2.3   -0.98
DNg56      -1.5   -0.1   +0.1   +0.1   +0.4   +0.8   +0.0   +0.3   -0.7   -0.5   -0.9   +1.7   -0.03
DNge062    -0.5   +0.5   -0.9   -0.4   -0.4   -0.8   -0.1   +0.1   -0.3   +0.4   -0.6   +1.0   -0.17
DNp55      +1.2   -0.1   +0.3   -0.1   -1.0   +0.8   +0.4   +0.9   -1.5   +0.6   -0.1   +0.2   +0.13
DNge129    +0.1   -0.1   -0.2   +0.0   -0.0   -0.2   -1.0   +0.6   +0.5   -1.0   +0.2   -0.1   -0.10

  controles: |media| hasta 0.17 Hz
  DNa02: +0.43 Hz con el signo del cableado, t = 1.3 · A MEDIAS: el signo del cableado, pero no se separa del ruido
  tacto: +0.98 Hz con el signo del cableado, t = 2.8 · PASA: gira como predice el cableado, y una descendente cualquiera no
```

**Con 6 semillas el tacto no pasaba** (−0,44, t = 1,1) y la primera versión del
criterio le había dado un PASA a DNa02 con t = 1,3. Las dos cosas están
documentadas en el código porque son el tipo de error que se repite.

**Por qué DNa02 se pierde y el tacto apenas pasa.** A escala 0.03, los 369
sensores táctiles de una pata a 25 Hz le dan a cada motoneurona de esa pata
~0,05 de corriente, con el umbral en 1: la vía directa es veinte veces demasiado
débil. Lo que mueve las patas es la red entera encendiéndose en bloque —pasan de
2 a 6 Hz según la semilla— y ese modo global tapa casi todo lo que viene de un
solo lado. El tacto son ~900 sensores por lado y sesga ese modo lo justo; DNa02
son dos neuronas. La fibra gigante funciona porque recibe miles de sinapsis de
LC4 y LPLC2; ninguna vía de pata tiene eso.

**Subirle la ganancia al cordón ventral lo empeora.** Multiplicando sus sinapsis
por 3, se enciende solo (14 Hz en las patas sin estímulo) y los contrastes pasan
a ±10 Hz de ruido; por 10, convulsiona (82 Hz sin nada). No es un problema de
ganancia sino de modelo: es la misma pared que el lóbulo óptico. Muchas
premotoras del cordón ventral son de voltaje graduado, sin espigas, y un LIF
uniforme no las representa.

### En el juego: el tacto la aparta de las paredes

El tacto entra por los 16 rayos que el motor ya pone en la observación, igual que
el looming: el motor da la geometría, las neuronas deciden. Cada rayo que ve una
pared a menos de `ALCANCE` (1,4: el radio del boss más el largo de una pata)
excita los sensores táctiles de las patas de ese lado, con la corriente con la
que pasó `patas.py`. El control es el **tacto cruzado**: la pared de la derecha
entrando por los sensores de la izquierda. Si apartarse es del cableado, cruzado
tiene que pegarla más a la pared, no menos.

`python fly/piloto.py --andar`, 900 ticks contra el oponente, dos peleas:

```
=== patas: ¿camina? ===
                pelea  se mueve  recorrió  arena  contra pared  giro °/s  esquivas
  tacto            1       95%        63    21%           36%        42        19
  tacto            2       97%        61    20%           32%        38        14
  cruzado          1       72%        31     8%           79%        37        21
  cruzado          2       81%        37    13%           72%        52        29
  sin tacto        1       86%        48    16%           79%        35        21
  sin tacto        2       90%        45    16%           72%        40        23
```

**Con el tacto como está cableado pasa un tercio del tiempo contra la pared;
sin tacto, o con el tacto cruzado, tres cuartos.** Cruzado no la pega más que
sin tacto —estar contra la pared ya es el techo—, pero no la aparta: lo que la
aparta es que la pared entre por el lado correcto. Recorre más y ve más arena
porque no se queda deslizando contra un borde.

**Anticipar el toque no la aparta más.** Con `ALCANCE` 2 y 3 (la pata "llega"
más lejos) el tacto sigue en un tercio del tiempo contra la pared (44/24% y
35/38%, contra 79% cruzado): el tacto satura ahí, toque cuando toque.

**En las peleas grabadas, esquivar paredes es mecánico** (`piloto.virar`): con
pared a menos de 3 por delante, el rumbo gira hacia donde los rayos ven más
sitio libre. Pasa del 32-36% del tiempo contra la pared al 0-2%. **No es la
mosca**: es para que el juego se vea bien, se enciende solo con
`Piloto(grabar=True)`, y los experimentos de este README la miden sin él. Se
quita cuando el tacto, los ojos o `cerebro.py` la aparten solos.

Dos peleas por condición: el tamaño del efecto es incierto. Una versión anterior
con los lados espejados (izquierda y derecha del motor al revés que el render)
dio 58% contra 68% en las mismas peleas: misma dirección, efecto mucho menor.

**Camina, y lo que la mueve son sus motoneuronas.** Pero hay que decir qué es:
fuera del tacto, **los giros son ruido del cordón ventral, no decisiones.** Lejos
de las paredes nada dirige el rumbo —DNa02 no sobrevive— y es un paseo al azar
con la estadística de la red. (Las moscas reales pasan casi todo el tiempo en los
bordes de una arena, y la nuestra también; la diferencia es que la real lo busca.)

**En el navegador se dibuja caminando** (`web/src/mosca.ts`): apoyada en el
suelo, en trípode, con las alas plegadas y quietas, y solo despega en la
esquiva. **El paso dibujado es cosmético**: el motor no sabe de patas, y el
dibujo no lee las motoneuronas. Avanza con lo que se movió el cuerpo, que sí
sale de ellas.

**Los ojos** llegan a las patas en `ojo_juego.Mosca`: los dos ojos por `flyvis`,
el conectoma, y las mismas patas, tacto y lectura de `Piloto`. Su experimento de
paredes (con ojos, ciega, ojos cruzados) está en ese archivo.

### El cordón ventral con tasas (`cordon.py`)

Pugliese et al. (2025) simularon el cordón ventral de cuatro conectomas,
MaleCNS incluido, y DNg100 hizo caminar a las patas desde un circuito de tres
neuronas (E1 IN17A001, E2 INXXX466, I1 IN16B036). Usaron **tasas, no espigas**,
porque las premotoras del cordón son de voltaje graduado: la misma pared que se
sospechaba acá. `cordon.py` es su modelo, con sus parámetros sorteados y su
subred (motoneuronas de pata, sus premotoras, y las descendentes que les
hablan), escalados por el volumen de cada neurona.

Tres cosas hicieron falta, las tres medidas antes de corregirlas:

- **El volumen de cada neurona.** Sin él no hay ritmo (lo dicen ellos y acá
  tampoco lo había). No está en los archivos planos: sale de la tabla de
  neuronas de neuPrint del bucket público.
- **Descendentes como entradas puras.** `red.W` suma las sinapsis de todo el
  sistema nervioso, y descendente↔ascendente en el cerebro cerraba bucles que el
  cordón no tiene: cualquier descendente prendía 1.100 de 3.166 neuronas.
- Un error mío que aplanaba las trazas (vistas de numpy en vez de copias):
  durante dos corridas todo dio ritmo 0.

**El ritmo se reproduce a medias.** El núcleo de tres neuronas solo oscila en 16
de 16 réplicas. Con la subred entera, DNg100 hace oscilar a las patas en las 6
réplicas (ritmo 0,47-0,79) **a 8-11 Hz**, la frecuencia de paso de la mosca.
Pero no es especial: de 295 tipos de descendente queda en el puesto 45, y el
21% supera 0,5 contra el 3,4% del paper. Nuestra red oscila demasiado fácil;
ellos ajustaban la corriente por réplica y tenían más premotoras (4.310
neuronas contra 3.166; las sin tipo son solo el 1% de la entrada a las
motoneuronas, así que no es eso).

**DNa02 llega a las patas**, lo que en el LIF nunca pasó
(`python fly/cordon.py --giro`, el experimento de `patas.py`, 12 semillas):

```
controles: |media| hasta 0.04 Hz
DNa02: −1,81 Hz, t = −21,8 (12 de 12)      LIF: +0,43, t = 1,3
tacto: −3,79 Hz, t = −3,0                  LIF: +0,98, t = 2,8
```

Los dos llegan con el signo contrario al que suponía `patas.py`: activar un lado
prende más las motoneuronas de ese lado. "Más actividad" no es "empuja más"
—son flexores y extensores, apoyo y vuelo—, así que el signo de la lectura hay
que anclarlo en algo conocido. El ancla natural es DNa02, que en la mosca gira
hacia su lado (Rayshubskiy et al. 2020). Con esa ancla, el tacto la aparta de la
pared.

**Por qué todavía no está en el juego.** Dos cosas, medidas:

- **El cerebro no manda la marcha.** En la pelea grabada, DNg100, DNa02 y DNa01
  están en 0 Hz, y MDN (caminar hacia atrás) dispara a 23 Hz de un solo lado.
  Pasarle al cordón las descendentes como salen del LIF le rompe el ritmo
  (0,13-0,32) y deja las patas tónicas a 12-21 Hz, con o sin DNg100. Lo que
  falta ahora está arriba: el LIF del cerebro central no da las órdenes.
- **El tacto no es un reflejo limpio, es un interruptor.** Con la marcha puesta,
  un toque de 1 Hz la gira *hacia* la pared (6 de 6 semillas); desde 2 Hz el
  cordón entero salta a un estado 50 veces más activo y ahí sí la aparta, más
  cuanto más fuerte (t 2,4 a 10). Llevarlo así al juego sería elegir la perilla
  que dé.

**El sistema nervioso entero en tasas, sin entrenar, tampoco.** Las 164.506
neuronas corren (400 ms en ~27 s) y el tacto llega al cerebro del lado correcto
—tocar a la izquierda le da a DNa01 derecha 185 de entrada contra 36 a la
izquierda—, pero el escalado por tamaño contra la mediana de *todas* las
neuronas, que bajan las 89.000 diminutas del lóbulo óptico, deja a las
descendentes con umbrales de 300-700. Barriendo esa referencia hay un
precipicio: a 1× el cerebro está mudo y DNg100 ni mueve las patas; desde 2× se
prenden 37-47 mil neuronas, el lóbulo óptico se enciende a oscuras, y DNa02
responde pero no según el lado. Es la franja estrecha del LIF otra vez: un
número global no alcanza.

### La mosca espinal (`python fly/piloto.py --grabar --espinal`)

Las patas las mueve el cordón de tasas (`cordon.Espinal`), con la marcha puesta
y el tacto por sus sensores; las descendentes del LIF no entran, porque le
rompen el ritmo. El cerebro sigue decidiendo la esquiva. Giro anclado en DNa02
(una DNa02 sola ≈ 75°/s), valores fijados antes de la primera pelea:

```
             contra pared   giro
tacto         53% / 39%     10°/s
cruzado       56% / 39%     9-14°/s
```

**Camina, y no se aparta.** El tacto espinal no se distingue de su control
cruzado, y casi no gira: anclado en DNa02, el efecto del tacto en el cordón es
chico. Se ve en el navegador en `?pelea=espinal`.

### Lo que falta

- **Que el cerebro central mande las descendentes correctas** (DNg100 al
  caminar, DNa02 al girar). Es el mismo trabajo que `flyvis` hizo con el ojo:
  parámetros por tipo celular entrenados contra una tarea. Con el cordón de
  tasas, lo de abajo ya transmite.
- **Parámetros por tipo celular en el cordón ventral**, entrenados como los de
  `flyvis` en el lóbulo óptico. Es lo que haría falta para que DNa02 llegue a
  las patas por su vía y no por el modo global, y para que el tacto pase con
  holgura en vez de por poco.
- **Un cuerpo** (NeuroMechFly): de "cuánto empuja cada lado" a músculos,
  articulaciones y marcha.
- **Las alas**: 67 motoneuronas de ala, con los músculos de potencia (DLM, DVM).
  Con la red encendida disparan a 40-60 Hz, sin que nada lo pida.
