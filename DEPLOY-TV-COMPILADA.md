# Despliegue de la parrilla compilada

## 1. Repo `ArchipielagoVivo/data`

Copiar conservando rutas:

- `.github/workflows/update-public-data.yml`
- `scripts/compile-tv.js`
- `scripts/lib/tv-engine.js`
- `tv/catalogo/index.html`
- `tv/catalogo/styles.css`
- `tv/catalogo/app.js`

Después ejecutar manualmente el workflow **Update public data**.

Debe publicar:

- `https://data.archipielagovivo.org/tv/feed.json`
- `https://data.archipielagovivo.org/tv/schedule.json`
- `https://data.archipielagovivo.org/tv/catalog-stats.json`
- `https://data.archipielagovivo.org/tv/manifest.json`
- `https://data.archipielagovivo.org/tv/catalogo/`

No desplegar todavía el runtime nuevo de TV hasta comprobar que los tres JSON compilados responden correctamente.

## 2. Repo `ArchipielagoVivo/tv`

Después sustituir el runtime por el segundo paquete.

La TV consultará `tv/manifest.json` en `data` cada cinco minutos y sólo volverá a descargar `schedule.json` cuando cambie `schedule_version`.

## 3. Comprobaciones

### Canal 4 alrededor de las 08:00

El dashboard/JSON debe reflejar:

- `00:00–08:00 Archivo`
- frontera de programa `08:00 Memoria indígena`
- si existe bloque global a las 08:00, éste aparece por separado;
- el primer vídeo de `Memoria indígena` puede comenzar al terminar ese bloque global, sin perderse la frontera de las 08:00.

### Debug

Con `?debug=1&nostats=1`, la hora del log debe ser hora canaria y el heartbeat debe identificar `Memoria indígena` como siguiente programa a las 08:00, no saltar a las 13:00.
