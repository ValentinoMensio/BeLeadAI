# Notas de version

## Cambios destacados

- Endurecimiento del repositorio publico y mejoras del pipeline de release.
- Inclusion de metadata de version del cliente en requests API (`X-Client-Version`, `X-Client-Platform`, `X-Client-Build`).
- Empaquetado reproducible con zip versionado y checksum SHA-256.
- Pantalla de bloqueo en frontend cuando la API responde `CLIENT_UPDATE_REQUIRED`.

## Artefactos

- `extension-v0.3.0.zip`
- `extension-v0.3.0.sha256`

## Verificacion de integridad

```bash
sha256sum -c extension-v0.3.0.sha256
```
