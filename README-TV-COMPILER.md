# Compilador de Archipiélago Vivo TV

Este módulo mueve la resolución de parrilla fuera del navegador.

## Salidas públicas

- `/tv/feed.json`: export original.
- `/tv/schedule.json`: parrilla compilada con horizonte móvil de 7 días.
- `/tv/catalog-stats.json`: diagnóstico editorial por programa, canal y vídeo.
- `/tv/manifest.json`: versiones y URLs que consulta la TV.
- `/tv/catalogo/`: interfaz de revisión del catálogo.

## Diagnóstico editorial

Para cada programa y canal calcula:

- vídeos elegibles;
- horas únicas disponibles;
- horas programadas durante 7 días;
- uso medio diario;
- días estimados de cobertura;
- horas adicionales necesarias para alcanzar el objetivo de 7 días.

Para cada vídeo calcula:

- emisiones próximas 24 horas;
- emisiones próximas 7 días;
- horario exacto de cada emisión;
- canales en los que aparece;
- tiempo total emitido;
- separación media, mínima y máxima entre emisiones;
- datos editoriales y técnicos del feed.

Los vídeos se deduplican editorialmente por `youtube_id` dentro de cada programa.
Las emisiones se identifican mediante `airing_id`, de modo que un bloque global que
interrumpe un vídeo y luego lo reanuda no se contabiliza como dos reproducciones.

## Compilación manual

```bash
node scripts/compile-tv.js --input tv/feed.json --out tv
```

Variables opcionales:

```text
TV_SCHEDULE_DAYS=7
TV_TARGET_COVERAGE_DAYS=7
```
