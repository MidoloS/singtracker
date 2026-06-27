# README — App de práctica de canto (nombre tentativo)

Práctica de canto canción-específica: cantás un tema sobre la voz real del artista,
ves en tiempo real qué tan cerca estás de cada nota, y al terminar recibís un
reporte preciso (afinación, rango, vibrato, dinámica) que podés compartir.

> **Diferencial.** No es otro afinador de escalas ni karaoke con puntaje grueso.
> Mide tu interpretación contra la **voz real de la canción que elegiste**, con
> precisión a nivel de cents, y te dice exactamente dónde te vas de tono y hasta
> dónde llega tu voz.

---

## 1. Principio de diseño

El sistema tiene **dos fases con propósitos distintos**, y no hay que mezclarlas:

- **En vivo = guía en el momento.** Mientras cantás, tu atención para mirar la
  pantalla es casi nula (respirás, afinás, leés la letra). La vista en vivo
  muestra **una sola cosa de un vistazo**: la nota que viene y qué tan encima
  estás. Nada analítico.
- **Reporte = diagnóstico.** Toda la riqueza (rango, vibrato, tendencias, gráficos
  detallados, coaching) va al final, que es cuando el usuario tiene cabeza para
  absorberla.

Además, un split técnico clave:

- **La canción se preprocesa una sola vez** (separación de voz + análisis) y se
  **cachea**. No se procesa en vivo.
- **Tu voz se detecta en vivo en el navegador** (client-side). La referencia ya
  está precalculada; las dos se dibujan sincronizadas contra el reloj de
  reproducción del tema. Por eso en la vista en vivo **no hace falta alinear
  (DTW)**: cantás sobre el tema que suena, ya está sincronizado.

---

## 2. Flujo del usuario (v1)

1. **Cargar un MP3.** El usuario sube la canción que quiere cantar.
2. **Procesamiento con barra de carga.** Se separa la voz del artista y se analiza.
   - La barra **estima ~4 minutos** (conservador). Si el proceso real termina antes
     (~2 min típico), la barra **completa rápido hasta el 100%**. Estimar largo y
     entregar rápido = sorpresa agradable, nunca al revés.
3. **Preparación.** Aparece un texto **"Preparate para cantar"** + cuenta regresiva,
   y arranca la canción **con la voz del artista** sonando.
4. **Vista en vivo.** Se muestra el gráfico en tiempo real de ambas voces (ver §3):
   la línea objetivo del artista y tu voz, con feedback de qué tan cerca de las
   notas estás.
5. **Corte.** El tema corre hasta el final, pero el usuario puede **cortar antes con
   un botón**.
6. **Reporte.** Al terminar (o cortar), se genera el reporte (ver §4).
7. **Compartir.** El reporte se puede **compartir fácil con amigos** (link / tarjeta).

---

## 3. Vista en vivo — especificación

**Gráfico elegido: carril de notas (estilo karaoke / Guitar Hero).** No una línea de
frecuencia cruda. Es espacial e instantáneo: el usuario no lee números, "empareja
alturas".

- **Notas objetivo**: barras horizontales que **scrollean hacia una línea fija de
  "ahora"**. Cada barra está a la altura de su nota y dura lo que dura la nota.
- **Tu voz**: un cursor/puntito en vivo que tratás de mantener **sobre** la barra
  actual. Arriba = vas alto, abajo = vas calado, encima = clavado.
- **Color**: verde si estás dentro de la tolerancia, rojo si te fuiste.
- **Anticipación**: se muestran **las notas que vienen** a la derecha del "ahora"
  (la canción es conocida → conocemos el futuro). Enseña fraseo y preparación.
- **Eje vertical en semitonos**, no en Hz (distancias perceptualmente parejas).
- **Octava-invariante**: la vista se centra en la nota objetivo ±1 octava (o pliega
  octavas). Si el usuario canta en una octava más cómoda, su cursor igual cae cerca
  del carril en vez de irse de pantalla.
- **Tolerancia generosa en vivo**: la zona verde es ancha. En el momento hay que
  alentar, no mostrar un semáforo en rojo permanente. La crítica precisa va al
  reporte, no mientras canta.
- **Timing implícito**: si tu cursor enciende la barra cuando llega al "ahora",
  entraste a tiempo. No necesita su propio gráfico en vivo.
- **Indicador minimalista de "cómo vengo"**: un score corriendo / racha / halo que
  brilla cuando estás afinado. Nada más.
- **Dinámica (opcional, secundario)**: el grosor o brillo del cursor puede codificar
  el volumen.

**Objetivo limpio.** El carril NO usa la voz cruda separada (que trae artefactos y
saltos de octava del detector). Usa una **partitura de notas cuantizada** derivada
del preprocesado (notas snappeadas a la tonalidad). La voz cruda se guarda aparte
para el análisis fino del reporte.

