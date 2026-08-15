<p align="center">
  <a href="https://archipielagovivo.org/">
    <img src="https://archipielagovivo.org/logo.webp" alt="Archipiélago Vivo" width="180">
  </a>
</p>

<h1 align="center">Archipiélago Vivo · Data</h1>

<p align="center">
  Datos públicos estáticos de <a href="https://archipielagovivo.org/">Archipiélago Vivo</a>.
</p>

Este repositorio actúa como capa ligera entre la fuente de datos de Archipiélago Vivo y sus consumidores públicos, como el mapa, la TV y futuras aplicaciones.

## Principio

- La fuente de verdad permanece fuera de este repositorio.
- Aquí sólo se publican datos destinados a consumo público.
- Los consumidores deben leer estos archivos estáticos en lugar de consultar continuamente la API de origen.
- Los archivos se actualizan automáticamente cuando cambian los datos publicados.

## Estructura

```text
/
├── README.md
├── manifest.json
├── map/
└── tv/
