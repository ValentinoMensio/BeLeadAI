# Notas de seguridad

Este repositorio publico omite detalles internos de implementacion del backend.

## Requisitos de backend (alto nivel)

- Exponer rutas autenticadas necesarias para el runtime de la extension.
- Usar access tokens de corta duracion y rotacion segura.
- Usar credenciales o tickets de un solo uso para tiempo real.
- Aplicar autorizacion server-side, proteccion contra replay y rate limits.

## Requisitos de transporte

- La URL base de API debe usar HTTPS.
- Las conexiones WebSocket deben usar WSS.

## Hardening operativo

- Rotar API keys periodicamente.
- Mantener JWT de corta vida y renovacion controlada por backend.
- Auditar resultados de envio server-side (`task_id`, binding de cuenta y guardas anti replay).

## Recomendaciones de distribucion

- Distribuir solo artefactos generados por `npm run pack:release`.
- No distribuir `node_modules/`, tests, capturas de debug ni archivos `.env` locales.