---

## 4. El reporte — especificación

Se genera al finalizar el tema o al cortar. Contiene:

- **Afinación (octava-invariante)**:
  - % de notas afinadas (dentro de ±50 cents), priorizando **notas sostenidas**
    (sin contar las transiciones, que no son notas).
  - Error mediano en cents.
  - Tendencia: si tirás alto (sostenido) o bajo (calado).
- **Rango (tu voz real)**:
  - Nota más aguda **sostenida** (tu techo firme) ← dato estrella.
  - Piso y extensión total.
- **Vibrato** (si se detecta con claridad): velocidad (Hz) y amplitud (cents).
- **Dinámica**: qué tan bien seguís los subes y bajas de volumen del original.
- **Tiempo** (aproximado): qué tan sincronizado estuviste. Etiquetado como
  aproximado; es el eje más difícil de medir.
- **Gráficos detallados**: las dos melodías superpuestas + tu afinación coloreada
  por acierto (verde→rojo) + tu rango.
- **Coaching (tutor IA)**: traduce los números a feedback accionable. El feedback
  básico se arma con reglas sobre las métricas (gratis); la explicación profunda /
  ejercicios se piden **on-demand** a un LLM (control de costo, ver §6).

---

## 5. Compartir

- **Link compartible**: una página pública de solo-lectura con el reporte.
- **Tarjeta para redes**: una imagen con lo destacado (score, % afinación, nota
  máxima alcanzada) para mandar a amigos / postear.
- **Privacidad**: se comparten **las métricas y el gráfico, no el audio** de la
  grabación.

---

## 6. Arquitectura técnica (resumen)

| Pieza | Dónde | Notas |
|---|---|---|
| Frontend | Cloudflare Pages (SPA estática) | Casi gratis. |
| Storage | Cloudflare R2 | Sin egress. MP3 temporal + resultados; **borrar uploads tras procesar**. |
| Worker pesado | Cloud Run (CPU, scale-to-zero) | Corre Demucs + extracción de pitch (el script de análisis actual). **1 vez por canción, cacheado**. |
| Job | Asíncrono | subir → encolar → procesar → resultado en storage → el front consulta (polling/webhook). El proceso tarda minutos, **no** es un request sincrónico. |
| Detección en vivo | Navegador (Web Audio API / YIN, causal y liviano) | Client-side, **gratis** en el equipo del usuario. NO pyin/CREPE (esos son batch/pesados). |

**Preprocesado de la referencia**: separación con Demucs → extracción de F0 → limpieza
(compuerta de silencio, filtro de mediana, manejo de octava) → cuantización a
partitura limpia para el objetivo en vivo + voz cruda para el reporte fino.

**Costo**: ~centavos por análisis (Demucs cacheado + free tier), **cero en idle**.
La única línea que escala lineal con el uso es el **tutor IA** → llamarlo on-demand,
no en cada sesión.

---

## 7. Requisitos no funcionales / consideraciones

- **Latencia en vivo**: decenas de milisegundos (suficiente para cantar).
- **Auriculares recomendados**: si la canción sale por parlante, se cuela en el mic.
  Con auriculares, tu voz queda limpia.
- **Octava cómoda permitida**: la invariancia de octava deja que cantes en tu
  registro sin penalización; eso es una decisión, no un error.
- **Privacidad**: borrar el audio subido tras procesar; no se comparte la grabación.
- **Licencias / copyright** (riesgo a evaluar antes de escalar): separar voces de
  grabaciones comerciales tiene implicancias legales. Apoyarse en audio que sube el
  usuario corre parte del riesgo a un costado, pero hay que mirarlo antes de crecer.

---

## 8. Futuro (post-v1)

- **Cuentas de usuario + historial**: guardar todas las sesiones.
- **Progreso en el tiempo**:
  - Nota máxima alcanzada (evolución del techo).
  - Mejora por canción específica (% de afinación a lo largo de las tomas).
  - Rachas, comparación entre tomas de la misma canción.
- **Tutor IA más profundo**: planes de práctica adaptativos, ejercicios por debilidad.
- **Biblioteca de partituras**: posibilidad de consumir charts ya existentes
  (formato UltraStar) como objetivos limpios y listos, ahorrándose la separación
  cuando ya hay chart.

---

## 9. Fuera de alcance (v1)

- Cuentas de usuario / login / historial (es post-v1).
- Multijugador / social en vivo.
- Catálogo licenciado de canciones (v1 trabaja con MP3 que sube el usuario).
- Detección en vivo de la voz del artista (no se necesita: la referencia se
  precalcula).

