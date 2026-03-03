# Checklist de release (GitHub Releases)

## Preflight

- [ ] `npm ci` finaliza sin errores.
- [ ] `npm run lint` revisado (sin errores bloqueantes).
- [ ] `npm run format:check` aprobado.
- [ ] `npm run test` aprobado.
- [ ] `npm run pack:release` genera artefactos versionados.

## Seguridad

- [ ] No hay API keys/JWT reales en repo (`src`, docs, manifests, workflows).
- [ ] Los archivos `.env` estan ignorados; solo existe `.env.example` en versionado.
- [ ] `manifest.json` no usa `<all_urls>`.
- [ ] API base y WebSocket se usan solo por HTTPS/WSS.
- [ ] Los logs de consola no exponen mensajes completos ni listas completas de destinatarios.

## Permisos

- [ ] `permissions` se mantiene minimo (`storage`, `alarms`, `tabs`, `cookies`).
- [ ] `host_permissions` esta limitado a Instagram.
- [ ] Permisos host opcionales se usan solo para el dominio API configurado.

## Integridad del paquete

- [ ] `extension-vX.Y.Z.zip` contiene solo archivos runtime de la extension.
- [ ] `extension-vX.Y.Z.zip` excluye `node_modules/`, archivos locales y debug.
- [ ] `extension-vX.Y.Z.sha256` se genera y se publica.
- [ ] `RELEASE_NOTES.md` esta actualizado y adjunto al release.
- [ ] `manifest.version` coincide con las notas del release.

## Documentacion

- [ ] `README.md` incluye instalacion, configuracion, tutorial simple y actualizacion.
- [ ] `PRIVACY.md` refleja el manejo actual de datos.
- [ ] `SECURITY.md` y `SECURITY_NOTES.md` estan presentes.
- [ ] Ninguna doc publica incluye detalles internos sensibles del backend.
