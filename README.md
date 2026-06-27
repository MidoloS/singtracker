# singimprove

App local para practicar canto sobre canciones reales y medir si vas
mejorando. Subís un MP3, te separa la voz del artista con Demucs, te muestra
la melodía como carril estilo karaoke, te escucha por el micrófono mientras
cantás y al final te da un reporte con tu afinación, rango vocal y un
historial filtrable por fecha.

Todo corre en tu máquina. No hay cuenta, no hay cloud, no hay tracking.

---

## Qué hace

1. **Subís cualquier MP3.** El server local lo procesa una vez con Demucs
   (separación de voz) + pyin (extracción de F0) y cachea el resultado por
   hash. Volver a subir la misma canción es instantáneo.
2. **Cantás sobre la canción.** En el browser ves un carril con las notas
   objetivo desplazándose hacia una línea de "ahora" y un cursor de tu voz
   en tiempo real (verde si afinás, rojo si te vas). Comparación
   octava-invariante: podés cantar en tu octava cómoda.
3. **Reporte al cortar.** Calcula afinación (% notas dentro de ±50¢), error
   mediano en cents, tendencia (alto/bajo), techo y piso sostenidos, y
   extensión total de tu voz en esa toma. Muestra un canvas overview
   scrollable con tu performance contra la referencia.
4. **Escuchás tu take.** Mixer con sliders para bajar la voz del artista y
   subir/bajar tu grabación. Te permite A/B entre el original y vos.
5. **Historial en SQLite.** Cada sesión se guarda automáticamente. Hay dos
   paneles filtrables por fecha:
   - **General**: agregadas de todas las canciones, sparklines de
     afinación y techo sostenido a lo largo del tiempo.
   - **Por canción**: progresión específica en una canción.

---

## Cómo se ejecuta

### Requisitos

- Python 3.10+
- Node 20+
- `pnpm` (o `npm` con cambios obvios)
- `ffmpeg` en el PATH
- ~3 GB libres en disco para los modelos de Demucs y el cache de WAVs

### Instalar

```bash
# Python (server + análisis con Demucs/pyin)
pip install --user \
    fastapi 'uvicorn[standard]' python-multipart \
    demucs torch torchaudio torchcrepe librosa soundfile numpy scipy

# Front
cd web && pnpm install && cd ..
```

### Correr (2 terminales)

```bash
# Terminal 1 — server local (FastAPI en :8765, SQLite + cache en .cache/)
python3 -m server.local_server

# Terminal 2 — front (Vite en :5173)
cd web && pnpm dev
```

Abrí **http://127.0.0.1:5173/**. La primera vez que subís una canción tarda
2-4 minutos (Demucs sobre CPU). Reaparece en milisegundos las próximas veces
gracias al cache (`.cache/<sha1>/`).

---

## En qué se diferencia de UltraStar Deluxe (o cualquier karaoke clásico)

| | UltraStar / SingStar / etc. | singimprove |
|---|---|---|
| **Catálogo** | Necesita archivos `.txt` con notas pre-autoradas por canción (alguien tiene que sentarse a marcar a mano). | Aceptás cualquier MP3. El pipeline (Demucs → pyin → cuantización) genera el carril solo. |
| **Score** | Puntaje grueso al final (oro/plata/bronce). Pensado como juego. | Reporte analítico: % de notas dentro de ±50¢, error mediano en cents, tendencia alto/bajo, rango sostenido, extensión total. |
| **Progresión** | No la mide. Cada partida es un evento aislado (o un highscore por canción). | Historial SQLite local, filtrable por fecha, con sparklines por canción y agregadas: la pregunta que responde es *"¿estoy mejorando?"*. |
| **Reproducción posterior** | No mezcla tu voz con el instrumental. | Mixer post-take con slider para bajar la voz del artista (instrumental = original − vocals separadas por Demucs) y otro para tu grabación. Podés A/B en el momento. |
| **Comparación de tono** | Estricta, exige clavar la octava de la melodía. | Octava-invariante: si la canción es para barítono y vos sos tenor, cantás en tu octava sin penalización. |
| **Foco** | Juego social / fiesta. | Herramienta de práctica individual. Sin combos, sin multijugador, sin gamificación. |
| **Dependencias** | Compilado nativo + librería de canciones a descargar aparte. | Server Python + SPA Preact. Sin cuentas, sin cloud, sin instalación pesada del cliente. |

**Resumen:** UltraStar es un juego de karaoke; singimprove es un *coach* que
mide tu interpretación cuantitativamente sobre cualquier canción y te muestra
si estás progresando con el tiempo.

---

## Estructura

```
.
├── server/                 # FastAPI local
│   ├── local_server.py     # endpoints: /jobs, /audio, /sessions, /stats
│   ├── db.py               # SQLite (.cache/sessions.db)
│   └── requirements.txt
├── web/                    # Preact + Vite + TS
│   └── src/
│       ├── app.tsx         # estados: idle → uploading → processing → ready → playing → done
│       ├── pitch.ts        # YIN para el mic en vivo (pitchy)
│       ├── renderer.ts     # carril karaoke en Canvas 2D
│       ├── overview.ts     # canvas full-song scrollable del reporte
│       ├── mixer.ts        # Web Audio: instrumental + vocals*(1-atten) + tu voz
│       ├── report.ts       # métricas locales (afinación, rango, etc.)
│       ├── history.ts      # cliente del server
│       └── historyView.tsx # vistas General / Por canción + filtros de fecha
├── script.py               # motor original: Demucs + extracción de F0 + cuantización
├── worker_job.py           # entrypoint del job en cloud (no usado en local)
├── api.py                  # API que dispara el job en cloud (no usada en local)
└── .cache/                 # gitignored: stems, notes.json, sessions.db
```

El server local (`server/local_server.py`) envuelve a `script.run_preprocess`,
así que la lógica pesada vive en `script.py` y no se duplica.

---

## Limitaciones conocidas

- **Demucs en CPU es lento** (2-4 min por canción de 3-4 min). Si tenés GPU
  CUDA, `torch` la usa solo.
- **El mic se graba con `MediaRecorder`** (opus/webm). La latencia
  audio-in/audio-out del browser puede meter un desfase de unas pocas
  decenas de ms entre lo que cantás y lo que ves en el carril. No se
  compensa automáticamente.
- **Auriculares recomendados**: si la canción sale por parlante, el mic la
  pisca y el detector se confunde.
- **No hay análisis de vibrato, dinámica o timing** en el reporte. Esas
  métricas requieren análisis fino sobre la grabación completa server-side
  y todavía no están cableadas.
