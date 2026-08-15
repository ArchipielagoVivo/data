# Archipiélago Vivo · Data

Repositorio de datos públicos estáticos de Archipiélago Vivo.

Este repositorio actúa como capa ligera entre la fuente de datos de Archipiélago Vivo y sus consumidores públicos, como el mapa, la TV y futuras aplicaciones.

## Principio

- La fuente de verdad permanece fuera de este repositorio.
- Aquí sólo se publican datos destinados a consumo público.
- Los consumidores deben leer estos archivos estáticos en lugar de consultar continuamente la API de origen.
- Los archivos podrán actualizarse automáticamente cuando cambien los datos.

## Estructura inicial

```text
/
├── README.md
├── manifest.json
├── map/
└── tv/
```

Los directorios `map/` y `tv/` se completarán con los feeds públicos correspondientes.
