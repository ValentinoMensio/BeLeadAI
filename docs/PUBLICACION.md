# Guia de publicacion

Esta guia describe el flujo recomendado para publicar una nueva version en GitHub Releases.

## 1) Preflight local

```bash
npm ci
npm run lint
npm run format:check
npm run test
```

## 2) Generar artefactos de release

```bash
npm run pack:release
```

Esto genera:

- `extension-vX.Y.Z.zip`
- `extension-vX.Y.Z.sha256`

## 3) Validar integridad local

```bash
sha256sum -c extension-vX.Y.Z.sha256
```

## 4) Actualizar notas de version

- Edita `RELEASE_NOTES.md` con highlights reales de la version.
- Verifica que `manifest.json` y `package.json` tengan la misma version.

## 5) Publicar tag y release

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z

gh release create vX.Y.Z \
  extension-vX.Y.Z.zip \
  extension-vX.Y.Z.sha256 \
  RELEASE_NOTES.md \
  --notes-file RELEASE_NOTES.md
```

## 6) Verificacion post-release

- Descarga los artefactos desde GitHub.
- Vuelve a validar el checksum.
- Prueba instalacion limpia en `chrome://extensions` usando `Load unpacked`.
