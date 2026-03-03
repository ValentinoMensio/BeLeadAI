# Registro de cambios

## 0.3.0

- Se agregaron assets para publicacion profesional (`LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, templates y workflows de GitHub).
- Se cambio el empaquetado a artefactos versionados (`extension-vX.Y.Z.zip` + `extension-vX.Y.Z.sha256`).
- Se agregaron headers de metadata de cliente en requests API (`X-Client-Version`, `X-Client-Platform`, `X-Client-Build`).
- Se agrego pantalla de bloqueo por actualizacion obligatoria en popup y options.

## 0.2.3

- Se reforzo el manifiesto para entrega segura (HTTPS en content script y CSP explicita para MV3).
- Se agrego documentacion de release (`SECURITY.md`, `RELEASE_CHECKLIST.md`, ejemplos de env/config).
- Se redujo logging sensible en runtime (enmascarado de identidades y sin previews completas de destinatarios).

## 0.2.2

- Se reforzaron permisos de extension y acceso por host por defecto.
- Se forzo uso de HTTPS para API base y WSS para WebSocket.
- API key y access JWT pasaron a persistencia en `chrome.storage.session`.
- Se agrego opcion "mantener sesion iniciada" usando cookies seguras del backend (`HttpOnly`).
- Se agregaron acciones "logout current device" y "logout all devices" en opciones.
- Se removio la ruta de input por portapapeles y su permiso asociado.
- Se agrego documentacion de distribucion privada (`PRIVACY.md`, `SECURITY_NOTES.md`) y script de build de release.
