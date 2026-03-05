# BeLeadAI Enqueuer (Chrome MV3)

[![Version](https://img.shields.io/badge/version-0.3.0-1f6feb.svg)](../../releases)
[![Distribucion](https://img.shields.io/badge/distribucion-GitHub%20Releases-2ea043.svg)](../../releases)
[![Licencia](https://img.shields.io/badge/licencia-MIT-7f5af0.svg)](./LICENSE)

Extension de Chrome para operar flujos desde una UI simple, conectada a una API privada.

## Uso responsable

- Este repositorio publica solo el frontend de la extension.
- Cada usuario es responsable de cumplir los terminos y politicas de las plataformas que utilice.
- No uses este proyecto para actividad abusiva, enganiosa o no autorizada.

## Caracteristicas

- Configuracion de API base y API key desde `options.html`.
- Popup operativo para revisar estado y ejecutar acciones.
- Persistencia de configuracion en `chrome.storage`.
- Bloqueo guiado cuando la API exige actualizacion (`CLIENT_UPDATE_REQUIRED`).
- Distribucion por GitHub Releases con artefactos verificables.

## Instalacion (3 minutos)

1. Abre la pagina de `Releases` del repositorio.
2. Descarga `extension-vX.Y.Z.zip`.
3. Descomprime el archivo en una carpeta local.
4. En Chrome abre `chrome://extensions`.
5. Activa `Developer mode`.
6. Haz clic en `Load unpacked`.
7. Selecciona la carpeta descomprimida.

## Primera configuracion

Para crear una cuenta y solicitar credenciales de acceso, escribe a `beleadai.contact@gmail.com` o por Instagram en `https://www.instagram.com/beleadai.contact/`.

1. En `chrome://extensions`, abre `Details` de la extension.
2. Entra en `Extension options`.
3. Completa:
   - `API Base URL` (debe ser `https://...`)
   - `API Key`
4. Guarda y ejecuta la prueba de conexion.
5. Si responde `OK`, abre el popup y empieza a usarla.

## Tutorial rapido de uso

1. Instala la extension.
2. Configura API base y API key.
3. Valida conexion desde opciones.
4. Abre el popup y ejecuta el flujo que necesites.
5. Monitorea estado y resultados en tiempo real.
6. Si aparece bloqueo por version, actualiza y recarga.

## Como actualizar

1. Descarga la ultima `extension-vX.Y.Z.zip` en `Releases`.
2. Reemplaza la carpeta local de la extension por la nueva.
3. En `chrome://extensions`, pulsa `Reload`.

La configuracion se mantiene en `chrome.storage`, por lo que no deberias perder ajustes.

## Integridad de descarga

Cada release publica:

- `extension-vX.Y.Z.zip`
- `extension-vX.Y.Z.sha256`
- `RELEASE_NOTES.md`

Validacion local:

```bash
sha256sum -c extension-vX.Y.Z.sha256
```

## Solucion de problemas

- **No conecta con la API:** revisa URL `https://` y API key.
- **Sesion expirada:** reautentica desde opciones.
- **Bloqueo por version:** instala la ultima release y recarga.
- **Permisos host:** concede el dominio de API cuando Chrome lo solicite.

## Documentacion

- `SECURITY.md` - politica de seguridad.
- `SECURITY_NOTES.md` - notas operativas de seguridad.
- `PRIVACY.md` - aviso de privacidad.
- `RELEASE_CHECKLIST.md` - checklist de publicacion.
- `docs/PUBLICACION.md` - guia para publicar nuevas versiones.

## Para maintainers

```bash
npm ci
npm run lint
npm run format:check
npm run test
npm run pack:release
```

Salida esperada:

- `extension-vX.Y.Z.zip`
- `extension-vX.Y.Z.sha256`
