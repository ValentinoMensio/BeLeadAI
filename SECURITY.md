# Politica de seguridad

## Modelo de distribucion soportado

Este proyecto esta pensado para codigo fuente publico y operacion en infraestructura privada.

- El codigo puede ser publico.
- El uso en runtime debe apuntar a backend controlado por el operador.
- Nunca deben subirse credenciales al repositorio.

## Base de seguridad del frontend

- API base obligatoriamente por HTTPS.
- WebSocket solo por WSS.
- API key y access token se guardan en almacenamiento de sesion del navegador.
- El JWT no se envia por query string.
- Los permisos de host de API se conceden por dominio configurado.

## Requisitos minimos del backend (privado)

- Emitir access tokens de corta duracion.
- Exponer rutas de autenticacion y refresh necesarias para la extension.
- Exponer rutas de ticket de un solo uso para canales en tiempo real.
- Validar server-side el binding cuenta/sender.
- Aplicar rate limits y proteccion contra replay.

## Reporte de vulnerabilidades

Reporta problemas de seguridad de forma privada al maintainer u operador del despliegue.

Incluye, si es posible:

- Version de extension (`manifest.version`)
- Pasos de reproduccion
- Comportamiento esperado vs actual
- Impacto y datos afectados
