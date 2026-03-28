# Notas de version

## Version 0.4.0

## Cambios destacados

- Refactor grande de arquitectura en background, popup, options y content script para mejorar mantenibilidad y preparacion open source.
- Contratos publicos versionados con ejemplos y validacion local para endpoints HTTP y eventos WebSocket.
- Cobertura de tests ampliada para runtime, orquestacion de jobs, content script y flujo paginado de destinatarios.
- Nuevo flujo paginado de destinatarios con busqueda, carga incremental y seleccion persistente sobre contrato real backend + frontend.
- `popup-store` saneado a estado serializable y eliminacion de `innerHTML` del codigo fuente principal.
- Confirmacion de envio real migrada de `confirm()` nativo a modal propio del popup.

## Artefactos

- `extension-v0.4.0.zip`
- `extension-v0.4.0.sha256`

## Verificacion de integridad

```bash
sha256sum -c extension-v0.4.0.sha256
```
